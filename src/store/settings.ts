import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AISettings {
  apiKey: string;
  apiUrl: string;
  model: string;
}

export interface WebSearchSettings {
  tavilyApiKey: string;
  tavilyApiUrl: string;
}

interface SettingsState {
  ai: AISettings;
  webSearch: WebSearchSettings;

  setAI: (settings: AISettings) => void;
  setWebSearch: (settings: WebSearchSettings) => void;
  isAIValid: () => boolean;
  isWebSearchConfigured: () => boolean;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ai: {
        apiKey: "",
        apiUrl: "https://api.openai.com/v1/chat/completions",
        model: "gpt-5.3-codex",
      },
      webSearch: {
        tavilyApiKey: "",
        tavilyApiUrl: "https://api.tavily.com",
      },

      setAI: (settings) => set({ ai: settings }),
      setWebSearch: (settings) => set({ webSearch: settings }),

      isAIValid: () => {
        const { ai } = get();
        return !!(ai.apiKey && ai.apiUrl && ai.model);
      },

      isWebSearchConfigured: () => {
        return !!get().webSearch.tavilyApiKey;
      },
    }),
    {
      name: "open-builder-settings",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        ai: state.ai,
        webSearch: state.webSearch,
      }),
    },
  ),
);
