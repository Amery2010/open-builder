import type { StateCreator } from "zustand";
import {
  DEFAULT_OPENAI_MODEL,
  type ApiType,
} from "../../lib/ai/provider-config";
import {
  queryLocalAgentSupport,
  resetLocalAgentSupportCache,
} from "../../lib/local-agent/tauri";
import type { LocalAgentProvider } from "../../lib/local-agent/providers";

export type GenerationRuntime = "api" | "localCli";
export type LocalAgentCapabilityStatus =
  "loading" | "supported" | "unsupported" | "error";

export interface LocalAgentProviderSettings {
  model: string;
  effort: string;
}

export interface LocalAgentSettings {
  provider: LocalAgentProvider;
  preferences: Record<LocalAgentProvider, LocalAgentProviderSettings>;
}

export interface AISettings {
  runtime: GenerationRuntime;
  apiType: ApiType;
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  localAgent: LocalAgentSettings;
}

export const aiDefaults: AISettings = {
  runtime: "api",
  apiType: "openai-compatible",
  apiKey: "",
  apiBaseUrl: "",
  model: DEFAULT_OPENAI_MODEL,
  localAgent: {
    provider: "codex",
    preferences: {
      codex: { model: "", effort: "" },
      claude: { model: "", effort: "" },
      pi: { model: "", effort: "" },
    },
  },
};

export interface ModelCache {
  models: string[];
  apiType: string;
  apiBaseUrl: string;
  apiKey: string;
}

export interface AISlice {
  ai: AISettings;
  modelCache: ModelCache | null;
  localAgentCapability: LocalAgentCapabilityStatus;
  setAI: (settings: AISettings) => void;
  setModelCache: (cache: ModelCache) => void;
  clearModelCache: () => void;
  refreshLocalAgentCapability: (
    force?: boolean,
  ) => Promise<LocalAgentCapabilityStatus>;
  isAIValid: () => boolean;
}

export const createAISlice: StateCreator<AISlice, [], [], AISlice> = (
  set,
  get,
) => {
  let capabilityRequestId = 0;

  return {
    ai: aiDefaults,
    modelCache: null,
    localAgentCapability: "loading",
    setAI: (settings) => {
      const normalized = {
        ...settings,
        apiBaseUrl: settings.apiBaseUrl.replace(/\/+$/, ""),
      };
      set({ ai: normalized });
    },
    setModelCache: (cache) => set({ modelCache: cache }),
    clearModelCache: () => set({ modelCache: null }),
    refreshLocalAgentCapability: async (force = false) => {
      const requestId = ++capabilityRequestId;
      if (force) resetLocalAgentSupportCache();
      set({ localAgentCapability: "loading" });
      try {
        const supported = await queryLocalAgentSupport();
        const status: LocalAgentCapabilityStatus = supported
          ? "supported"
          : "unsupported";
        if (requestId === capabilityRequestId) {
          set({ localAgentCapability: status });
        }
        return status;
      } catch {
        if (requestId === capabilityRequestId) {
          set({ localAgentCapability: "error" });
        }
        return "error";
      }
    },
    isAIValid: () => {
      const { ai, localAgentCapability } = get();
      if (ai.runtime === "localCli") {
        return localAgentCapability === "supported";
      }
      return !!(ai.apiKey && ai.apiBaseUrl && ai.model);
    },
  };
};
