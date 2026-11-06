import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { requestConfirmation } from "../../lib/confirmation";
import { useT } from "../../i18n";
import { useDesignReviewStore } from "../../store/design-review";
import type { DesignReviewRun } from "../../lib/design/review-jobs/types";
import { isDesignReviewRunActive } from "../../lib/design/review-jobs/types";
import { formatDesignReviewLogEntry } from "../../lib/design/review-jobs/logs";
import { readScreenshotImage } from "../../lib/images/screenshot";
import {
  validateDesignReviewScreenshots,
  type DesignReviewFinding,
  type DesignReviewScreenshot,
} from "../../lib/design/review";

interface DesignReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRunReview: (
    screenshots: readonly DesignReviewScreenshot[],
  ) => Promise<void> | void;
  onApplyFixes: (
    findings: readonly DesignReviewFinding[],
  ) => Promise<void> | void;
  onCaptureScreenshots?: () => Promise<void> | void;
  conversationId?: string;
  onCancelRun?: (run: DesignReviewRun) => Promise<void> | void;
  onRetryRun?: (run: DesignReviewRun) => Promise<void> | void;
  isGenerating: boolean;
}

const MAX_MANUAL_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const EMPTY_DESIGN_REVIEW_RUNS: DesignReviewRun[] = [];

function RunStatusIcon({ run }: { run: DesignReviewRun }) {
  if (isDesignReviewRunActive(run)) {
    return <Loader2 size={14} className="animate-spin text-violet-500" />;
  }
  if (run.status === "succeeded") {
    return <CheckCircle2 size={14} className="text-emerald-600" />;
  }
  if (run.status === "cancelled") {
    return <Ban size={14} className="text-muted-foreground" />;
  }
  return <AlertTriangle size={14} className="text-amber-600" />;
}

export function DesignReviewDialog({
  open,
  onOpenChange,
  onRunReview,
  onApplyFixes,
  onCaptureScreenshots,
  conversationId,
  onCancelRun,
  onRetryRun,
  isGenerating,
}: DesignReviewDialogProps) {
  const t = useT();
  const status = useDesignReviewStore((state) => state.status);
  const screenshots = useDesignReviewStore((state) => state.screenshots);
  const report = useDesignReviewStore((state) => state.report);
  const error = useDesignReviewStore((state) => state.error);
  const captureErrors = useDesignReviewStore((state) => state.captureErrors);
  const captureProgress = useDesignReviewStore(
    (state) => state.captureProgress,
  );
  const selectedFindingIds = useDesignReviewStore(
    (state) => state.selectedFindingIds,
  );
  const setScreenshots = useDesignReviewStore((state) => state.setScreenshots);
  const toggleFinding = useDesignReviewStore((state) => state.toggleFinding);
  const fail = useDesignReviewStore((state) => state.fail);
  const runs = useDesignReviewStore((state) =>
    conversationId
      ? (state.runsByConversation[conversationId] ?? EMPTY_DESIGN_REVIEW_RUNS)
      : EMPTY_DESIGN_REVIEW_RUNS,
  );
  const selectedRunId = useDesignReviewStore((state) =>
    conversationId
      ? state.selectedRunIdByConversation[conversationId]
      : undefined,
  );
  const selectRun = useDesignReviewStore((state) => state.selectRun);
  const removeRun = useDesignReviewStore((state) => state.removeRun);
  const setSelectedFindingIds = useDesignReviewStore(
    (state) => state.setSelectedFindingIds,
  );
  const uploadRef = useRef<HTMLInputElement>(null);
  const [readingFiles, setReadingFiles] = useState(false);

  useEffect(() => {
    if (
      open &&
      status === "idle" &&
      screenshots.length === 0 &&
      runs.length === 0 &&
      onCaptureScreenshots
    ) {
      void onCaptureScreenshots();
    }
  }, [onCaptureScreenshots, open, runs.length, screenshots.length, status]);

  const readManualScreenshots = async (files: FileList | null) => {
    if (!files?.length) return;
    if (files.length > 3) {
      fail(t.designReview.tooManyScreenshots);
      return;
    }
    setReadingFiles(true);
    try {
      const next: DesignReviewScreenshot[] = [];
      for (const file of Array.from(files)) {
        if (file.size > MAX_MANUAL_SCREENSHOT_BYTES) {
          throw new Error(t.designReview.invalidScreenshot);
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () =>
            reject(reader.error ?? new Error("read failed"));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(file);
        });
        const image = readScreenshotImage(dataUrl);
        next.push({
          dataUrl: image.dataUrl,
          mimeType: image.mimeType,
          name: file.name,
          source: "manual",
        });
      }
      validateDesignReviewScreenshots(next);
      const automaticScreenshots = screenshots.filter(
        (screenshot) => screenshot.source === "automatic",
      );
      const merged =
        automaticScreenshots.length + next.length <= 3
          ? [...automaticScreenshots, ...next]
          : next;
      validateDesignReviewScreenshots(merged);
      setScreenshots(merged);
    } catch (reason) {
      fail(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReadingFiles(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const selectedRun =
    runs.find((run) => run.id === selectedRunId) ?? runs.at(0);
  const activeRun = runs.find(isDesignReviewRunActive);
  const effectiveReport = selectedRun?.report ?? report;
  const selectedFindings =
    effectiveReport?.findings.filter((finding) =>
      selectedFindingIds.includes(finding.id),
    ) ?? [];
  const findingIds =
    effectiveReport?.findings.map((finding) => finding.id) ?? [];
  const allFindingsSelected =
    findingIds.length > 0 &&
    findingIds.every((findingId) => selectedFindingIds.includes(findingId));
  const capturing = status === "capturing" && !selectedRun;
  const reviewing = status === "reviewing" && !selectedRun;
  const runInProgress = Boolean(activeRun);
  const coverageSummary = selectedRun?.coverage
    ? {
        passed: selectedRun.coverage.filter(
          (entry) => entry.status === "passed",
        ).length,
        needsFix: selectedRun.coverage.filter(
          (entry) => entry.status === "needs-fix",
        ).length,
        unreviewed: selectedRun.coverage.filter(
          (entry) =>
            entry.status === "unreviewed" || entry.status === "captured",
        ).length,
      }
    : undefined;

  const handleDeleteRun = async (run: DesignReviewRun) => {
    if (isDesignReviewRunActive(run)) return;
    const confirmed = await requestConfirmation({
      title: t.designReview.deleteHistoryTitle,
      message: t.designReview.deleteHistoryDescription,
      confirmLabel: t.designReview.deleteHistoryConfirm,
      cancelLabel: t.designReview.cancel,
      destructive: true,
    });
    if (confirmed) removeRun(run.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex min-h-0 max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>{t.designReview.title}</DialogTitle>
          <DialogDescription>{t.designReview.description}</DialogDescription>
        </DialogHeader>

        <DialogBody className="px-6 py-5">
          {runs.length > 0 && (
            <section aria-label={t.designReview.history} className="mb-5">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t.designReview.history}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {t.designReview.historyCount.replace(
                    "{count}",
                    String(runs.length),
                  )}
                </span>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {runs.map((run) => (
                  <div
                    key={run.id}
                    className={cn(
                      "flex min-w-36 items-stretch rounded-lg border text-left text-xs transition-colors",
                      selectedRun?.id === run.id
                        ? "border-violet-500/40 bg-violet-500/5"
                        : "hover:bg-muted/40",
                    )}
                  >
                    <button
                      type="button"
                      aria-current={
                        selectedRun?.id === run.id ? "true" : undefined
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                      onClick={() =>
                        conversationId && selectRun(conversationId, run.id)
                      }
                    >
                      <RunStatusIcon run={run} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {run.kind === "automatic"
                            ? t.designReview.automatic
                            : t.designReview.manual}
                        </span>
                        <span className="block text-muted-foreground">
                          {t.designReview.status[run.status]}
                        </span>
                      </span>
                    </button>
                    {!isDesignReviewRunActive(run) && (
                      <TooltipIconButton
                        label={t.designReview.deleteHistory}
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="my-1 mr-1 text-destructive hover:text-destructive"
                        onClick={() => void handleDeleteRun(run)}
                      >
                        <Trash2 aria-hidden="true" />
                      </TooltipIconButton>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {selectedRun && (
            <section className="mb-5 rounded-xl border bg-muted/15 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <RunStatusIcon run={selectedRun} />
                  <div>
                    <p className="text-sm font-medium">
                      {t.designReview.status[selectedRun.status]}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t.designReview.provider
                        .replace("{provider}", selectedRun.provider.provider)
                        .replace("{model}", selectedRun.provider.model)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selectedRun.freshness === "stale" && (
                    <span className="rounded bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      {t.designReview.stale}
                    </span>
                  )}
                  {isDesignReviewRunActive(selectedRun) && onCancelRun && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void onCancelRun(selectedRun)}
                    >
                      {t.designReview.cancelReview}
                    </Button>
                  )}
                  {!isDesignReviewRunActive(selectedRun) && onRetryRun && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void onRetryRun(selectedRun)}
                    >
                      <RefreshCw size={13} />
                      {t.designReview.recaptureRetry}
                    </Button>
                  )}
                </div>
              </div>
              {selectedRun.error && (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                  {selectedRun.error}
                </p>
              )}
              {coverageSummary && (
                <div className="mt-3 rounded-lg border bg-background/70 px-3 py-2 text-xs">
                  <p className="font-medium">{t.designReview.coverage}</p>
                  <p className="mt-1 text-muted-foreground">
                    {t.designReview.coverageSummary
                      .replace("{passed}", String(coverageSummary.passed))
                      .replace("{needsFix}", String(coverageSummary.needsFix))
                      .replace(
                        "{unreviewed}",
                        String(coverageSummary.unreviewed),
                      )}
                  </p>
                </div>
              )}
              <ol
                aria-label={t.designReview.executionLog}
                className="mt-4 h-44 space-y-2 overflow-y-auto border-t pt-3 pr-2"
              >
                {selectedRun.logs.map((entry) => (
                  <li
                    key={entry.id}
                    className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 text-xs"
                  >
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {new Date(entry.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1",
                        entry.level === "error" && "text-destructive",
                        entry.level === "warning" &&
                          "text-amber-700 dark:text-amber-400",
                      )}
                    >
                      {formatDesignReviewLogEntry(
                        entry,
                        t,
                        selectedRun.provider.runtime,
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {captureErrors.length > 0 && status !== "error" && (
            <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">
                {t.designReview.partialCapture}
              </p>
              <p className="mt-1">{captureErrors.join(" ")}</p>
            </div>
          )}
          {status === "idle" && !selectedRun && (
            <div>
              <div className="rounded-xl border border-dashed p-5">
                <Upload size={22} className="text-muted-foreground" />
                <h3 className="mt-3 text-sm font-semibold">
                  {t.designReview.manualTitle}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t.designReview.manualDescription}
                </p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => uploadRef.current?.click()}
                >
                  {t.designReview.chooseScreenshots}
                </Button>
              </div>
            </div>
          )}

          {capturing && (
            <div className="flex min-h-52 flex-col items-center justify-center text-center">
              <Loader2 size={26} className="animate-spin text-violet-500" />
              <p className="mt-4 text-sm font-medium">
                {t.designReview.capturing}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t.designReview.capturingDescription
                  .replace(
                    "{completed}",
                    String(captureProgress?.completed ?? 0),
                  )
                  .replace("{total}", String(captureProgress?.total ?? 3))}
              </p>
            </div>
          )}

          {reviewing && (
            <div className="flex min-h-52 flex-col items-center justify-center text-center">
              <Loader2 size={26} className="animate-spin text-violet-500" />
              <p className="mt-4 text-sm font-medium">
                {t.designReview.reviewing}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t.designReview.reviewingDescription}
              </p>
            </div>
          )}

          {status === "error" && !selectedRun && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
              <div className="flex gap-3">
                <AlertTriangle
                  size={18}
                  className="mt-0.5 shrink-0 text-amber-600"
                />
                <div>
                  <p className="text-sm font-medium">
                    {t.designReview.reviewUnavailable}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{error}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => uploadRef.current?.click()}
                  >
                    {t.designReview.chooseScreenshots}
                  </Button>
                  {onCaptureScreenshots && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-3"
                      onClick={() => void onCaptureScreenshots()}
                    >
                      {t.designReview.recapture}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {screenshots.length > 0 &&
            !capturing &&
            !reviewing &&
            !selectedRun &&
            status !== "complete" && (
              <div className="mt-5">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {screenshots.map((screenshot, index) => (
                    <img
                      key={`${screenshot.name ?? "screenshot"}-${index}`}
                      src={screenshot.dataUrl}
                      alt={t.designReview.screenshotAlt.replace(
                        "{name}",
                        screenshot.name ?? String(index + 1),
                      )}
                      className="aspect-video w-full rounded-lg border object-cover object-top"
                    />
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      const pending = onRunReview(screenshots);
                      onOpenChange(false);
                      void pending;
                    }}
                    disabled={readingFiles || runInProgress}
                  >
                    {t.designReview.runReview}
                  </Button>
                  {onCaptureScreenshots && (
                    <Button
                      variant="outline"
                      onClick={() => void onCaptureScreenshots()}
                      disabled={readingFiles || runInProgress}
                    >
                      {t.designReview.recapture}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => uploadRef.current?.click()}
                    disabled={readingFiles || runInProgress}
                  >
                    {t.designReview.chooseScreenshots}
                  </Button>
                </div>
              </div>
            )}

          {effectiveReport &&
            ((!selectedRun && status === "complete") ||
              selectedRun?.status === "succeeded") && (
              <div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {effectiveReport.overview}
                </p>
                {screenshots.length > 0 && !selectedRun && (
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {screenshots.map((screenshot, index) => (
                      <img
                        key={`${screenshot.name ?? "screenshot"}-${index}`}
                        src={screenshot.dataUrl}
                        alt={t.designReview.screenshotAlt.replace(
                          "{name}",
                          screenshot.name ?? String(index + 1),
                        )}
                        className="aspect-video w-full rounded-lg border object-cover object-top"
                      />
                    ))}
                  </div>
                )}
                {findingIds.length > 0 && (
                  <div className="mt-5 flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-pressed={allFindingsSelected}
                      onClick={() =>
                        setSelectedFindingIds(
                          allFindingsSelected ? [] : findingIds,
                        )
                      }
                    >
                      {allFindingsSelected
                        ? t.designReview.clearAllFindings
                        : t.designReview.selectAllFindings}
                    </Button>
                  </div>
                )}
                <div className="mt-5 space-y-2">
                  {effectiveReport.findings.map((finding) => {
                    const selected = selectedFindingIds.includes(finding.id);
                    return (
                      <label
                        key={finding.id}
                        className={cn(
                          "flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors",
                          selected
                            ? "border-violet-500/40 bg-violet-500/5"
                            : "hover:bg-muted/40",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleFinding(finding.id)}
                          className="mt-1 size-4 accent-violet-600"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold">
                              {finding.priority}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {t.designReview.dimensions[finding.dimension]}
                            </span>
                          </span>
                          <span className="mt-1 block text-sm font-medium">
                            {finding.title}
                          </span>
                          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                            {finding.evidence}
                          </span>
                          <span className="mt-2 block text-xs leading-relaxed">
                            {finding.recommendation}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

          <input
            ref={uploadRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(event) => void readManualScreenshots(event.target.files)}
          />
        </DialogBody>

        <DialogFooter className="shrink-0 border-t bg-muted/20 px-6 py-4">
          {!selectedRun &&
            status === "complete" &&
            captureErrors.length > 0 && (
              <Button
                variant="outline"
                onClick={() => uploadRef.current?.click()}
              >
                {t.designReview.chooseScreenshots}
              </Button>
            )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.designReview.close}
          </Button>
          {effectiveReport &&
            ((!selectedRun && status === "complete") ||
              selectedRun?.status === "succeeded") && (
              <Button
                disabled={
                  selectedFindings.length === 0 ||
                  isGenerating ||
                  selectedRun?.freshness === "stale"
                }
                onClick={() => void onApplyFixes(selectedFindings)}
              >
                {t.designReview.applySelected.replace(
                  "{count}",
                  String(selectedFindings.length),
                )}
              </Button>
            )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
