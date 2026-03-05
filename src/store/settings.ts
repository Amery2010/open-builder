import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AISettings {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
}

export interface WebSearchSettings {
  engine: "tavily" | "firecrawl" | "disabled";
  tavilyApiKey: string;
  tavilyApiUrl: string;
  firecrawlApiKey: string;
  firecrawlApiUrl: string;
}

export interface AssetSearchSettings {
  engine: "pixabay" | "unsplash" | "disabled";
  pixabayApiKey: string;
  pixabayApiUrl: string;
  unsplashApiKey: string;
  unsplashApiUrl: string;
}

export type Language = "system" | "zh" | "en";
export type Theme = "system" | "light" | "dark";

export interface SystemSettings {
  language: Language;
  theme: Theme;
}

export interface ModelCache {
  models: string[];
  apiBaseUrl: string;
  apiKey: string;
}

interface SettingsState {
  ai: AISettings;
  webSearch: WebSearchSettings;
  assetSearch: AssetSearchSettings;
  system: SystemSettings;
  modelCache: ModelCache | null;

  setAI: (settings: AISettings) => void;
  setWebSearch: (settings: WebSearchSettings) => void;
  setAssetSearch: (settings: AssetSearchSettings) => void;
  setSystem: (settings: SystemSettings) => void;
  setModelCache: (cache: ModelCache) => void;
  clearModelCache: () => void;
  isAIValid: () => boolean;
  isWebSearchConfigured: () => boolean;
  isAssetSearchConfigured: () => boolean;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ai: {
        apiKey: "",
        apiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5.3-codex",
      },
      webSearch: {
        engine: "disabled",
        tavilyApiKey: "",
        tavilyApiUrl: "https://api.tavily.com",
        firecrawlApiKey: "",
        firecrawlApiUrl: "https://api.firecrawl.dev",
      },
      assetSearch: {
        engine: "disabled",
        pixabayApiKey: "",
        pixabayApiUrl: "https://pixabay.com/api",
        unsplashApiKey: "",
        unsplashApiUrl: "https://api.unsplash.com",
      },
      system: {
        language: "system" as Language,
        theme: "system" as Theme,
      },
      modelCache: null,

      setAI: (settings) =>
        set({
          ai: {
            ...settings,
            apiBaseUrl: settings.apiBaseUrl.replace(/\/+$/, ""),
          },
        }),
      setWebSearch: (settings) => set({ webSearch: settings }),
      setAssetSearch: (settings) => set({ assetSearch: settings }),
      setSystem: (settings) => set({ system: settings }),
      setModelCache: (cache) => set({ modelCache: cache }),
      clearModelCache: () => set({ modelCache: null }),

      isAIValid: () => {
        const { ai } = get();
        return !!(ai.apiKey && ai.apiBaseUrl && ai.model);
      },

      isWebSearchConfigured: () => {
        const { webSearch } = get();
        if (webSearch.engine === "disabled") return false;
        if (webSearch.engine === "tavily") return !!webSearch.tavilyApiKey;
        if (webSearch.engine === "firecrawl") return !!webSearch.firecrawlApiKey;
        return false;
      },

      isAssetSearchConfigured: () => {
        const { assetSearch } = get();
        if (assetSearch.engine === "disabled") return false;
        if (assetSearch.engine === "pixabay") return !!assetSearch.pixabayApiKey;
        if (assetSearch.engine === "unsplash") return !!assetSearch.unsplashApiKey;
        return false;
      },
    }),
    {
      name: "open-builder-settings",
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        ai: state.ai,
        webSearch: state.webSearch,
        assetSearch: state.assetSearch,
        system: state.system,
      }),
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, any>;
        if (version === 0 && state.ai?.apiUrl) {
          let baseUrl: string = state.ai.apiUrl;
          // Strip /chat/completions suffix (works with /v1, /v3, etc.)
          baseUrl = baseUrl.replace(/\/chat\/completions$/, "");
          state.ai.apiBaseUrl = baseUrl.replace(/\/+$/, "");
          delete state.ai.apiUrl;
        }
        if (version < 2) {
          if (!state.webSearch) state.webSearch = {};
          state.webSearch.engine = state.webSearch.tavilyApiKey ? "tavily" : "disabled";
          state.webSearch.firecrawlApiKey = "";
          state.webSearch.firecrawlApiUrl = "https://api.firecrawl.dev";
        }
        if (version < 3) {
          if (!state.assetSearch) {
            state.assetSearch = {
              engine: "disabled",
              pixabayApiKey: "",
              pixabayApiUrl: "https://pixabay.com/api",
              unsplashApiKey: "",
              unsplashApiUrl: "https://api.unsplash.com",
            };
          }
        }
        return state as any;
      },
    },
  ),
);
