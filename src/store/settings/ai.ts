import type { StateCreator } from "zustand";
import {
  DEFAULT_OPENAI_MODEL,
  type ApiType,
} from "../../lib/ai/provider-config";
import {
  queryLocalAgentSupport,
  resetLocalAgentSupportCache,
} from "../../lib/local-agent/tauri";
import { localCliRuntime } from "../../lib/local-agent/runtime";
import {
  createEmptyLocalCliObservationCache,
  createLocalCliObservationCoordinator,
  type LocalCliObservationCache,
  type LocalCliObservationCoordinator,
  type PersistedLocalCliHostObservation,
  type PersistedLocalCliObservation,
} from "../../lib/local-agent/observations";
import {
  isLocalAgentProvider,
  type LocalAgentProvider,
} from "../../lib/local-agent/providers";
import type {
  LocalAgentPreference,
  LocalAgentProbe,
  LocalCliFailure,
  LocalCliPreparedMetadata,
} from "../../lib/local-agent/types";

export type GenerationRuntime = "api" | "localCli";

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
  /** Persisted display observations; never used as launch authority. */
  localCliObservationCache: LocalCliObservationCache;
  setAI: (settings: AISettings) => void;
  setModelCache: (cache: ModelCache) => void;
  clearModelCache: () => void;
  ensureLocalCliHostObservation: (
    forceRefresh?: boolean,
  ) => Promise<PersistedLocalCliHostObservation>;
  ensureLocalCliObservation: (
    provider: LocalAgentProvider,
    preference?: LocalAgentPreference,
    forceRefresh?: boolean,
  ) => Promise<PersistedLocalCliObservation | undefined>;
  refreshLocalCliObservation: (
    provider: LocalAgentProvider,
    preference?: LocalAgentPreference,
  ) => Promise<PersistedLocalCliObservation | undefined>;
  invalidateLocalCliObservation: (provider?: LocalAgentProvider) => void;
  mergeLocalCliPreparedMetadata: (
    provider: LocalAgentProvider,
    metadata: LocalCliPreparedMetadata,
  ) => void;
  mergeLocalCliFailure: (failure: LocalCliFailure) => void;
  recordLocalCliProbe: (
    probe: LocalAgentProbe,
    inspectedPreference?: LocalAgentPreference,
  ) => PersistedLocalCliObservation | undefined;
  markLocalCliPreferenceVerificationRequired: (
    provider: LocalAgentProvider,
  ) => void;
  isAIConfigured: () => boolean;
}

export const createAISlice: StateCreator<AISlice, [], [], AISlice> = (
  set,
  get,
) => {
  const observationCoordinator: LocalCliObservationCoordinator =
    createLocalCliObservationCoordinator(
      {
        get: () => get().localCliObservationCache,
        set: (cache) => set({ localCliObservationCache: cache }),
      },
      {
        queryHost: queryLocalAgentSupport,
        resetHostCache: resetLocalAgentSupportCache,
        inspectProvider: (provider, preference, forceRefresh) =>
          localCliRuntime.inspect({
            provider,
            preference,
            forceRefresh,
          }),
      },
    );

  const preferenceForProvider = (
    provider: LocalAgentProvider,
    settings = get().ai,
  ): LocalAgentPreference => settings.localAgent.preferences[provider];

  return {
    ai: aiDefaults,
    modelCache: null,
    localCliObservationCache: createEmptyLocalCliObservationCache(),
    setAI: (settings) => {
      const previous = get().ai;
      const normalized = {
        ...settings,
        apiBaseUrl: settings.apiBaseUrl.replace(/\/+$/, ""),
      };
      set({ ai: normalized });

      for (const provider of Object.keys(
        normalized.localAgent.preferences,
      ) as LocalAgentProvider[]) {
        const previousPreference = previous.localAgent.preferences[provider];
        const nextPreference = normalized.localAgent.preferences[provider];
        if (
          previousPreference.model !== nextPreference.model ||
          previousPreference.effort !== nextPreference.effort
        ) {
          observationCoordinator.markPreference(provider);
        }
      }
    },
    setModelCache: (cache) => set({ modelCache: cache }),
    clearModelCache: () => set({ modelCache: null }),
    ensureLocalCliHostObservation: (forceRefresh = false) =>
      observationCoordinator.ensureHost(forceRefresh),
    ensureLocalCliObservation: async (
      provider,
      preference,
      forceRefresh = false,
    ) => {
      const currentPreference = preference ?? preferenceForProvider(provider);
      const observation = await observationCoordinator.ensureProvider(
        provider,
        currentPreference,
        forceRefresh,
      );
      return observation;
    },
    refreshLocalCliObservation: (provider, preference) =>
      get().ensureLocalCliObservation(provider, preference, true),
    invalidateLocalCliObservation: (provider) => {
      observationCoordinator.invalidateProvider(provider);
    },
    mergeLocalCliPreparedMetadata: (provider, metadata) => {
      observationCoordinator.mergePrepared(
        provider,
        metadata,
        preferenceForProvider(provider),
      );
    },
    mergeLocalCliFailure: (failure) => {
      observationCoordinator.mergeFailure(failure);
    },
    recordLocalCliProbe: (probe, inspectedPreference) => {
      if (!probe || !isLocalAgentProvider(probe.provider)) return undefined;
      const preference =
        inspectedPreference ?? preferenceForProvider(probe.provider);
      return observationCoordinator.recordProbe(probe, preference);
    },
    markLocalCliPreferenceVerificationRequired: (provider) => {
      observationCoordinator.markPreference(provider);
    },
    isAIConfigured: () => {
      const { ai } = get();
      if (ai.runtime === "localCli") {
        return isLocalAgentProvider(ai.localAgent.provider);
      }
      return !!(ai.apiKey && ai.apiBaseUrl && ai.model);
    },
  };
};
