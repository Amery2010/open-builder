import { SandpackProvider, SandpackPreview } from "@codesandbox/sandpack-react";
import type { SandpackPredefinedTemplate } from "@codesandbox/sandpack-react";
import { useTheme } from "../../hooks/useTheme";
import type { ProjectAssets, ProjectFiles } from "../../types";
import { useEffect, useMemo, useRef, useState } from "react";
import { projectFilesForPreview } from "../../lib/utils/project-file-policy";
import { projectSandpackRuntime } from "../code-viewer/sandpack-runtime-preview";
import { projectReactPreview } from "../code-viewer/sandpack-react-preview";
import { useT } from "../../i18n";
import { SandpackRefreshAction } from "../code-viewer/SandpackPreviewActions";
import {
  PreviewErrorBoundary,
  type PreviewErrorBoundaryFallbackProps,
} from "../code-viewer/PreviewErrorBoundary";
import { Button } from "../ui/button";
import { useConversationStore } from "../../store/conversation";
import { projectFilesForSandpack } from "../../lib/project-assets/core";
import { SandpackRuntimeSync } from "../code-viewer/SandpackRuntimeSync";

const EMPTY_PROJECT_ASSETS: ProjectAssets = {};

interface MobilePreviewProps {
  files: ProjectFiles;
  template: string;
  sandpackKey: number;
  onReloadPreview: () => void;
}

function MobilePreviewError({
  error,
  onRetry,
}: PreviewErrorBoundaryFallbackProps & { onRetry: () => void }) {
  const t = useT();
  const detail = error.message.trim().slice(0, 300);

  return (
    <div
      className="flex h-160 flex-col items-center justify-center gap-3 bg-background p-6 text-center"
      role="alert"
      aria-live="assertive"
    >
      <h2 className="text-sm font-semibold text-foreground">
        {t.previewRecovery.unavailableTitle}
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {t.previewRecovery.mobileRenderDescription}
      </p>
      {detail && (
        <p className="max-w-md break-words font-mono text-xs text-destructive">
          {detail}
        </p>
      )}
      <Button type="button" variant="outline" onClick={onRetry}>
        {t.previewRecovery.retry}
      </Button>
    </div>
  );
}

export function MobilePreview({
  files,
  template,
  sandpackKey,
  onReloadPreview,
}: MobilePreviewProps) {
  const t = useT();
  const isDark = useTheme();
  const conversationId = useConversationStore((state) => state.activeId);
  const assets = useConversationStore((state) => {
    const active = state.activeId
      ? state.conversations[state.activeId]
      : undefined;
    return active?.assets ?? EMPTY_PROJECT_ASSETS;
  });
  const previewFiles = useMemo(() => projectFilesForPreview(files), [files]);
  const [assetPreviewFiles, setAssetPreviewFiles] =
    useState<ProjectFiles>(previewFiles);
  const [assetProjectionStatus, setAssetProjectionStatus] = useState<
    "loading" | "ready" | "error"
  >(() => (Object.keys(assets).length > 0 ? "loading" : "ready"));
  const [assetProjectionError, setAssetProjectionError] = useState<
    string | null
  >(null);
  const [assetProjectionRetry, setAssetProjectionRetry] = useState(0);
  const [renderRetry, setRenderRetry] = useState(0);
  const boundaryResetKey = useMemo(
    () => ({ files, renderRetry, sandpackKey }),
    [files, renderRetry, sandpackKey],
  );
  const projectedRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setAssetProjectionError(null);
    if (Object.keys(assets).length === 0) {
      projectedRef.current = conversationId;
      setAssetPreviewFiles(previewFiles);
      setAssetProjectionStatus("ready");
      return () => {
        cancelled = true;
      };
    }
    if (projectedRef.current !== conversationId)
      setAssetProjectionStatus("loading");
    void projectFilesForSandpack(previewFiles, assets).then(
      (derived) => {
        if (cancelled) return;
        projectedRef.current = conversationId;
        setAssetPreviewFiles(derived);
        setAssetProjectionStatus("ready");
      },
      (error) => {
        if (cancelled) return;
        setAssetProjectionError(
          error instanceof Error ? error.message : String(error),
        );
        setAssetProjectionStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [assetProjectionRetry, assets, conversationId, previewFiles]);
  const reactPreviewProjection = useMemo(
    () =>
      projectReactPreview(
        assetPreviewFiles,
        projectSandpackRuntime(assetPreviewFiles, true, template).files,
        template,
      ),
    [assetPreviewFiles, template],
  );
  const sandpackFiles = useMemo(() => {
    return Object.fromEntries(
      Object.entries(reactPreviewProjection.files).map(([path, content]) => [
        path.startsWith("/") ? path : `/${path}`,
        { code: content },
      ]),
    );
  }, [reactPreviewProjection.files]);

  return (
    <div className="editor border rounded-lg min-h-160 overflow-hidden bg-background">
      {assetProjectionStatus === "error" ? (
        <div
          className="flex h-160 flex-col items-center justify-center gap-3 bg-background p-6 text-center"
          role="alert"
          aria-live="assertive"
        >
          <h2 className="text-sm font-semibold text-foreground">
            {t.previewRecovery.unavailableTitle}
          </h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {t.previewRecovery.assetDescription}
          </p>
          {assetProjectionError && (
            <p className="max-w-md break-words font-mono text-xs text-destructive">
              {assetProjectionError.slice(0, 300)}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => setAssetProjectionRetry((attempt) => attempt + 1)}
          >
            {t.previewRecovery.retry}
          </Button>
        </div>
      ) : assetProjectionStatus === "loading" ? (
        <div
          className="flex h-160 items-center justify-center bg-background p-6 text-sm text-muted-foreground"
          role="status"
        >
          {t.previewRecovery.preparingAssets}
        </div>
      ) : (
        <PreviewErrorBoundary
          resetKey={boundaryResetKey}
          fallback={(props) => (
            <MobilePreviewError
              {...props}
              onRetry={() => {
                setRenderRetry((attempt) => attempt + 1);
                onReloadPreview();
              }}
            />
          )}
        >
          <SandpackProvider
            key={`${sandpackKey}:${renderRetry}:${reactPreviewProjection.sourceEntry ?? "node"}`}
            template={template as SandpackPredefinedTemplate}
            customSetup={reactPreviewProjection.customSetup}
            theme={isDark ? "dark" : "light"}
            files={sandpackFiles}
          >
            <SandpackRuntimeSync />
            <SandpackPreview
              showNavigator
              showOpenInCodeSandbox={false}
              showRefreshButton={false}
              showRestartButton={false}
              actionsChildren={
                <SandpackRefreshAction
                  label={t.toolbar.reloadPreview}
                  onReload={() => {
                    setRenderRetry((attempt) => attempt + 1);
                    onReloadPreview();
                  }}
                />
              }
              style={{ height: 640 }}
            />
          </SandpackProvider>
        </PreviewErrorBoundary>
      )}
    </div>
  );
}
