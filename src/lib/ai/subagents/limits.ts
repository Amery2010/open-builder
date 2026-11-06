import type {
  SubagentEvent,
  SubagentStatus,
  SubagentToolStatus,
} from "./types";

export const SUBAGENT_LIMITS = {
  maxTaskChars: 4_000,
  maxLiveTextChars: 8_000,
  maxEvents: 40,
  maxToolPreviewChars: 1_000,
  maxErrorChars: 1_000,
} as const;

export function normalizeSubagentTask(
  value: unknown,
): { ok: true; task: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "task must be a string" };
  }
  const task = value.trim();
  if (!task) return { ok: false, error: "task must not be empty" };
  if (task.length > SUBAGENT_LIMITS.maxTaskChars) {
    return {
      ok: false,
      error: `task is too long (max ${SUBAGENT_LIMITS.maxTaskChars} characters)`,
    };
  }
  return { ok: true, task };
}

export function truncateSubagentText(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

export function limitSubagentEvents(events: SubagentEvent[]): SubagentEvent[] {
  return events.slice(0, SUBAGENT_LIMITS.maxEvents).map((event) => ({
    ...event,
    toolOutput: event.toolOutput
      ? {
          text: truncateSubagentText(
            event.toolOutput.text,
            SUBAGENT_LIMITS.maxToolPreviewChars,
          ),
          isError: event.toolOutput.isError,
        }
      : undefined,
    resultPreview: truncateSubagentText(
      event.resultPreview,
      SUBAGENT_LIMITS.maxToolPreviewChars,
    ),
  }));
}

/** Old history has no explicit lifecycle. A terminal parent must not leave
 * an empty child tool looking permanently active. */
export function subagentEventStatus(
  event: SubagentEvent,
  parent: SubagentStatus,
): SubagentToolStatus {
  if (event.status && event.status !== "running") return event.status;
  if (event.toolOutput?.isError || event.resultPreview.startsWith("Error"))
    return "failed";
  if (!event.status && (event.toolOutput || event.resultPreview))
    return "completed";
  if (parent === "done") return "completed";
  return parent === "running" ? "running" : parent;
}
