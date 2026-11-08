import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileArchive, FolderOpen, Loader2 } from "lucide-react";
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
  const openSessionRef = useRef<object | null>(null);
  const submittingRef = useRef(false);
  const [phase, setPhase] = useState<"reading" | "importing" | null>(null);
  const [staged, setStaged] = useState<StagedProjectImport | null>(null);
  const [error, setError] = useState<{
    phase: "reading" | "importing";
    detail: string;
  } | null>(null);
  const busy = phase !== null;

  useEffect(() => {
    const session = open ? {} : null;
    openSessionRef.current = session;
    return () => {
      if (openSessionRef.current === session) openSessionRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    setPhase(null);
    setStaged(null);
    setError(null);
    return () => {
      operationRef.current?.abort();
      operationRef.current = null;
      submittingRef.current = false;
    };
  }, [open, conversationId]);

  const close = () => {
    openSessionRef.current = null;
    operationRef.current?.abort();
    operationRef.current = null;
    onClose();
  };

  const runStage = async (
    loader: (signal: AbortSignal) => Promise<StagedProjectImport | null>,
  ) => {
    if (submittingRef.current || isGenerating) return;
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    setPhase("reading");
    setError(null);
    setStaged(null);
    try {
      const result = await loader(controller.signal);
      if (!controller.signal.aborted && operationRef.current === controller)
        setStaged(result);
    } catch (reason: unknown) {
      if (
        !controller.signal.aborted &&
        operationRef.current === controller &&
        !isPickerCancellation(reason)
      ) {
        setError({
          phase: "reading",
          detail: reason instanceof Error ? reason.message : String(reason),
        });
      }
    } finally {
      if (!controller.signal.aborted && operationRef.current === controller)
        setPhase(null);
    }
  };

  const pickFolder = async () => {
    if ("__TAURI_INTERNALS__" in window) {
      await runStage(stageProjectFromTauriDirectory);
      return;
    }
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (picker) {
      await runStage(async (signal) => {
        const directory = await picker.call(window, { mode: "read" });
        signal.throwIfAborted();
        return stageProjectFromDirectoryHandle(directory, signal);
      });
      return;
    }
    folderInputRef.current?.click();
  };

  const applyImport = async () => {
    const session = openSessionRef.current;
    if (
      !session ||
      !staged?.preflight ||
      busy ||
      submittingRef.current ||
      isGenerating
    )
      return;
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    submittingRef.current = true;
    setPhase("importing");
    setError(null);
    try {
      const result = await onImport(staged, controller.signal);
      // A successful commit activates its new Conversation, which cancels the
      // source operation. Close only this opening, never a reopened dialog.
      if (result.ok) {
        if (openSessionRef.current === session) close();
        return;
      }
      if (controller.signal.aborted || operationRef.current !== controller)
        return;
      setError({ phase: "importing", detail: result.error });
    } catch (reason: unknown) {
      if (!controller.signal.aborted && operationRef.current === controller) {
        setError({
          phase: "importing",
          detail: reason instanceof Error ? reason.message : String(reason),
        });
      }
    } finally {
      if (operationRef.current === controller) {
        submittingRef.current = false;
        setPhase(null);
      }
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
  const previewSupported = staged?.preflight.capabilities.preview.supported;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="flex min-h-0 max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 px-4 pt-6 pb-4 text-left sm:px-6">
          <DialogTitle className="pr-8">
            {t.chat.projectImport.title}
          </DialogTitle>
          <DialogDescription className="pr-4 text-pretty">
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
            const files = Array.from(event.target.files ?? []);
            if (files.length)
              void runStage((signal) =>
                stageProjectFromFileList(files, signal),
              );
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
            if (file)
              void runStage((signal) => stageProjectFromZip(file, signal));
            event.target.value = "";
          }}
        />

        <DialogBody className="space-y-4 px-4 sm:px-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-w-0 items-start justify-start gap-3 whitespace-normal p-4 text-left"
              disabled={busy || isGenerating}
              onClick={() => void pickFolder()}
            >
              <FolderOpen className="size-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 space-y-1">
                <span className="block text-sm font-medium">
                  {t.chat.projectImport.pickFolder}
                </span>
                <span className="block text-xs font-normal text-pretty text-muted-foreground">
                  {t.chat.projectImport.folderHint}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-auto min-w-0 items-start justify-start gap-3 whitespace-normal p-4 text-left"
              disabled={busy || isGenerating}
              onClick={() => zipInputRef.current?.click()}
            >
              <FileArchive className="size-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 space-y-1">
                <span className="block text-sm font-medium">
                  {t.chat.projectImport.pickZip}
                </span>
                <span className="block text-xs font-normal text-pretty text-muted-foreground">
                  {t.chat.projectImport.zipHint}
                </span>
              </span>
            </Button>
          </div>

          {isGenerating && (
            <p className="text-sm text-muted-foreground">
              {t.chat.projectImport.stopFirst}
            </p>
          )}

          {busy && (
            <div
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2
                className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {phase === "importing"
                ? t.chat.projectImport.importing
                : t.chat.projectImport.reading}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
            >
              <p>
                {error.phase === "reading"
                  ? t.chat.projectImport.readFailed
                  : t.chat.projectImport.failed}
              </p>
              <details className="text-xs">
                <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                  {t.chat.projectImport.errorDetails}
                </summary>
                <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {error.detail}
                </p>
              </details>
            </div>
          )}

          {staged && (
            <section
              className="space-y-4 rounded-lg border bg-muted/20 p-4"
              aria-label={staged.name}
            >
              <div className="flex items-start gap-3">
                <CheckCircle2
                  className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-sm font-semibold [overflow-wrap:anywhere]">
                    {staged.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t.chat.projectImport.fileSummary
                      .replace("{count}", String(staged.report.importedFiles))
                      .replace("{size}", formatBytes(staged.report.totalBytes))}
                  </p>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div className="min-w-0 space-y-1">
                  <dt className="text-xs text-muted-foreground">
                    {t.chat.projectImport.previewMode}
                  </dt>
                  <dd>
                    {previewSupported
                      ? t.chat.projectImport.previewAvailable
                      : t.chat.projectImport.codeOnlyMode}
                  </dd>
                </div>
                <div className="min-w-0 space-y-1">
                  <dt className="text-xs text-muted-foreground">
                    {t.chat.projectImport.assets}
                  </dt>
                  <dd>{staged.assets?.length ?? 0}</dd>
                </div>
              </dl>
              <div className="space-y-1 text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-300">
                  {t.chat.projectImport.checked}
                </p>
                <p className="text-pretty text-muted-foreground">
                  {previewSupported
                    ? t.chat.projectImport.previewAfterImport
                    : t.chat.projectImport.codeOnly}
                </p>
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                  {t.chat.projectImport.details}
                </summary>
                <div className="mt-3 space-y-2 break-words [overflow-wrap:anywhere]">
                  {!previewSupported && (
                    <p>{staged.preflight.capabilities.preview.reason}</p>
                  )}
                  <p>
                    {t.chat.projectImport.template}:{" "}
                    <span className="font-mono text-foreground">
                      {staged.template}
                    </span>
                  </p>
                  <p>
                    {t.chat.projectImport.filtered}: {skippedTotal} ·{" "}
                    {t.chat.projectImport.redacted}:{" "}
                    {staged.report.redactedFiles}
                  </p>
                  {skippedDetails && <p>{skippedDetails}</p>}
                </div>
              </details>
            </section>
          )}
          <p className="text-xs text-pretty text-muted-foreground">
            {t.chat.projectImport.newConversation}
          </p>
        </DialogBody>

        <DialogFooter className="shrink-0 px-4 pt-4 pb-6 sm:px-6">
          <Button type="button" variant="outline" onClick={close}>
            {t.chat.projectImport.cancel}
          </Button>
          <Button
            type="button"
            disabled={!staged?.preflight || busy || isGenerating}
            onClick={() => void applyImport()}
          >
            {phase === "importing"
              ? t.chat.projectImport.importing
              : t.chat.projectImport.import}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
