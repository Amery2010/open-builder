import { useEffect, useRef, useState } from "react";
import { FileArchive, FolderOpen, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "../../i18n";
import { useConversationStore } from "../../store/conversation";
import { validateProjectRuntime } from "../../lib/project-runtime/validation";
import {
  stageProjectFromDirectoryHandle,
  stageProjectFromFileList,
  stageProjectFromTauriDirectory,
  stageProjectFromZip,
  type ProjectImportCommitResult,
  type StagedProjectImport,
} from "../../lib/utils/project-import";

interface ProjectImportDialogProps {
  open: boolean;
  hasExistingProject: boolean;
  isGenerating: boolean;
  onClose: () => void;
  onImport: (
    project: StagedProjectImport,
    signal?: AbortSignal,
  ) => Promise<ProjectImportCommitResult> | ProjectImportCommitResult;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function isPickerCancellation(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "NotAllowedError")
  );
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function ProjectImportDialog({
  open,
  isGenerating,
  onClose,
  onImport,
}: ProjectImportDialogProps) {
  const t = useT();
  const conversationId = useConversationStore((state) => state.activeId);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [staged, setStaged] = useState<StagedProjectImport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBusy(false);
    setStaged(null);
    setError(null);
    return () => {
      operationRef.current?.abort();
    };
  }, [open, conversationId]);

  const runStage = async (
    loader: () => Promise<StagedProjectImport | null>,
  ) => {
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    setBusy(true);
    setProgress(t.chat.projectImport.reading);
    setError(null);
    setStaged(null);
    try {
      const result = await loader();
      controller.signal.throwIfAborted();
      if (result) {
        setStaged(result);
        setProgress(t.chat.projectImport.verifying);
        const validation = await validateProjectRuntime({
          files: result.files,
          assets: result.assets,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        setStaged({
          ...result,
          template: validation.template,
          previewMode: "sandpack",
          validation,
        });
      }
    } catch (reason: unknown) {
      if (!controller.signal.aborted && !isPickerCancellation(reason)) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        setError(t.chat.projectImport.failed.replace("{message}", message));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const pickFolder = async () => {
    if (isTauri()) {
      await runStage(stageProjectFromTauriDirectory);
      return;
    }
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (picker) {
      await runStage(async () =>
        stageProjectFromDirectoryHandle(
          await picker.call(window, { mode: "read" }),
        ),
      );
      return;
    }
    folderInputRef.current?.click();
  };

  const applyImport = async () => {
    if (!staged?.validation || busy || isGenerating) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onImport(staged, operationRef.current?.signal);
      if (!result.ok) {
        setError(
          t.chat.projectImport.failed.replace("{message}", result.error),
        );
        return;
      }
      onClose();
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(t.chat.projectImport.failed.replace("{message}", message));
    } finally {
      setBusy(false);
    }
  };

  const skippedTotal = staged
    ? Object.values(staged.report.skipped).reduce(
        (total, count) => total + count,
        0,
      )
    : 0;
  const skippedDetails = staged
    ? [
        {
          label: t.chat.projectImport.ignored,
          count: staged.report.skipped.ignored,
        },
        {
          label: t.chat.projectImport.sensitive,
          count: staged.report.skipped.sensitive,
        },
        {
          label: t.chat.projectImport.binary,
          count: staged.report.skipped.binary,
        },
        {
          label: t.chat.projectImport.symlink,
          count: staged.report.skipped.symlink,
        },
      ]
        .filter(({ count }) => count > 0)
        .map(({ label, count }) => `${label} ${count}`)
        .join(" · ")
    : "";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex min-h-0 max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t.chat.projectImport.title}</DialogTitle>
          <DialogDescription>
            {t.chat.projectImport.description}
          </DialogDescription>
        </DialogHeader>

        <input
          ref={(node) => {
            folderInputRef.current = node;
            if (node) node.webkitdirectory = true;
          }}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = event.target.files;
            if (files?.length)
              void runStage(() => stageProjectFromFileList(files));
            event.target.value = "";
          }}
        />
        <input
          ref={zipInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void runStage(() => stageProjectFromZip(file));
            event.target.value = "";
          }}
        />

        <DialogBody className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto justify-start gap-3 px-3 py-3 text-left"
              disabled={busy || isGenerating}
              onClick={() => void pickFolder()}
            >
              <FolderOpen className="size-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="block text-sm font-medium">
                  {t.chat.projectImport.pickFolder}
                </span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {t.chat.projectImport.folderHint}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-auto justify-start gap-3 px-3 py-3 text-left"
              disabled={busy || isGenerating}
              onClick={() => zipInputRef.current?.click()}
            >
              <FileArchive className="size-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="block text-sm font-medium">
                  {t.chat.projectImport.pickZip}
                </span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {t.chat.projectImport.zipHint}
                </span>
              </span>
            </Button>
          </div>

          {isGenerating && (
            <p className="text-xs text-muted-foreground">
              {t.chat.projectImport.stopFirst}
            </p>
          )}

          {busy && (
            <div
              role="status"
              className="flex items-center justify-center gap-2 rounded-lg border bg-muted/30 px-3 py-8 text-sm text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {progress}
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
              {staged && !busy && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 block"
                  onClick={() => void runStage(async () => staged)}
                >
                  {t.chat.projectImport.retry}
                </Button>
              )}
            </p>
          )}

          {staged && !busy && (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
              <div className="flex items-start gap-2">
                <ShieldCheck
                  className={`mt-0.5 size-4 shrink-0 ${staged.validation ? "text-emerald-600" : "text-muted-foreground"}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{staged.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t.chat.projectImport.fileSummary
                      .replace("{count}", String(staged.report.importedFiles))
                      .replace("{size}", formatBytes(staged.report.totalBytes))}
                  </p>
                </div>
              </div>
              <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <div>
                  <dt className="inline">{t.chat.projectImport.template}: </dt>
                  <dd className="inline font-mono text-foreground">
                    {staged.template}
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t.chat.projectImport.filtered}: </dt>
                  <dd className="inline text-foreground">{skippedTotal}</dd>
                </div>
                <div>
                  <dt className="inline">{t.chat.projectImport.redacted}: </dt>
                  <dd className="inline text-foreground">
                    {staged.report.redactedFiles}
                  </dd>
                </div>
              </dl>
              {skippedDetails && (
                <p className="text-xs text-muted-foreground">
                  {skippedDetails}
                </p>
              )}
              {staged.validation && (
                <p className="text-xs text-emerald-700 dark:text-emerald-300">
                  {t.chat.projectImport.verified}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t.chat.projectImport.newConversation}
              </p>
            </div>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={onClose}>
            {t.chat.projectImport.cancel}
          </Button>
          <Button
            type="button"
            disabled={!staged?.validation || busy || isGenerating}
            onClick={() => void applyImport()}
          >
            {t.chat.projectImport.import}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
