import type { DesignReviewLogEntry, DesignReviewLogEvent } from "./types";
import type { Translations } from "../../../i18n";

const MAX_LOG_MESSAGE_LENGTH = 500;

export function sanitizeDesignReviewLogText(value: unknown): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /\b(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, MAX_LOG_MESSAGE_LENGTH);
}

export function createDesignReviewLogEntry(
  event: DesignReviewLogEvent,
  message: unknown,
  options: Pick<DesignReviewLogEntry, "level" | "toolName" | "count"> & {
    at?: number;
  } = { level: "info" },
): DesignReviewLogEntry {
  const at = options.at ?? Date.now();
  return {
    id:
      globalThis.crypto?.randomUUID?.() ??
      `review-log-${at}-${Math.random().toString(36).slice(2)}`,
    at,
    level: options.level,
    event,
    message: sanitizeDesignReviewLogText(message),
    ...(options.toolName ? { toolName: options.toolName } : {}),
    ...(options.count !== undefined ? { count: options.count } : {}),
  };
}

function interpolateLog(
  template: string,
  replacements: Record<string, string | number>,
): string {
  return Object.entries(replacements).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

/** Format persisted structured events with the currently selected locale. */
export function formatDesignReviewLogEntry(
  entry: DesignReviewLogEntry,
  t: Translations,
  runtime: "api" | "local" = "api",
): string {
  const messages = t.designReview.logs;
  const count = entry.count ?? 0;

  switch (entry.event) {
    case "capture_complete":
      return entry.count === undefined
        ? messages.captureWarning
        : interpolateLog(messages.captureComplete, { count });
    case "queued":
      return messages.queued;
    case "runtime_started":
      return interpolateLog(messages.runtimeStarted, {
        runtime:
          runtime === "local" ? messages.runtimeLocal : messages.runtimeApi,
      });
    case "fixing":
      return messages.fixing;
    case "verifying":
      return messages.verifying;
    case "retry":
      return entry.count === undefined
        ? messages.retryQueued
        : interpolateLog(messages.providerRetry, { count });
    case "tool_call":
      return interpolateLog(messages.toolCall, {
        tool: entry.toolName ?? "tool",
        count,
      });
    case "report_received":
      return interpolateLog(messages.reportReceived, { count });
    case "completed":
      return interpolateLog(messages.completed, { count });
    case "cancelled":
      return messages.cancelled;
    case "failed":
      return messages.failed;
    case "interrupted":
      return messages.interrupted;
    case "stale":
      return messages.stale;
    default:
      return entry.message;
  }
}
