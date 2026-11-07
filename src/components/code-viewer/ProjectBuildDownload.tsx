import { useEffect, useRef, useState } from "react";
import { Download, Package } from "lucide-react";
import { saveAs } from "file-saver";
import type { ProjectAssets, ProjectFiles } from "../../types";
import { useT } from "../../i18n";
import { useConversationStore } from "../../store/conversation";
import { assessProjectRuntime } from "../../lib/project-runtime/capabilities";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface ProjectBuildDownloadProps {
  files: ProjectFiles;
  assets: ProjectAssets;
  isGenerating: boolean;
  onDownloadSource: () => Promise<void>;
}

export function ProjectBuildDownload({
  files,
  assets,
  isGenerating,
  onDownloadSource,
}: ProjectBuildDownloadProps) {
  const t = useT().projectBuild;
  const conversationId = useConversationStore((state) => state.activeId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const capabilities = assessProjectRuntime(files);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [files, assets, conversationId],
  );

  async function build(): Promise<void> {
    if (busy || isGenerating || !capabilities.staticBuild.supported) return;
    const run = new AbortController();
    const projectAtStart = conversationId
      ? useConversationStore.getState().conversations[conversationId]
      : undefined;
    controller.current = run;
    setBusy(true);
    setError("");
    setStatus(t.preparing);
    try {
      const { buildStaticDeployment } = await import("../../lib/project-build");
      run.signal.throwIfAborted();
      const result = await buildStaticDeployment({
        files,
        assets,
        signal: run.signal,
        onProgress: (message) => {
          if (!run.signal.aborted) setStatus(message);
        },
      });
      const state = useConversationStore.getState();
      const latest = conversationId
        ? state.conversations[conversationId]
        : undefined;
      if (
        state.activeId !== conversationId ||
        latest?.files !== projectAtStart?.files ||
        latest?.assets !== projectAtStart?.assets
      ) {
        run.abort(
          new DOMException(
            "The project changed during the build.",
            "AbortError",
          ),
        );
      }
      run.signal.throwIfAborted();
      saveAs(result.blob, "project-deploy.zip");
      setStatus(t.ready);
    } catch (reason) {
      if (run.signal.aborted) setStatus(t.cancelled);
      else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (controller.current === run) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  function changeOpen(next: boolean): void {
    if (!next) controller.current?.abort();
    setOpen(next);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t.download}>
            <Download size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              void onDownloadSource().catch((reason: unknown) => {
                setError(String(reason));
                setOpen(true);
              });
            }}
          >
            <Download size={16} />
            {t.source}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setError("");
              setStatus("");
              setOpen(true);
            }}
          >
            <Package size={16} />
            {t.deployment}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.title}</DialogTitle>
            <DialogDescription>
              {capabilities.template === "static"
                ? t.deployment
                : t.compatibility}
            </DialogDescription>
          </DialogHeader>
          {!capabilities.staticBuild.supported && (
            <p className="text-sm text-muted-foreground">
              {capabilities.staticBuild.reason}
            </p>
          )}
          {status && (
            <p
              role="status"
              className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm"
            >
              {status}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm text-destructive"
            >
              {t.failed}: {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (busy) controller.current?.abort();
                else changeOpen(false);
              }}
            >
              {busy ? t.cancel : t.close}
            </Button>
            <Button
              disabled={
                busy || isGenerating || !capabilities.staticBuild.supported
              }
              onClick={() => void build()}
            >
              {t.start}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
