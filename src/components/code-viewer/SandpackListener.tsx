import { useEffect } from "react";
import { useSandpack } from "@codesandbox/sandpack-react";

interface SandpackListenerProps {
  onFileChange: (path: string, content: string) => void;
}

export function SandpackListener({ onFileChange }: SandpackListenerProps) {
  const { sandpack } = useSandpack();
  const { files, activeFile } = sandpack;
  const code = files[activeFile]?.code;

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

  return null;
}
