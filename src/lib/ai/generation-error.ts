import type {
  StructuredGenerationError,
  StructuredGenerationErrorKind,
} from "./generator-types";
import type { Translations } from "../../i18n";

const KIND_PATTERNS: Array<{
  kind: StructuredGenerationErrorKind;
  retryable: boolean;
  pattern: RegExp;
}> = [
  {
    kind: "context_length",
    retryable: true,
    pattern: /context_length_exceeded|context length|maximum context/i,
  },
  {
    kind: "auth",
    retryable: false,
    pattern: /api key|unauthorized|forbidden|invalid key|permission/i,
  },
  {
    kind: "network",
    retryable: true,
    pattern: /network|fetch|timeout|timed out|failed to fetch/i,
  },
  {
    kind: "tool",
    retryable: true,
    pattern: /tool|invalid arguments|schema|tool call/i,
  },
  {
    kind: "runtime_check",
    retryable: true,
    pattern: /automatic qa|runtime check|health check|project_health_check/i,
  },
];

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "Unknown error";
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Unknown error";
}

export function getGenerationErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as { statusCode?: unknown; status?: unknown };
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  return typeof candidate.status === "number" ? candidate.status : undefined;
}

function getExplicitRetryable(err: unknown): boolean | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as { isRetryable?: unknown; retryable?: unknown };
  if (typeof candidate.isRetryable === "boolean") {
    return candidate.isRetryable;
  }
  return typeof candidate.retryable === "boolean"
    ? candidate.retryable
    : undefined;
}

function retryableFromMetadata(
  err: unknown,
  status: number | undefined,
): boolean | undefined {
  if (
    err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  ) {
    return false;
  }
  if (status === 401 || status === 403) return false;

  const explicit = getExplicitRetryable(err);
  if (explicit !== undefined) return explicit;
  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status ?? 0) >= 500
  ) {
    return true;
  }
  if (status !== undefined && status >= 400 && status < 500) return false;
  return undefined;
}

export function classifyGenerationError(
  err: unknown,
): StructuredGenerationError {
  const message = getErrorMessage(err);
  const status = getGenerationErrorStatus(err);
  const metadataRetryable = retryableFromMetadata(err, status);

  if (
    err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  ) {
    return { kind: "aborted", message, retryable: false, status };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", message, retryable: false, status };
  }
  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  ) {
    return {
      kind: "model",
      message,
      retryable: metadataRetryable ?? true,
      status,
    };
  }

  for (const candidate of KIND_PATTERNS) {
    if (candidate.pattern.test(message)) {
      return {
        kind: candidate.kind,
        message,
        retryable:
          candidate.kind === "auth"
            ? false
            : (metadataRetryable ?? candidate.retryable),
        status,
      };
    }
  }

  return {
    kind: "unknown",
    message,
    retryable: metadataRetryable ?? true,
    status,
  };
}

export function isRetryableGenerationError(err: unknown): boolean {
  return classifyGenerationError(err).retryable;
}

export function formatGenerationErrorMessage(
  error: StructuredGenerationError,
  t: Translations,
): string {
  const label = t.message.generationError.kinds[error.kind];
  const action = t.message.generationError.actions[error.kind];
  const status = error.status
    ? `\n\n${t.message.generationError.status.replace("{status}", String(error.status))}`
    : "";
  const retryHint = error.retryable
    ? `\n\n${t.message.generationError.retryable}`
    : "";

  return [
    `⚠️ **${label}**`,
    action,
    `${t.message.generationError.detail}\n\n\`${error.message}\`${status}${retryHint}`,
  ].join("\n\n");
}
