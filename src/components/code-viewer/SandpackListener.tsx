import { useEffect } from "react";
import { useSandpack, useSandpackConsole } from "@codesandbox/sandpack-react";
import { useSandpackStore } from "../../store/sandpack";

interface SandpackListenerProps {
  onFileChange: (path: string, content: string) => void;
}

export function SandpackListener({ onFileChange }: SandpackListenerProps) {
  const { sandpack } = useSandpack();
  const { files, activeFile } = sandpack;
  const code = files[activeFile]?.code;
  const { logs } = useSandpackConsole({
    resetOnPreviewRestart: true,
    showSyntaxError: true,
  });
  const setConsoleLogs = useSandpackStore((s) => s.setConsoleLogs);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (code && activeFile) {
        const normalizedPath = activeFile.startsWith("/")
          ? activeFile.slice(1)
          : activeFile;
        onFileChange(normalizedPath, code);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [code, activeFile, onFileChange]);

  useEffect(() => {
    setConsoleLogs(logs);
  }, [logs, setConsoleLogs]);

  return null;
}
