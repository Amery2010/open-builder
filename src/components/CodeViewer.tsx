import { 
  SandpackProvider, 
  SandpackLayout, 
  SandpackCodeEditor, 
  SandpackPreview,
  SandpackFileExplorer,
  useSandpack
} from "@codesandbox/sandpack-react";
import { useState, useEffect, useMemo } from "react";
import { Eye, Code2, Monitor, Smartphone, Tablet } from "lucide-react";
import { cn } from "../lib/utils";

interface CodeViewerProps {
  code: string;
  onCodeChange: (code: string) => void;
}

function CodeUpdater({ onCodeChange }: { onCodeChange: (code: string) => void }) {
  const { sandpack } = useSandpack();
  const { files, activeFile } = sandpack;
  const code = files[activeFile]?.code;
  
  // Debounce the update to avoid performance issues and cursor jumps
  useEffect(() => {
    // Only sync back if we are editing the main file
    if (activeFile !== "/App.tsx") return;

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
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [deviceSize, setDeviceSize] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  
  const files = useMemo(() => ({
    "/App.js": code,
    "/index.js": `import { StrictMode } from "react";\nimport { createRoot } from \'react-dom/client\';\nimport "./styles.css";\n\nimport App from "./App";\n\nconst container = document.getElementById("app");\nconst root = createRoot(container);\nroot.render(\n  <StrictMode>\n    <App />\n </StrictMode>\n);`,
    "/styles.css": `body {\n  min-height: 100vh;\n  margin: 0;\n  font-family: sans-serif;\n  -webkit-font-smoothing: auto;\n  -moz-font-smoothing: auto;\n  -moz-osx-font-smoothing: grayscale;\n  font-smoothing: auto;\n  text-rendering: optimizeLegibility;\n  font-smooth: always;\n  -webkit-tap-highlight-color: transparent;\n  -webkit-touch-callout: none;\n}\n\nh1 {\n  font-size: 1.5rem;\n}\n\n#app {\n  min-height: 100vh;\n}\n\n#app > div {\n  min-height: calc(100vh);\n}`,
    "/public/index.html": `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>Document</title>\n  </head>\n  <body>\n    <div id="app"></div>\n  </body>\n</html>`,
  }), [code]);

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Toolbar */}
      <div className="h-14 border-b border-gray-200 bg-white px-4 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
          <button
            onClick={() => setViewMode('preview')}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
              viewMode === 'preview' 
                ? "bg-white text-gray-900 shadow-sm" 
                : "text-gray-500 hover:text-gray-700"
            )}
          >
            <Eye size={16} />
            Preview
          </button>
          <button
            onClick={() => setViewMode('code')}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
              viewMode === 'code' 
                ? "bg-white text-gray-900 shadow-sm" 
                : "text-gray-500 hover:text-gray-700"
            )}
          >
            <Code2 size={16} />
            Code
          </button>
        </div>

        <div className="flex items-center gap-2">
          {viewMode === 'preview' && (
            <div className="flex items-center gap-1 text-gray-400 mr-2">
              <button
                onClick={() => setDeviceSize('desktop')}
                className={cn(
                  "p-2 rounded-md transition-colors",
                  deviceSize === 'desktop' ? "text-blue-600 bg-blue-50" : "hover:text-gray-600"
                )}
                title="Desktop view"
              >
                <Monitor size={18} />
              </button>
              <button
                onClick={() => setDeviceSize('tablet')}
                className={cn(
                  "p-2 rounded-md transition-colors",
                  deviceSize === 'tablet' ? "text-blue-600 bg-blue-50" : "hover:text-gray-600"
                )}
                title="Tablet view"
              >
                <Tablet size={18} />
              </button>
              <button
                onClick={() => setDeviceSize('mobile')}
                className={cn(
                  "p-2 rounded-md transition-colors",
                  deviceSize === 'mobile' ? "text-blue-600 bg-blue-50" : "hover:text-gray-600"
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
      <div className="flex-1 overflow-hidden relative bg-gray-100/50">
        <SandpackProvider
          style={{ height: '100%' }}
          template="react"
          theme="light"
          files={files}
          options={{
            activeFile: "/App.js",
            classes: {
              "sp-wrapper": "block",
              "sp-layout": "flex flex-col md:flex-row",
              "sp-stack": "h-full",
            }
          }}
        >
          <CodeUpdater onCodeChange={onCodeChange} />
          <SandpackLayout className="h-full w-full block border-none bg-transparent">
            
            <div className={cn(
              "h-full w-full transition-all duration-300 mx-auto",
              viewMode === 'preview' ? "block" : "hidden",
              deviceSize === 'tablet' ? "max-w-[768px] my-4 shadow-lg border border-gray-200 rounded-lg overflow-hidden bg-white h-[calc(100%-2rem)]" : "",
              deviceSize === 'mobile' ? "max-w-[375px] my-4 shadow-lg border border-gray-200 rounded-lg overflow-hidden bg-white h-[calc(100%-2rem)]" : "",
              deviceSize === 'desktop' ? "max-w-full h-full" : ""
            )}>
              <SandpackPreview 
                showNavigator={false} 
                showOpenInCodeSandbox={false} 
                showRefreshButton={true}
                className="h-full w-full"
                style={{ height: '100%' }}
              />
            </div>

            <div className={cn(
              "h-full w-full flex",
              viewMode === 'code' ? "flex" : "hidden"
            )}>
              <div className="w-60 border-r border-gray-200 h-full bg-white shrink-0 overflow-hidden flex flex-col">
                 <SandpackFileExplorer autoHiddenFiles={true} />
              </div>
              <div className="flex-1 h-full overflow-hidden min-w-0">
                <SandpackCodeEditor 
                  showTabs={false} 
                  showLineNumbers={true} 
                  showInlineErrors={true} 
                  wrapContent={false} 
                  closableTabs={false}
                  className="h-full w-full"
                  style={{ height: '100%', width: '100%', overflowX: 'auto' }}
                />
              </div>
            </div>

          </SandpackLayout>
        </SandpackProvider>
      </div>
    </div>
  );
}
