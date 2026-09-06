import { useMemo, useState, memo } from "react";
import { ChevronRight, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
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
} from "../../lib/ai/subagents/limits";
import type {
  SubagentEvent,
  SubagentStatus,
  SubagentToolResult,
} from "../../lib/ai/subagents/types";
import type { ToolBlock } from "../../types";
import { agnesToolNameFromAlias } from "../../lib/mcp/agnes/aliases";

type SubagentCardData = {
  subagent: string;
  task: string;
  status: SubagentStatus;
  text: string;
  events: SubagentEvent[];
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
    return {
      subagent: data.subagent,
      task: truncateSubagentText(data.task ?? "", SUBAGENT_LIMITS.maxTaskChars),
      status: data.status ?? (data.ok ? "done" : "failed"),
      text: truncateSubagentText(
        data.text ?? "",
        SUBAGENT_LIMITS.maxLiveTextChars,
      ),
      events: Array.isArray(data.events)
        ? limitSubagentEvents(data.events)
        : [],
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

  const live = useSubagentStore((s) => s.progress[toolCallId]);
  const persisted = useMemo(() => parsePersisted(result), [result]);
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
      };
    }
    return persistedError
      ? { ...base, status: "failed", error: persistedError }
      : base;
  }, [live, persisted, persistedError, rawArgs, result]);

  const displayName =
    t.subagent.names[data.subagent as keyof typeof t.subagent.names] ??
    data.subagent;
  const def = getSubagentByName(data.subagent);
  const writePolicy = def?.writePolicy ?? "readonly";
  const durationLabel =
    data.durationMs != null
      ? t.subagent.duration.replace("{n}", (data.durationMs / 1000).toFixed(1))
      : "";

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-muted/30">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <Bot size={14} className="text-violet-500 shrink-0" />
        <span className="text-xs font-medium text-foreground shrink-0">
          {displayName}
        </span>
        <span className="flex-1 min-w-0" aria-hidden="true" />
        <Badge
          variant="outline"
          className="text-[10px] font-mono h-5 px-1.5 text-muted-foreground border-border/80"
        >
          {writePolicy === "fullWrite"
            ? t.subagent.policyFullWrite
            : t.subagent.policyReadonly}
        </Badge>
        <StatusBadge status={data.status} t={t} />
        <ChevronRight
          size={13}
          className={cn(
            "text-muted-foreground transition-transform shrink-0",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div className="px-3 py-2 border-t border-border/60 bg-muted/20 space-y-3">
          {data.task && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wider">
                {t.subagent.task}
              </p>
              <p className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">
                {data.task}
              </p>
            </div>
          )}
          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wider">
              {t.subagent.output}
            </p>
            {data.text ? (
              <LazyMarkdownContent content={data.text} variant="assistant" />
            ) : data.status === "running" ? (
              <p className="text-xs text-muted-foreground italic">
                {t.subagent.running}…
              </p>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                {t.subagent.noOutput}
              </p>
            )}
          </div>
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
          {data.events.length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wider">
                {t.subagent.toolCalls}
              </p>
              <div className="space-y-1.5">
                {data.events.map((ev) =>
                  agnesToolNameFromAlias(ev.name) ? (
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
      )}
    </div>
  );
});
