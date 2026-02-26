import { useState, useCallback } from "react";
import { useSettingsStore } from "../store/settings";
import { useConversationStore } from "../store/conversation";
import type { Message, ProjectFiles } from "../types";

// Stable default references to avoid infinite re-render with useSyncExternalStore
const EMPTY_FILES: ProjectFiles = {};
const EMPTY_MESSAGES: Message[] = [];
const DEFAULT_TEMPLATE = "vite-react-ts";

export function useAppState() {
  // ── Conversation state from zustand ──
  const activeConv = useConversationStore((s) =>
    s.activeId ? (s.conversations[s.activeId] ?? null) : null,
  );
  const files = activeConv?.files ?? EMPTY_FILES;
  const messages = activeConv?.messages ?? EMPTY_MESSAGES;
  const template = activeConv?.template ?? DEFAULT_TEMPLATE;
  const isProjectInitialized = activeConv?.isProjectInitialized ?? false;

  const setMessages = useConversationStore((s) => s.setMessages);
  const setFiles = useConversationStore((s) => s.setFiles);
  const setTemplate = useConversationStore((s) => s.setTemplate);
  const setIsProjectInitialized = useConversationStore(
    (s) => s.setIsProjectInitialized,
  );

  // ── Settings state from zustand ──
  const settings = useSettingsStore((s) => s.ai);
  const webSearchSettings = useSettingsStore((s) => s.webSearch);
  const setAI = useSettingsStore((s) => s.setAI);
  const setWebSearch = useSettingsStore((s) => s.setWebSearch);
  const isAIValid = useSettingsStore((s) => s.isAIValid);

  const hasValidSettings = isAIValid();

  const handleSaveSettings = setAI;
  const handleSaveWebSearchSettings = setWebSearch;

  // ── Ephemeral UI state ──
  const [currentFile, setCurrentFile] = useState("src/App.tsx");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [sandpackKey, setSandpackKey] = useState(0);

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
    webSearchSettings,
    handleSaveWebSearchSettings,
    template,
    setTemplate,
    sandpackKey,
    restartSandpack,
    isProjectInitialized,
    setIsProjectInitialized,
  };
}
