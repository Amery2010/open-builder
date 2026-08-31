import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import type { MessageMetadata } from "../../types";
import { useConversationStore } from "../../store/conversation";
import { useDesignReviewStore } from "../../store/design-review";
import { isDesignReviewRunActive } from "../../lib/design/review-jobs/types";
import { formatDesignReviewLogEntry } from "../../lib/design/review-jobs/logs";

interface DesignReviewActivityBlockProps {
  reviewJobId: string;
  summary?: NonNullable<MessageMetadata["reviewSummary"]>;
}

export function DesignReviewActivityBlock({
  reviewJobId,
  summary,
}: DesignReviewActivityBlockProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const activeConversationId = useConversationStore((state) => state.activeId);
  const run = useDesignReviewStore((state) => {
    for (const runs of Object.values(state.runsByConversation)) {
      const match = runs.find((candidate) => candidate.id === reviewJobId);
      if (match) return match;
    }
    return undefined;
  });
  const status =
    run?.status === "succeeded" &&
    (summary?.status === "fixing" || summary?.status === "verifying")
      ? summary.status
      : (run?.status ?? summary?.status ?? "capturing");
  const stale = run?.freshness === "stale" || summary?.stale === true;
  const findingCount = run?.report?.findings.length ?? summary?.findingCount;
  const latestLog = run?.logs.at(-1);
  const latestLogText = latestLog
    ? formatDesignReviewLogEntry(latestLog, t, run?.provider.runtime)
    : undefined;
  const running = [
    "capturing",
    "queued",
    "running",
    "fixing",
    "verifying",
  ].includes(status)
    ? true
    : Boolean(run && isDesignReviewRunActive(run));
  const failed = status === "failed" || status === "interrupted";
  const cancelled = status === "cancelled";
  const canOpen = Boolean(run && activeConversationId === run.conversationId);

  const openReview = () => {
    if (!run || activeConversationId !== run.conversationId) return;
    useDesignReviewStore.getState().openRun(activeConversationId, run.id);
  };

  return (
    <section
      aria-label={t.designReview.activityTitle}
      className="rounded-xl border bg-muted/20 p-3"
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="mt-0.5 shrink-0" aria-hidden="true">
          {running ? (
            <Loader2 className="size-4 animate-spin text-violet-500" />
          ) : failed || stale ? (
            <AlertTriangle className="size-4 text-amber-600" />
          ) : (
            <CheckCircle2
              className={cn(
                "size-4",
                cancelled ? "text-muted-foreground" : "text-emerald-600",
              )}
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">
              {t.designReview.activityTitle}
            </span>
            <span className="text-xs text-muted-foreground">
              {t.designReview.status[status]}
            </span>
            {stale && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                {t.designReview.stale}
              </span>
            )}
          </span>
          <span
            className="mt-1 block truncate text-xs text-muted-foreground"
            aria-live="polite"
          >
            {latestLogText ??
              (findingCount === undefined
                ? t.designReview.activityWaiting
                : t.designReview.findingCount.replace(
                    "{count}",
                    String(findingCount),
                  ))}
          </span>
        </span>
        {expanded ? (
          <ChevronDown className="mt-0.5 size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 size-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t pt-3">
          {run?.report ? (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {run.report.overview}
              </p>
              {run.report.findings.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t.designReview.noFindings}
                </p>
              ) : (
                <ol className="space-y-2">
                  {run.report.findings.slice(0, 8).map((finding) => (
                    <li key={finding.id} className="rounded-lg border p-2.5">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono font-semibold">
                          {finding.priority}
                        </span>
                        <span className="font-medium">{finding.title}</span>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {finding.evidence}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed">
                        {finding.recommendation}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {latestLogText ?? t.designReview.activityWaiting}
            </p>
          )}
          {canOpen && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={openReview}
            >
              {t.designReview.openWorkspace}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
