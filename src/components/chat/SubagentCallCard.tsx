import { useMemo, useState, useEffect, useId, useRef, memo } from "react";
import { ChevronRight, Bot, Check, X, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { LazyMarkdownContent } from "./LazyMarkdownContent";
import { ToolCallCard } from "./ToolCallCard";
import { AgnesMediaResult } from "./AgnesMediaResult";
import { useT } from "../../i18n";
import { useSubagentStore } from "../../store/subagent";
import { getSubagentByName } from "../../lib/ai/subagents/registry";
import {
  SUBAGENT_LIMITS,
  limitSubagentEvents,
  truncateSubagentText,
  subagentEventStatus,
} from "../../lib/ai/subagents/limits";
import type {
  SubagentEvent,
  SubagentLiveActivity,
  SubagentStatus,
  SubagentToolResult,
} from "../../lib/ai/subagents/types";
import type { ToolBlock } from "../../types";
import { agnesToolNameFromAlias } from "../../lib/mcp/agnes/aliases";
import { CANCELLED_TOOL_OUTPUT_KIND } from "../../lib/ai/run-guard";

type SubagentCardData = {
  subagent: string;
  task: string;
  status: SubagentStatus;
  text: string;
  events: SubagentEvent[];
  activities: SubagentLiveActivity[];
  durationMs?: number;
  error?: string;
};

function parsePersisted(result: string): SubagentCardData | null {
  if (!result) return null;
  try {
    const data = JSON.parse(result) as SubagentToolResult;
    if (
      typeof data !== "object" ||
      !data ||
      typeof data.subagent !== "string"
    ) {
      return null;
    }
    const events = Array.isArray(data.events)
      ? limitSubagentEvents(data.events)
      : [];
    const text = truncateSubagentText(
      data.text ?? "",
      SUBAGENT_LIMITS.maxLiveTextChars,
    );
    return {
      subagent: data.subagent,
      task: truncateSubagentText(data.task ?? "", SUBAGENT_LIMITS.maxTaskChars),
      status: data.status ?? (data.ok ? "done" : "failed"),
      text,
      events,
      activities: [
        ...events.map((event, index) => ({
          kind: "tool" as const,
          text: event.name,
          timestamp: event.startedAt ?? index,
          toolCallId: event.toolCallId,
        })),
        ...(text
          ? [
              {
                kind: "output" as const,
                text,
                timestamp:
                  (events.at(-1)?.finishedAt ?? events.at(-1)?.startedAt ?? 0) +
                  1,
              },
            ]
          : []),
      ],
      durationMs: data.durationMs,
      error:
        data.error == null
          ? undefined
          : truncateSubagentText(data.error, SUBAGENT_LIMITS.maxErrorChars),
    };
  } catch {
    return null;
  }
}

const STATUS_STYLES: Record<
  SubagentStatus,
  { textKey: "running" | "done" | "aborted" | "failed"; className: string }
> = {
  running: {
    textKey: "running",
    className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  },
  done: {
    textKey: "done",
    className: "bg-green-500/15 text-green-700 dark:text-green-400",
  },
  aborted: {
    textKey: "aborted",
    className: "bg-muted text-muted-foreground",
  },
  failed: {
    textKey: "failed",
    className: "bg-red-500/15 text-red-700 dark:text-red-400",
  },
};

function StatusBadge({
  status,
  t,
}: {
  status: SubagentStatus;
  t: ReturnType<typeof useT>;
}) {
  const { textKey, className } = STATUS_STYLES[status];
  return (
    <Badge
      variant="secondary"
      className={cn("text-xs font-mono h-5 border-0", className)}
    >
      {status === "running" && (
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse mr-1" />
      )}
      {status === "done" && <Check size={12} aria-hidden="true" />}
      {status === "failed" && <X size={12} aria-hidden="true" />}
      {status === "aborted" && <Square size={12} aria-hidden="true" />}
      {t.subagent[textKey]}
    </Badge>
  );
}

type SubagentCallCardProps = Omit<ToolBlock, "type" | "id">;

export const SubagentCallCard = memo(function SubagentCallCard({
  toolCallId,
  rawArgs,
  result,
  toolOutput,
}: SubagentCallCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const [now, setNow] = useState(Date.now);
  const timelineRef = useRef<HTMLDivElement>(null);
  const followTimelineRef = useRef(true);
  const followFrameRef = useRef<number | undefined>(undefined);

  const live = useSubagentStore((s) => s.progress[toolCallId]);
  const persisted = useMemo(() => parsePersisted(result), [result]);
  const structured = toolOutput?.structuredContent;
  const cancelled = Boolean(
    structured &&
    typeof structured === "object" &&
    "kind" in structured &&
    structured.kind === CANCELLED_TOOL_OUTPUT_KIND,
  );
  const persistedError = useMemo(() => {
    const resultText = result.trim();
    if (toolOutput?.isError) {
      return truncateSubagentText(
        toolOutput.text.trim() || persisted?.error || resultText,
        SUBAGENT_LIMITS.maxErrorChars,
      );
    }
    if (!toolOutput && resultText.startsWith("Error") && !persisted) {
      return truncateSubagentText(resultText, SUBAGENT_LIMITS.maxErrorChars);
    }
    return undefined;
  }, [persisted, result, toolOutput]);

  const data: SubagentCardData = useMemo(() => {
    let base: SubagentCardData;
    if (live) {
      base = {
        subagent: live.subagent,
        task: live.task,
        status: live.status,
        text: live.text,
        events: live.events,
        activities: live.activities,
        durationMs:
          live.finishedAt != null
            ? live.finishedAt - live.startedAt
            : undefined,
        error: live.error,
      };
    } else if (persisted) {
      base = persisted;
    } else {
      const fallbackName =
        typeof rawArgs?.subagent === "string" ? rawArgs.subagent : "subagent";
      const fallbackTask =
        typeof rawArgs?.task === "string" ? rawArgs.task : "";
      base = {
        subagent: fallbackName,
        task: fallbackTask,
        status: result ? "done" : "running",
        text: persistedError
          ? ""
          : truncateSubagentText(result, SUBAGENT_LIMITS.maxLiveTextChars),
        events: [],
        activities: [],
      };
    }
    if (cancelled) return { ...base, status: "aborted", error: undefined };
    return persistedError
      ? { ...base, status: "failed", error: persistedError }
      : base;
  }, [cancelled, live, persisted, persistedError, rawArgs, result]);

  const displayName =
    t.subagent.names[data.subagent as keyof typeof t.subagent.names] ??
    data.subagent;
  const def = getSubagentByName(data.subagent);
  const writePolicy = def?.writePolicy ?? "readonly";
  useEffect(() => {
    if (data.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [data.status]);
  const durationMs =
    data.durationMs ?? (live ? Math.max(0, now - live.startedAt) : undefined);
  const durationLabel =
    durationMs != null
      ? t.subagent.duration.replace("{n}", (durationMs / 1000).toFixed(1))
      : "";
  const latestEvent = data.events.at(-1);
  const latestActivity = data.activities.at(-1);
  const eventsById = useMemo(
    () => new Map(data.events.map((event) => [event.toolCallId, event])),
    [data.events],
  );
  const formatActivityText = (activity: SubagentLiveActivity): string => {
    if (activity.kind !== "retry" || !activity.retry) return activity.text;
    return t.subagent.retrying
      .replace("{attempt}", String(activity.retry.attempt))
      .replace("{maxAttempts}", String(activity.retry.maxAttempts))
      .replace("{message}", activity.text);
  };
  const latestLabel = (
    (latestActivity && formatActivityText(latestActivity)) ||
    (latestEvent
      ? (t.tool.names[latestEvent.name as keyof typeof t.tool.names] ??
        latestEvent.name)
      : "") ||
    (data.status === "running" ? t.subagent.waitingForUpdate : "")
  ).slice(-160);
  const lastUpdatedLabel = live
    ? t.subagent.updatedAgo.replace(
        "{n}",
        (Math.max(0, now - live.lastUpdatedAt) / 1000).toFixed(1),
      )
    : "";

  useEffect(() => {
    if (!expanded) return;
    followTimelineRef.current = true;
  }, [expanded]);

  useEffect(() => {
    if (!expanded || !followTimelineRef.current) return;
    if (followFrameRef.current !== undefined) {
      cancelAnimationFrame(followFrameRef.current);
    }
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = undefined;
      const timeline = timelineRef.current;
      if (timeline) timeline.scrollTop = timeline.scrollHeight;
    });
    return () => {
      if (followFrameRef.current !== undefined) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = undefined;
      }
    };
  }, [data.activities, data.text, expanded]);

  const handleTimelineScroll = () => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    followTimelineRef.current =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= 24;
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="overflow-hidden rounded-xl border border-violet-300/60 bg-violet-50/60 dark:border-violet-400/30 dark:bg-violet-500/5"
    >
      <CollapsibleTrigger asChild>
        <button
          className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-violet-100/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 dark:hover:bg-violet-500/10"
          type="button"
          aria-controls={contentId}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
            <Bot size={18} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 space-y-2">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">
                {displayName}
              </span>
              <StatusBadge status={data.status} t={t} />
              <Badge
                variant="outline"
                className="h-5 border-violet-300/50 px-1.5 text-xs text-muted-foreground dark:border-violet-400/30"
              >
                {writePolicy === "fullWrite"
                  ? t.subagent.policyFullWrite
                  : t.subagent.policyReadonly}
              </Badge>
            </span>
            {data.task && (
              <span className="line-clamp-2 break-words text-xs leading-relaxed text-foreground/80">
                {data.task}
              </span>
            )}
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {latestLabel && (
                <span
                  className="min-w-0 truncate"
                  title={`${t.subagent.latestActivity}: ${latestLabel}`}
                >
                  {latestLabel}
                </span>
              )}
              <span>
                {data.events.length} {t.subagent.toolCalls}
              </span>
              {durationLabel && (
                <span className="font-mono tabular-nums">{durationLabel}</span>
              )}
              {lastUpdatedLabel && (
                <span
                  data-testid="subagent-last-updated"
                  className="font-mono tabular-nums"
                  title={t.subagent.latestActivity}
                >
                  {lastUpdatedLabel}
                </span>
              )}
            </span>
          </span>
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={cn(
              "mt-1 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent id={contentId}>
        <div className="space-y-3 border-t border-violet-300/40 bg-background/50 px-3 py-3 dark:border-violet-400/20">
          {data.activities.length > 0 ? (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {t.subagent.output}
              </p>
              <div
                ref={timelineRef}
                data-testid="subagent-activity-list"
                onScroll={handleTimelineScroll}
                className="max-h-96 space-y-1.5 overflow-y-auto text-xs text-muted-foreground"
              >
                {data.activities.map((activity, index) => {
                  if (activity.kind === "tool-result") return null;
                  if (activity.kind === "tool") {
                    const event = activity.toolCallId
                      ? eventsById.get(activity.toolCallId)
                      : undefined;
                    if (!event) return null;
                    if (
                      agnesToolNameFromAlias(event.name) &&
                      (event.resultPreview ||
                        subagentEventStatus(event, data.status) === "running")
                    ) {
                      return (
                        <div
                          key={`${activity.timestamp}-${index}`}
                          style={{
                            contentVisibility: "auto",
                            containIntrinsicSize: "0 52px",
                          }}
                        >
                          <AgnesMediaResult
                            block={{
                              type: "tool",
                              id: `subagent-tool-${event.toolCallId}`,
                              toolName: event.name,
                              title: event.name,
                              path: "",
                              result: event.resultPreview,
                              toolCallId: event.toolCallId,
                            }}
                          />
                        </div>
                      );
                    }
                    return (
                      <div
                        key={`${activity.timestamp}-${index}`}
                        style={{
                          contentVisibility: "auto",
                          containIntrinsicSize: "0 52px",
                        }}
                      >
                        <ToolCallCard
                          toolName={event.name}
                          title={
                            t.tool.names[
                              event.name as keyof typeof t.tool.names
                            ] ?? event.name
                          }
                          path=""
                          result={event.resultPreview}
                          toolCallId={event.toolCallId}
                          toolOutput={event.toolOutput}
                          status={subagentEventStatus(event, data.status)}
                        />
                      </div>
                    );
                  }
                  const text = formatActivityText(activity);
                  return (
                    <div
                      key={`${activity.timestamp}-${index}`}
                      className="rounded-md border border-border/40 bg-muted/20 px-2 py-1.5 whitespace-pre-wrap"
                      style={{
                        contentVisibility: "auto",
                        containIntrinsicSize: "0 32px",
                      }}
                    >
                      {activity.kind === "output" &&
                      data.status !== "running" ? (
                        <LazyMarkdownContent
                          content={text}
                          variant="assistant"
                        />
                      ) : (
                        text
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : data.text ? (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wider">
                {t.subagent.output}
              </p>
              <LazyMarkdownContent content={data.text} variant="assistant" />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {data.status === "running"
                ? t.subagent.waitingForUpdate
                : t.subagent.noOutput}
            </p>
          )}
          {data.error && (
            <div>
              <p className="text-[11px] font-medium text-red-500 mb-1 uppercase tracking-wider">
                {t.subagent.failed}
              </p>
              <p className="text-xs text-red-500 whitespace-pre-wrap leading-relaxed">
                {data.error}
              </p>
            </div>
          )}
          {data.activities.length === 0 && data.events.length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wider">
                {t.subagent.toolCalls}
              </p>
              <div className="space-y-1.5">
                {data.events.map((ev) =>
                  agnesToolNameFromAlias(ev.name) &&
                  (ev.resultPreview ||
                    subagentEventStatus(ev, data.status) === "running") ? (
                    <AgnesMediaResult
                      key={ev.toolCallId}
                      block={{
                        type: "tool",
                        id: `subagent-tool-${ev.toolCallId}`,
                        toolName: ev.name,
                        title: ev.name,
                        path: "",
                        result: ev.resultPreview,
                        toolCallId: ev.toolCallId,
                      }}
                    />
                  ) : (
                    <ToolCallCard
                      key={ev.toolCallId}
                      toolName={ev.name}
                      title={
                        t.tool.names[ev.name as keyof typeof t.tool.names] ??
                        ev.name
                      }
                      path=""
                      result={ev.resultPreview}
                      toolCallId={ev.toolCallId}
                      toolOutput={ev.toolOutput}
                      status={subagentEventStatus(ev, data.status)}
                    />
                  ),
                )}
              </div>
            </div>
          )}
          {(durationLabel || data.events.length > 0) && (
            <div className="text-[11px] text-muted-foreground border-t border-border/60 pt-2">
              {[
                durationLabel,
                data.events.length > 0
                  ? `${data.events.length} ${t.subagent.toolCalls.toLowerCase()}`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
