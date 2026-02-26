import { useState } from "react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
  SandpackConsole,
} from "@codesandbox/sandpack-react";
import type { SandpackPredefinedTemplate } from "@codesandbox/sandpack-react";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SandpackListener } from "./code-viewer/SandpackListener";
import { ViewToolbar } from "./code-viewer/ViewToolbar";
import { FileExplorer } from "./code-viewer/FileExplorer";
import type { ViewMode, DeviceSize } from "./code-viewer/ViewToolbar";
import type { ProjectFiles } from "../types";

interface CodeViewerProps {
  files: ProjectFiles;
  currentFile: string;
  onFileSelect: (path: string) => void;
  onFileChange: (path: string, content: string) => void;
  template: string;
  sandpackKey: number;
}

export function CodeViewer({
  files,
  currentFile,
  onFileSelect,
  onFileChange,
  template,
  sandpackKey,
}: CodeViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [deviceSize, setDeviceSize] = useState<DeviceSize>("desktop");
  const [showConsole, setShowConsole] = useState(false);

  const sandpackFiles = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path.startsWith("/") ? path : `/${path}`,
      { code: content },
    ]),
  );

  const sandpackCurrentFile = currentFile.startsWith("/")
    ? currentFile
    : `/${currentFile}`;

  const handleCreateFile = (path: string) => {
    const p = path.startsWith("/") ? path.slice(1) : path;
    if (!files[p]) {
      onFileChange(p, "// New file\n");
      onFileSelect(p);
    }
  };

  const handleCreateFolder = (path: string) => {
    const p = path.startsWith("/") ? path.slice(1) : path;
    if (!files[`${p}/.gitkeep`]) onFileChange(`${p}/.gitkeep`, "");
  };

  return (
    <div className="editor h-full flex flex-col bg-background">
      <ViewToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        deviceSize={deviceSize}
        onDeviceSizeChange={setDeviceSize}
        files={files}
      />

      <div className="flex-1 overflow-hidden relative bg-muted/50">
        <SandpackProvider
          key={sandpackKey}
          template={template as SandpackPredefinedTemplate}
          theme="light"
          files={sandpackFiles}
          options={{ activeFile: sandpackCurrentFile }}
          style={{ height: "100%" }}
        >
          <SandpackListener onFileChange={onFileChange} />
          <SandpackLayout>
            {/* Preview */}
            <div
              className={cn(
                "transition-all duration-300 mx-auto",
                viewMode === "preview" ? "block" : "hidden",
                deviceSize === "desktop" && "w-full h-full",
                deviceSize !== "desktop" &&
                  "my-4 shadow-lg border rounded-lg overflow-hidden bg-background",
              )}
              style={
                deviceSize === "tablet"
                  ? { width: 768, height: 1024, maxHeight: "calc(100% - 2rem)" }
                  : deviceSize === "mobile"
                    ? {
                        width: 375,
                        height: 667,
                        maxHeight: "calc(100% - 2rem)",
                      }
                    : { height: "100%" }
              }
            >
              <div className="grid grid-rows-3 h-full">
                <div
                  className={cn(
                    "transition-all duration-300 ease-in-out",
                    showConsole ? "row-span-2" : "row-span-3",
                  )}
                >
                  <SandpackPreview
                    showNavigator
                    showOpenInCodeSandbox={false}
                    showRefreshButton
                    actionsChildren={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-7 h-7 rounded-full bg-(--sp-colors-surface2) text-(--sp-colors-clickable) hover:bg-(--sp-colors-surface3) hover:text-(--sp-colors-hover) cursor-pointer"
                        onClick={() => setShowConsole(!showConsole)}
                        title={showConsole ? "隐藏控制台" : "显示控制台"}
                      >
                        <Terminal size={16} />
                      </Button>
                    }
                  />
                </div>
                <div
                  className={cn(
                    "overflow-hidden border-t",
                    showConsole ? "row-span-1" : "max-h-0 border-t-0",
                  )}
                >
                  <SandpackConsole />
                </div>
              </div>
            </div>

            {/* Code editor */}
            <div
              className={cn(
                "h-full w-full overflow-hidden",
                viewMode === "code" ? "flex" : "hidden",
              )}
            >
              <div className="w-56 border-r h-full shrink-0 overflow-hidden flex flex-col">
                <FileExplorer
                  files={files}
                  currentFile={currentFile}
                  onFileSelect={onFileSelect}
                  onCreateFile={handleCreateFile}
                  onCreateFolder={handleCreateFolder}
                />
              </div>
              <div className="flex flex-col flex-1 h-full overflow-x-auto min-w-0">
                <SandpackCodeEditor
                  showTabs={false}
                  showLineNumbers
                  showInlineErrors
                  wrapContent={false}
                  closableTabs={false}
                />
              </div>
            </div>
          </SandpackLayout>
        </SandpackProvider>
      </div>
    </div>
  );
}
