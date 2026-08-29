import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import { useDesignReviewStore } from "../../store/design-review";
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
  isGenerating: boolean;
}

const MAX_MANUAL_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export function DesignReviewDialog({
  open,
  onOpenChange,
  onRunReview,
  onApplyFixes,
  onCaptureScreenshots,
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
  const uploadRef = useRef<HTMLInputElement>(null);
  const [readingFiles, setReadingFiles] = useState(false);

  useEffect(() => {
    if (
      open &&
      status === "idle" &&
      screenshots.length === 0 &&
      onCaptureScreenshots
    ) {
      void onCaptureScreenshots();
    }
  }, [onCaptureScreenshots, open, screenshots.length, status]);

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
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
          file.size > MAX_MANUAL_SCREENSHOT_BYTES
        ) {
          throw new Error(t.designReview.invalidScreenshot);
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () =>
            reject(reader.error ?? new Error("read failed"));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(file);
        });
        next.push({
          dataUrl,
          mimeType: file.type as DesignReviewScreenshot["mimeType"],
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

  const selectedFindings =
    report?.findings.filter((finding) =>
      selectedFindingIds.includes(finding.id),
    ) ?? [];
  const capturing = status === "capturing";
  const reviewing = status === "reviewing";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-6 py-5 pr-14">
          <DialogTitle>{t.designReview.title}</DialogTitle>
          <DialogDescription>{t.designReview.description}</DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto px-6 py-5">
          {captureErrors.length > 0 && status !== "error" && (
            <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">
                {t.designReview.partialCapture}
              </p>
              <p className="mt-1">{captureErrors.join(" ")}</p>
            </div>
          )}
          {status === "idle" && (
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

          {status === "error" && (
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
                    onClick={() => void onRunReview(screenshots)}
                    disabled={readingFiles || isGenerating}
                  >
                    {t.designReview.runReview}
                  </Button>
                  {onCaptureScreenshots && (
                    <Button
                      variant="outline"
                      onClick={() => void onCaptureScreenshots()}
                      disabled={readingFiles || isGenerating}
                    >
                      {t.designReview.recapture}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => uploadRef.current?.click()}
                    disabled={readingFiles || isGenerating}
                  >
                    {t.designReview.chooseScreenshots}
                  </Button>
                </div>
              </div>
            )}

          {status === "complete" && report && (
            <div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {report.overview}
              </p>
              {screenshots.length > 0 && (
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
              <div className="mt-5 space-y-2">
                {report.findings.map((finding) => {
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
        </div>

        <DialogFooter className="border-t bg-muted/20 px-6 py-4">
          {status === "complete" && captureErrors.length > 0 && (
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
          {status === "complete" && (
            <Button
              disabled={selectedFindings.length === 0 || isGenerating}
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
