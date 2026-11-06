// Ephemeral: not persisted. UI replays from the SubagentToolResult JSON in
// conversation messages once a run completes.

import { create } from "zustand";
import type {
  SubagentEvent,
  SubagentLiveActivity,
  SubagentLiveActivityKind,
  SubagentProgress,
  SubagentStatus,
} from "../lib/ai/subagents/types";
import {
  SUBAGENT_LIMITS,
  truncateSubagentText,
} from "../lib/ai/subagents/limits";

interface SubagentStoreState {
  progress: Record<string, SubagentProgress>;

  init: (toolCallId: string, subagent: string, task: string) => string;
  appendText: (toolCallId: string, delta: string, runId?: string) => void;
  appendThinking: (toolCallId: string, delta: string, runId?: string) => void;
  recordActivity: (
    toolCallId: string,
    kind: SubagentLiveActivityKind,
    text: string,
    activityToolCallId?: string,
    runId?: string,
  ) => void;
  recordRetry: (
    toolCallId: string,
    attempt: number,
    maxAttempts: number,
    message: string,
    runId?: string,
  ) => void;
  setFinalText: (toolCallId: string, text: string, runId?: string) => void;
  addToolCall: (
    toolCallId: string,
    name: string,
    innerId: string,
    runId?: string,
  ) => void;
  setToolResult: (
    toolCallId: string,
    innerId: string,
    preview: string,
    output?: SubagentEvent["toolOutput"],
    status?: SubagentEvent["status"],
    runId?: string,
  ) => void;
  markStatus: (
    toolCallId: string,
    status: SubagentStatus,
    error?: string,
    runId?: string,
  ) => void;
  clear: (toolCallId: string) => void;
}

function appendEphemeralText(current: string, delta: string): string {
  return current + delta;
}

function appendActivity(
  current: SubagentLiveActivity[],
  kind: SubagentLiveActivityKind,
  text: string,
  toolCallId?: string,
  retry?: { attempt: number; maxAttempts: number },
): SubagentLiveActivity[] {
  const timestamp = Date.now();
  const last = current.at(-1);
  if (
    last &&
    (kind === "output" || kind === "thinking") &&
    last.kind === kind &&
    last.toolCallId === toolCallId &&
    timestamp - last.timestamp < 500
  ) {
    const merged = `${last.text}${text}`;
    return [
      ...current.slice(0, -1),
      {
        ...last,
        text: merged,
        timestamp,
        retry,
      },
    ];
  }
  return [...current, { kind, text, timestamp, toolCallId, retry }];
}

export const useSubagentStore = create<SubagentStoreState>((set) => ({
  progress: {},

  init: (toolCallId, subagent, task) => {
    const runId = `${toolCallId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now();
    set((s) => ({
      progress: {
        ...s.progress,
        [toolCallId]: {
          subagent,
          task: truncateSubagentText(task, SUBAGENT_LIMITS.maxTaskChars),
          status: "running",
          text: "",
          events: [],
          activities: [],
          runId,
          lastUpdatedAt: startedAt,
          startedAt,
        },
      },
    }));
    return runId;
  },

  appendText: (toolCallId, delta, runId) =>
    set((s) => {
      const cur = s.progress[toolCallId];
      if (!cur || cur.status !== "running" || (runId && cur.runId !== runId))
        return s;
      return {
        progress: {
          ...s.progress,
          [toolCallId]: {
            ...cur,
            text: appendEphemeralText(cur.text, delta),
            activities: appendActivity(cur.activities, "output", delta),
            lastUpdatedAt: Date.now(),
          },
        },
      };
    }),

  appendThinking: (toolCallId, delta, runId) =>
    set((s) => {
      const cur = s.progress[toolCallId];
      if (!cur || cur.status !== "running" || (runId && cur.runId !== runId))
        return s;
      return {
        progress: {
          ...s.progress,
          [toolCallId]: {
            ...cur,
            activities: appendActivity(cur.activities, "thinking", delta),
            lastUpdatedAt: Date.now(),
          },
        },
      };
    }),

  recordActivity: (toolCallId, kind, text, activityToolCallId, runId) =>
    set((s) => {
      const cur = s.progress[toolCallId];
      if (!cur || cur.status !== "running" || (runId && cur.runId !== runId))
        return s;
      return {
        progress: {
          ...s.progress,
          [toolCallId]: {
            ...cur,
            activities: appendActivity(
              cur.activities,
              kind,
              text,
              activityToolCallId,
            ),
            lastUpdatedAt: Date.now(),
          },
        },
      };
    }),

  recordRetry: (toolCallId, attempt, maxAttempts, message, runId) =>
    set((s) => {
      const cur = s.progress[toolCallId];
      if (!cur || cur.status !== "running" || (runId && cur.runId !== runId))
        return s;
      return {
        progress: {
          ...s.progress,
          [toolCallId]: {
            ...cur,
            activities: appendActivity(
              cur.activities,
              "retry",
              message,
              undefined,
              { attempt, maxAttempts },
            ),
            lastUpdatedAt: Date.now(),
          },
        },
      };
    }),

  setFinalText: (toolCallId, text, runId) =>
    set((s) => {
      const cur = s.progress[toolCallId];
      if (!cur || cur.status !== "running" || (runId && cur.runId !== runId))
        return s;
      const streamedText = cur.activities
        .filter((activity) => activity.kind === "output")
        .map((activity) => activity.text)
        .join("");
      const activities =
        streamedText === text
          ? cur.activities
          : [
              ...cur.activities.filter(
                (activity) => activity.kind !== "output",
              ),
              ...(text
                ? [
                    {
                      kind: "output" as const,
                      text,
                      timestamp: Date.now(),
                    },
                  ]
                : []),
            ];
      return {
        progress: {
          ...s.progress,
          [toolCallId]: {
            ...cur,
            text: appendEphemeralText("", text),
            activities,
            lastUpdatedAt: Date.now(),
          },
        },
      };
    }),

  addToolCall: (toolCallId, name, innerId, runId) =>
    set((s) => {
      const cur = s.progress[toolCallId];
      if (!cur || cur.status !== "running" || (runId && cur.runId !== runId))
        return s;
      if (cur.events.some((e) => e.toolCallId === innerId)) return s;
      const event: SubagentEvent = {
        name,
        toolCallId: innerId,
        resultPreview: "",
        status: "running",
        startedAt: Date.now(),
      };
      const activities = appendActivity(cur.activities, "tool", name, innerId);
      return {
        progress: {
          ...s.progress,
          [toolCallId]: {
            ...cur,
            events: [...cur.events, event],
            activities,
            lastUpdatedAt: Date.now(),
          },
        },
      };
    }),

  setToolResult: (toolCallId, innerId, preview, output, status, runId) =>
    set((s) => {
      const cur = s.progress[toolCallId];
      if (!cur || cur.status !== "running" || (runId && cur.runId !== runId))
        return s;
      const idx = cur.events.findIndex((e) => e.toolCallId === innerId);
      if (idx === -1) return s;
      const events = cur.events.slice();
      events[idx] = {
        ...events[idx],
        status:
          status ??
          (output?.isError === true ||
          (output?.isError === undefined && preview.startsWith("Error"))
            ? "failed"
            : "completed"),
        finishedAt: Date.now(),
        toolOutput: {
          text: truncateSubagentText(
            output?.text ?? preview,
            SUBAGENT_LIMITS.maxToolPreviewChars,
          ),
          isError: output?.isError,
        },
        resultPreview: truncateSubagentText(
          preview,
          SUBAGENT_LIMITS.maxToolPreviewChars,
        ),
      };
      const activities = appendActivity(
        cur.activities,
        "tool-result",
        preview || "Tool completed.",
        innerId,
      );
      return {
        progress: {
          ...s.progress,
          [toolCallId]: {
            ...cur,
            events,
            activities,
            lastUpdatedAt: Date.now(),
          },
        },
      };
    }),

  markStatus: (toolCallId, status, error, runId) =>
    set((s) => {
      const cur = s.progress[toolCallId];
      if (!cur || cur.status !== "running" || (runId && cur.runId !== runId))
        return s;
      return {
        progress: {
          ...s.progress,
          [toolCallId]: {
            ...cur,
            status,
            events: cur.events.map((event) =>
              event.status === "running" || !event.status
                ? {
                    ...event,
                    status:
                      status === "done"
                        ? "completed"
                        : status === "running"
                          ? "running"
                          : status,
                    finishedAt: status === "running" ? undefined : Date.now(),
                  }
                : event,
            ),
            error:
              error == null
                ? undefined
                : truncateSubagentText(error, SUBAGENT_LIMITS.maxErrorChars),
            finishedAt: Date.now(),
            lastUpdatedAt: Date.now(),
          },
        },
      };
    }),

  clear: (toolCallId) =>
    set((s) => {
      if (!(toolCallId in s.progress)) return s;
      const next = { ...s.progress };
      delete next[toolCallId];
      return { progress: next };
    }),
}));
