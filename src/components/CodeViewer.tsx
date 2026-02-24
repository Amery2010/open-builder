import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
  SandpackConsole,
  SandpackFileExplorer,
  useSandpack,
  SANDBOX_TEMPLATES,
} from "@codesandbox/sandpack-react";
import { useState, useEffect, useMemo } from "react";
import { Eye, Code2, Monitor, Smartphone, Tablet } from "lucide-react";
import { cn } from "../lib/utils";

interface CodeViewerProps {
  code: string;
  onCodeChange: (code: string) => void;
}

function CodeUpdater({
  onCodeChange,
}: {
  onCodeChange: (code: string) => void;
}) {
  const { sandpack } = useSandpack();
  const { files, activeFile } = sandpack;
  const code = files[activeFile]?.code;

  // Debounce the update to avoid performance issues and cursor jumps
  useEffect(() => {
    // Only sync back if we are editing the main file
    if (activeFile !== "/App.jsx") return;

    const timer = setTimeout(() => {
      if (code) {
        onCodeChange(code);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [code, activeFile, onCodeChange]);

  return null;
}

export function CodeViewer({ code, onCodeChange }: CodeViewerProps) {
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [deviceSize, setDeviceSize] = useState<"desktop" | "tablet" | "mobile">(
    "desktop",
  );

  const files = useMemo(
    () => ({
      ...SANDBOX_TEMPLATES["vite-react"].files,
      "/App.jsx": {
        code,
      },
      "/package.json": {
        code: JSON.stringify({
          scripts: {
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
          },
          dependencies: {
            react: "^19.2.0",
            "react-dom": "^19.2.0",
          },
          devDependencies: {
            "@vitejs/plugin-react": "3.1.0",
            vite: "4.1.4",
            "esbuild-wasm": "^0.27.3",
          },
        }),
      },
    }),
    [],
  );

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Toolbar */}
      <div className="h-14 border-b border-gray-200 bg-white px-4 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
          <button
            onClick={() => setViewMode("preview")}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
              viewMode === "preview"
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700",
            )}
          >
            <Eye size={16} />
            Preview
          </button>
          <button
            onClick={() => setViewMode("code")}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
              viewMode === "code"
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700",
            )}
          >
            <Code2 size={16} />
            Code
          </button>
        </div>

        <div className="flex items-center gap-2">
          {viewMode === "preview" && (
            <div className="flex items-center gap-1 text-gray-400 mr-2">
              <button
                onClick={() => setDeviceSize("desktop")}
                className={cn(
                  "p-2 rounded-md transition-colors",
                  deviceSize === "desktop"
                    ? "text-blue-600 bg-blue-50"
                    : "hover:text-gray-600",
                )}
                title="Desktop view"
              >
                <Monitor size={18} />
              </button>
              <button
                onClick={() => setDeviceSize("tablet")}
                className={cn(
                  "p-2 rounded-md transition-colors",
                  deviceSize === "tablet"
                    ? "text-blue-600 bg-blue-50"
                    : "hover:text-gray-600",
                )}
                title="Tablet view"
              >
                <Tablet size={18} />
              </button>
              <button
                onClick={() => setDeviceSize("mobile")}
                className={cn(
                  "p-2 rounded-md transition-colors",
                  deviceSize === "mobile"
                    ? "text-blue-600 bg-blue-50"
                    : "hover:text-gray-600",
                )}
                title="Mobile view"
              >
                <Smartphone size={18} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 w-[calc(100vw-400px)] overflow-hidden relative bg-gray-100/50">
        <SandpackProvider template="vite-react" theme="light" files={files}>
          <CodeUpdater onCodeChange={onCodeChange} />
          <SandpackLayout>
            <div
              className={cn(
                "h-full w-full transition-all duration-300 mx-auto",
                viewMode === "preview" ? "block" : "hidden",
                deviceSize === "tablet"
                  ? "max-w-[768px] my-4 shadow-lg border border-gray-200 rounded-lg overflow-hidden bg-white h-[calc(100%-2rem)]"
                  : "",
                deviceSize === "mobile"
                  ? "max-w-[375px] my-4 shadow-lg border border-gray-200 rounded-lg overflow-hidden bg-white h-[calc(100%-2rem)]"
                  : "",
                deviceSize === "desktop" ? "max-w-full h-full" : "",
              )}
            >
              <div className="flex flex-col h-full">
                <SandpackPreview
                  showNavigator={true}
                  showOpenInCodeSandbox={false}
                  showRefreshButton={true}
                />
                <SandpackConsole />
              </div>
            </div>

            <div
              className={cn(
                "h-full w-full overflow-hidden",
                viewMode === "code" ? "flex" : "hidden",
              )}
            >
              <div className="w-48 border-r border-gray-200 h-full bg-white shrink-0 overflow-hidden flex flex-col">
                <SandpackFileExplorer autoHiddenFiles={true} />
              </div>
              <div className="flex flex-col flex-1 h-full overflow-x-auto min-w-0">
                <SandpackCodeEditor
                  showTabs={false}
                  showLineNumbers={true}
                  showInlineErrors={true}
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
