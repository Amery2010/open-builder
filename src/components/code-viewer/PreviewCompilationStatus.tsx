import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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

  return (
    <>
      <SandpackRuntimeSync
        onChange={onRuntimeChange}
        expectedFiles={files}
        onCompilationChange={observe}
      />
      {!hidden && (
        <div
          data-preview-compilation={status}
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-3 py-2 text-xs text-muted-foreground"
        >
          <span role="status" aria-live="polite" className="min-w-0 flex-1">
            {t.previewCompilation[status]}
          </span>
          {state.status === "failed" && state.detail && (
            <details className="max-w-full">
              <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                {t.previewCompilation.details}
              </summary>
              <p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-destructive">
                {state.detail}
              </p>
            </details>
          )}
          {canRetry && (
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              {t.previewCompilation.retry}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

export function CodeOnlyPreviewNotice({ reason }: { reason?: string }) {
  const t = useT();
  return (
    <div className="shrink-0 border-b bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">
        {t.previewCompilation.codeOnly}
      </p>
      <p className="mt-1">{t.previewCompilation.codeOnlyHint}</p>
      {reason && (
        <details className="mt-2">
          <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
            {t.previewCompilation.details}
          </summary>
          <p className="mt-2 break-words">{reason}</p>
        </details>
      )}
    </div>
  );
}
