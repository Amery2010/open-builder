import { useState, useCallback } from "react";
import { loadSettings, saveSettings, isSettingsValid } from "../lib/settings";
import type { Message, ProjectFiles, AISettings } from "../types";

export function useAppState() {
  const [files, setFiles] = useState<ProjectFiles>({});
  const [currentFile, setCurrentFile] = useState("src/App.tsx");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [settings, setSettings] = useState<AISettings>(loadSettings);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [template, setTemplate] = useState<string>("vite-react-ts");
  const [sandpackKey, setSandpackKey] = useState(0);
  const [isProjectInitialized, setIsProjectInitialized] = useState(false);

  const hasValidSettings = isSettingsValid(settings);

  const handleSaveSettings = (next: AISettings) => {
    setSettings(next);
    saveSettings(next);
  };

  const restartSandpack = useCallback(() => {
    setSandpackKey((k) => k + 1);
  }, []);

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
    template,
    setTemplate,
    sandpackKey,
    restartSandpack,
    isProjectInitialized,
    setIsProjectInitialized,
  };
}
