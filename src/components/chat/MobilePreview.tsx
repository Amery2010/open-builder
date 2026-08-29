import { SandpackProvider, SandpackPreview } from "@codesandbox/sandpack-react";
import type { SandpackPredefinedTemplate } from "@codesandbox/sandpack-react";
import { useTheme } from "../../hooks/useTheme";
import type { ProjectFiles } from "../../types";
import { useMemo } from "react";
import { projectFilesForPreview } from "../../lib/utils/project-file-policy";
import { useT } from "../../i18n";
import { SandpackRefreshAction } from "../code-viewer/SandpackPreviewActions";

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
  const sandpackFiles = useMemo(() => {
    const previewFiles = projectFilesForPreview(files);
    return Object.fromEntries(
      Object.entries(previewFiles).map(([path, content]) => [
        path.startsWith("/") ? path : `/${path}`,
        { code: content },
      ]),
    );
  }, [files]);

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
