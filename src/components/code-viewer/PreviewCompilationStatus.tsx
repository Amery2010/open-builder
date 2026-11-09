import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { toast, type ExternalToast } from "sonner";
import { useT } from "../../i18n";
import type { ProjectFiles } from "../../types";
import {
  SandpackRuntimeSync,
  type SandpackCompilationState,
  type SandpackRuntimeSyncHandle,
} from "./SandpackRuntimeSync";

interface PreviewCompilationStatusProps {
  identity: string;
  files: ProjectFiles;
  hidden?: boolean;
  onRuntimeChange: (handle: SandpackRuntimeSyncHandle | null) => void;
  onRetry: () => void;
}

/** Observes the editor's existing client; it never starts a verification runtime. */
export function PreviewCompilationStatus({
  identity,
  files,
  hidden = false,
  onRuntimeChange,
  onRetry,
}: PreviewCompilationStatusProps) {
  const t = useT();
  const toastId = useId();
  const scope = useMemo(() => ({ identity, files }), [identity, files]);
  const [observed, setObserved] = useState<{
    scope: typeof scope;
    state: SandpackCompilationState;
  } | null>(null);
  const state: SandpackCompilationState =
    observed?.scope === scope ? observed.state : { status: "starting" };
  const attempt = useMemo(
    () => ({ scope, runtime: state.runtime }),
    [scope, state.runtime],
  );
  const [expiredAttempt, setExpiredAttempt] = useState<typeof attempt | null>(
    null,
  );
  const observe = useCallback(
    (next: SandpackCompilationState) => {
      setObserved((previous) =>
        previous?.scope === scope &&
        previous.state.status === next.status &&
        previous.state.runtime === next.runtime &&
        previous.state.detail === next.detail
          ? previous
          : { scope, state: next },
      );
    },
    [scope],
  );
  const settled =
    state.status === "ready" ||
    state.status === "synced" ||
    state.status === "failed";
  useEffect(() => {
    if (settled) {
      setExpiredAttempt(null);
      return;
    }
    const timer = setTimeout(() => setExpiredAttempt(attempt), 90_000);
    return () => clearTimeout(timer);
  }, [attempt, settled]);
  const status =
    !settled && expiredAttempt === attempt ? "timedOut" : state.status;
  const canRetry = status === "timedOut" || status === "failed";

  useEffect(
    () => () => {
      toast.dismiss(toastId);
    },
    [toastId],
  );
  useEffect(() => {
    if (hidden) {
      toast.dismiss(toastId);
      return;
    }
    const options: ExternalToast = {
      id: toastId,
      duration: canRetry || !settled ? Infinity : 4_000,
      description:
        status === "failed" && state.detail ? (
          <details>
            <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
              {t.previewCompilation.details}
            </summary>
            <p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono">
              {state.detail}
            </p>
          </details>
        ) : undefined,
      action: canRetry
        ? { label: t.previewCompilation.retry, onClick: onRetry }
        : undefined,
    };
    const notify =
      status === "failed"
        ? toast.error
        : status === "timedOut"
          ? toast.warning
          : settled
            ? toast.success
            : toast.loading;
    notify(t.previewCompilation[status], options);
  }, [
    toastId,
    hidden,
    status,
    state.detail,
    canRetry,
    settled,
    onRetry,
    t.previewCompilation,
  ]);

  return (
    <SandpackRuntimeSync
      onChange={onRuntimeChange}
      expectedFiles={files}
      onCompilationChange={observe}
    />
  );
}

export function CodeOnlyPreviewNotice({ reason }: { reason?: string }) {
  const t = useT();
  const toastId = useId();
  useEffect(() => {
    toast.info(t.previewCompilation.codeOnly, {
      id: toastId,
      duration: 8_000,
      description: (
        <>
          <p>{t.previewCompilation.codeOnlyHint}</p>
          {reason && (
            <details className="mt-2">
              <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                {t.previewCompilation.details}
              </summary>
              <p className="mt-2 break-words">{reason}</p>
            </details>
          )}
        </>
      ),
    });
  }, [reason, t.previewCompilation, toastId]);
  useEffect(
    () => () => {
      toast.dismiss(toastId);
    },
    [toastId],
  );
  return null;
}
