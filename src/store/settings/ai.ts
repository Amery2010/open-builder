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
import type {
  LocalAgentProbe,
  LocalCliInspectionStatus,
  LocalCliUnavailableReason,
} from "../../lib/local-agent/types";

export type GenerationRuntime = "api" | "localCli";
export type LocalAgentCapabilityStatus =
  "loading" | "supported" | "unsupported" | "error";

/** Per-provider launch readiness. This is deliberately volatile: a CLI can be
 * changed or logged out outside Open Builder, so persisted settings never act
 * as proof that a future run is safe to start. */
export interface LocalAgentReadiness {
  status: LocalCliInspectionStatus;
  reasonCode?: LocalCliUnavailableReason;
  checkedAt?: number;
  probe?: LocalAgentProbe;
}

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
      antigravity: { model: "", effort: "" },
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
  localAgentReadiness: Partial<Record<LocalAgentProvider, LocalAgentReadiness>>;
  setAI: (settings: AISettings) => void;
  setModelCache: (cache: ModelCache) => void;
  clearModelCache: () => void;
  refreshLocalAgentCapability: (
    force?: boolean,
  ) => Promise<LocalAgentCapabilityStatus>;
  setLocalAgentProbe: (probe: LocalAgentProbe | null) => void;
  clearLocalAgentReadiness: (provider?: LocalAgentProvider) => void;
  isAIValid: () => boolean;
}

function readinessStatus(probe: LocalAgentProbe): LocalCliInspectionStatus {
  if (
    probe.status === "ready" ||
    probe.status === "verificationRequired" ||
    probe.status === "setupRequired" ||
    probe.status === "unavailable"
  ) {
    return probe.status;
  }
  switch (probe.availability) {
    case "ready":
      return "ready";
    case "needsSetup":
      return "setupRequired";
    case "notFound":
    case "unsupported":
    case "error":
      return "unavailable";
  }
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
    localAgentReadiness: {},
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
    setLocalAgentProbe: (probe) => {
      if (!probe) return;
      const status = readinessStatus(probe);
      set((state) => ({
        localAgentReadiness: {
          ...state.localAgentReadiness,
          [probe.provider]: {
            status,
            reasonCode: probe.reasonCode,
            checkedAt: probe.checkedAt,
            probe,
          },
        },
      }));
    },
    clearLocalAgentReadiness: (provider) => {
      if (!provider) {
        set({ localAgentReadiness: {} });
        return;
      }
      set((state) => {
        const next = { ...state.localAgentReadiness };
        delete next[provider];
        return { localAgentReadiness: next };
      });
    },
    isAIValid: () => {
      const { ai, localAgentCapability, localAgentReadiness } = get();
      if (ai.runtime === "localCli") {
        const readiness = localAgentReadiness[ai.localAgent.provider];
        return (
          localAgentCapability === "supported" &&
          (readiness?.status === "ready" ||
            readiness?.status === "verificationRequired")
        );
      }
      return !!(ai.apiKey && ai.apiBaseUrl && ai.model);
    },
  };
};
