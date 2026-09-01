import { useState, useCallback, useEffect } from "react";
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
  const previewMode = activeConv?.previewMode ?? "sandpack";
  const isProjectInitialized = activeConv?.isProjectInitialized ?? false;

  const setMessages = useConversationStore((s) => s.setMessages);
  const setFiles = useConversationStore((s) => s.setFiles);
  const setTemplate = useConversationStore((s) => s.setTemplate);
  const setCurrentFile = useConversationStore((s) => s.setActiveFile);
  const currentFile =
    activeConv?.activeFile && activeConv.activeFile in files
      ? activeConv.activeFile
      : (Object.keys(files)[0] ?? "src/App.tsx");

  // ── Settings state from zustand ──
  const settings = useSettingsStore((s) => s.ai);
  const webSearchSettings = useSettingsStore((s) => s.webSearch);
  const assetSearchSettings = useSettingsStore((s) => s.assetSearch);
  const systemSettings = useSettingsStore((s) => s.system);
  const setAI = useSettingsStore((s) => s.setAI);
  const setWebSearch = useSettingsStore((s) => s.setWebSearch);
  const setAssetSearch = useSettingsStore((s) => s.setAssetSearch);
  const setSystem = useSettingsStore((s) => s.setSystem);
  const isAIValid = useSettingsStore((s) => s.isAIValid);
  const localAgentCapability = useSettingsStore((s) => s.localAgentCapability);
  // Subscribe to volatile provider readiness so the send gate updates when a
  // Settings probe completes. The capability flag alone only describes the
  // desktop host, not the selected CLI's launch contract.
  const localAgentReadiness = useSettingsStore((s) => s.localAgentReadiness);
  const refreshLocalAgentCapability = useSettingsStore(
    (s) => s.refreshLocalAgentCapability,
  );

  useEffect(() => {
    if (localAgentCapability === "loading") {
      void refreshLocalAgentCapability();
    }
  }, [localAgentCapability, refreshLocalAgentCapability]);

  const hasValidSettings = isAIValid();

  const handleSaveSettings = setAI;
  const handleSaveWebSearchSettings = setWebSearch;
  const handleSaveAssetSearchSettings = setAssetSearch;
  const handleSaveSystemSettings = useCallback(
    (next: typeof systemSettings) => {
      setSystem(next);
      void import("../lib/infra/proxy").then(({ applyProxyPolicy }) => {
        applyProxyPolicy(next.reverseProxy, next.reverseProxyAllowedHosts);
      });
    },
    [setSystem],
  );

  // ── Ephemeral UI state ──
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
    localAgentReadiness,
    hasValidSettings,
    isSettingsOpen,
    setIsSettingsOpen,
    handleSaveSettings,
    webSearchSettings,
    handleSaveWebSearchSettings,
    assetSearchSettings,
    handleSaveAssetSearchSettings,
    systemSettings,
    handleSaveSystemSettings,
    template,
    previewMode,
    setTemplate,
    sandpackKey,
    restartSandpack,
    isProjectInitialized,
  };
}
