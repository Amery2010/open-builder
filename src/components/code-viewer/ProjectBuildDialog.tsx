import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useConversationStore } from "../../store/conversation";
import { useSnapshotStore } from "../../store/snapshot";
import { assessProjectRuntime } from "../../lib/project-runtime/capabilities";
import { saveProjectArchive } from "../../lib/project-archives/download";
import {
  resolveBuildTarget,
  type ProjectBuildTarget,
  type ResolvedBuildTarget,
} from "../../lib/project-build/target";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type Phase = "idle" | "building" | "ready" | "saving" | "cancelled";
interface BuildRun {
  controller: AbortController;
  source: ResolvedBuildTarget;
  busy: boolean;
}
interface Artifact {
  blob: Blob;
  fileName: string;
}

function readSource(target: ProjectBuildTarget): {
  source?: ResolvedBuildTarget;
  error?: string;
} {
  try {
    return { source: resolveBuildTarget(target) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function ProjectBuildDialog({
  target,
  onClose,
  isGenerating = false,
}: {
  target: ProjectBuildTarget;
  onClose: () => void;
  isGenerating?: boolean;
}) {
  const t = useT().projectBuild;
  const [resolved, setResolved] = useState(() => readSource(target));
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [artifact, setArtifact] = useState<Artifact>();
  const currentRun = useRef<BuildRun | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const capabilities =
    resolved.source && assessProjectRuntime(resolved.source.files);
  const targetKey = JSON.stringify(target);

  useEffect(() => {
    const selected: ProjectBuildTarget = JSON.parse(targetKey);
    setArtifact(undefined);
    setPhase("idle");
    setStatus("");
    setError("");
    const update = () => {
      if (
        useConversationStore.getState().activeId !== selected.conversationId
      ) {
        currentRun.current?.controller.abort();
        currentRun.current = null;
        closeRef.current();
        return;
      }
      const run = currentRun.current;
      if (run && !run.source.isCurrent()) {
        run.controller.abort();
        currentRun.current = null;
        setArtifact(undefined);
        setPhase("cancelled");
        setError("");
        setStatus("");
      }
      // Historical reconstruction stays lazy while its captured version is retained.
      if (!currentRun.current) setResolved(readSource(selected));
    };
    const unsubscribeConversation = useConversationStore.subscribe(update);
    const unsubscribeSnapshots = useSnapshotStore.subscribe(update);
    update();
    return () => {
      unsubscribeConversation();
      unsubscribeSnapshots();
      currentRun.current?.controller.abort();
      currentRun.current = null;
    };
  }, [targetKey]);

  function close(): void {
    currentRun.current?.controller.abort();
    currentRun.current = null;
    setArtifact(undefined);
    onClose();
  }

  function cancel(): void {
    currentRun.current?.controller.abort();
    currentRun.current = null;
    setArtifact(undefined);
    setPhase("cancelled");
    setStatus("");
  }

  async function build(): Promise<void> {
    if (currentRun.current?.busy || (target.kind === "current" && isGenerating))
      return;
    const next = readSource(target);
    setResolved(next);
    if (!next.source?.isCurrent()) {
      setError(next.error ?? t.unavailable);
      return;
    }
    if (!assessProjectRuntime(next.source.files).staticBuild.supported) return;
    currentRun.current?.controller.abort();
    const run: BuildRun = {
      controller: new AbortController(),
      source: next.source,
      busy: true,
    };
    currentRun.current = run;
    setArtifact(undefined);
    setPhase("building");
    setError("");
    setStatus(t.preparing);
    try {
      const { buildStaticDeployment } = await import("../../lib/project-build");
      run.controller.signal.throwIfAborted();
      const result = await buildStaticDeployment({
        files: run.source.files,
        assets: run.source.assets,
        signal: run.controller.signal,
        onProgress: (message) => {
          if (currentRun.current === run && !run.controller.signal.aborted)
            setStatus(message);
        },
      });
      if (!run.source.isCurrent()) run.controller.abort();
      run.controller.signal.throwIfAborted();
      if (currentRun.current !== run) return;
      setArtifact({ blob: result.blob, fileName: `website${Date.now()}.zip` });
      setPhase("ready");
      setStatus(t.ready);
    } catch (reason) {
      if (currentRun.current !== run) return;
      if (run.controller.signal.aborted) {
        setPhase("cancelled");
        setStatus("");
      } else {
        setPhase("idle");
        setError(
          `${t.failed}: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    } finally {
      run.busy = false;
    }
  }

  async function download(): Promise<void> {
    const run = currentRun.current;
    if (!artifact || !run || run.busy) return;
    if (!run.source.isCurrent()) {
      cancel();
      return;
    }
    run.busy = true;
    setPhase("saving");
    setError("");
    try {
      // This static import reaches the Web picker in the same click activation.
      const saved = await saveProjectArchive(artifact.blob, artifact.fileName, {
        preferFilePicker: true,
        signal: run.controller.signal,
      });
      if (currentRun.current === run && !run.controller.signal.aborted) {
        setStatus(saved ? t.ready : t.saveCancelled);
      }
    } catch (reason) {
      if (currentRun.current === run && !run.controller.signal.aborted) {
        setError(
          `${t.downloadFailed}: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    } finally {
      run.busy = false;
      if (currentRun.current === run && !run.controller.signal.aborted)
        setPhase("ready");
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>
            {capabilities?.template === "static"
              ? t.deployment
              : t.compatibility}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {!resolved.source && (
            <p role="alert" className="text-sm text-destructive">
              {resolved.error ?? t.unavailable}
            </p>
          )}
          {capabilities && !capabilities.staticBuild.supported && (
            <p className="text-sm text-muted-foreground">
              {capabilities.staticBuild.reason}
            </p>
          )}
          {(phase === "cancelled" || status) && (
            <p
              role="status"
              className="whitespace-pre-wrap break-words text-sm"
            >
              {phase === "cancelled" ? t.cancelled : status}
            </p>
          )}
          {artifact && (
            <p className="break-all text-sm text-muted-foreground">
              {artifact.fileName}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="whitespace-pre-wrap break-words text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            onClick={phase === "building" ? cancel : close}
          >
            {phase === "building" ? t.cancel : t.close}
          </Button>
          <Button
            disabled={
              phase === "building" ||
              phase === "saving" ||
              !capabilities?.staticBuild.supported ||
              (target.kind === "current" && isGenerating)
            }
            onClick={() => void (artifact ? download() : build())}
          >
            {phase === "saving"
              ? t.saving
              : artifact
                ? t.downloadDeployment
                : t.start}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
