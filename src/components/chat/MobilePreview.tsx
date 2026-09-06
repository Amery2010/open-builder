import { SandpackProvider, SandpackPreview } from "@codesandbox/sandpack-react";
import type { SandpackPredefinedTemplate } from "@codesandbox/sandpack-react";
import { useTheme } from "../../hooks/useTheme";
import type { ProjectAssets, ProjectFiles } from "../../types";
import { useEffect, useMemo, useState } from "react";
import { projectFilesForPreview } from "../../lib/utils/project-file-policy";
import { useT } from "../../i18n";
import { SandpackRefreshAction } from "../code-viewer/SandpackPreviewActions";
import { useConversationStore } from "../../store/conversation";
import { projectFilesForSandpack } from "../../lib/project-assets/core";

const EMPTY_PROJECT_ASSETS: ProjectAssets = {};

interface MobilePreviewProps {
  files: ProjectFiles;
  template: string;
  sandpackKey: number;
  onReloadPreview: () => void;
}

export function MobilePreview({
  files,
  template,
  sandpackKey,
}: MobilePreviewProps) {
  const t = useT();
  const isDark = useTheme();
  const assets = useConversationStore((state) => {
    const active = state.activeId
      ? state.conversations[state.activeId]
      : undefined;
    return active?.assets ?? EMPTY_PROJECT_ASSETS;
  });
  const previewFiles = useMemo(() => projectFilesForPreview(files), [files]);
  const [assetPreviewFiles, setAssetPreviewFiles] =
    useState<ProjectFiles>(previewFiles);
  useEffect(() => {
    let cancelled = false;
    setAssetPreviewFiles(previewFiles);
    void projectFilesForSandpack(previewFiles, assets).then(
      (derived) => {
        if (!cancelled) setAssetPreviewFiles(derived);
      },
      () => {
        if (!cancelled) setAssetPreviewFiles(previewFiles);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [assets, previewFiles]);
  const sandpackFiles = useMemo(() => {
    return Object.fromEntries(
      Object.entries(assetPreviewFiles).map(([path, content]) => [
        path.startsWith("/") ? path : `/${path}`,
        { code: content },
      ]),
    );
  }, [assetPreviewFiles]);

  return (
    <div className="editor border rounded-lg min-h-160 overflow-hidden bg-background">
      <SandpackProvider
        key={sandpackKey}
        template={template as SandpackPredefinedTemplate}
        theme={isDark ? "dark" : "light"}
        files={sandpackFiles}
      >
        <SandpackPreview
          showNavigator
          showOpenInCodeSandbox={false}
          showRefreshButton={false}
          showRestartButton={false}
          actionsChildren={
            <SandpackRefreshAction label={t.toolbar.reloadPreview} />
          }
          style={{ height: 640 }}
        />
      </SandpackProvider>
    </div>
  );
}
