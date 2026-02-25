import { useState } from "react";
import { loadSettings, saveSettings, isSettingsValid } from "../lib/settings";
import { VITE_REACT_TYPESCRIPT_TEMPLATE } from "../lib/template";
import type { Message, ProjectFiles, AISettings } from "../types";

function initFiles(): ProjectFiles {
  return Object.fromEntries(
    Object.entries(VITE_REACT_TYPESCRIPT_TEMPLATE.files).map(([path, file]) => [
      path.startsWith("/") ? path.slice(1) : path,
      file.code,
    ]),
  );
}

export function useAppState() {
  const [files, setFiles] = useState<ProjectFiles>(initFiles);
  const [currentFile, setCurrentFile] = useState("src/App.tsx");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [settings, setSettings] = useState<AISettings>(loadSettings);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const hasValidSettings = isSettingsValid(settings);

  const handleSaveSettings = (next: AISettings) => {
    setSettings(next);
    saveSettings(next);
  };

  return {
    files,
    setFiles,
    currentFile,
    setCurrentFile,
    messages,
    setMessages,
    isGenerating,
    setIsGenerating,
    settings,
    hasValidSettings,
    isSettingsOpen,
    setIsSettingsOpen,
    handleSaveSettings,
  };
}
