import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { type AISlice, aiDefaults, createAISlice } from "./ai";
import {
  type WebSearchSlice,
  webSearchDefaults,
  createWebSearchSlice,
} from "./web-search";
import {
  type AssetSearchSlice,
  assetSearchDefaults,
  createAssetSearchSlice,
} from "./asset-search";
import {
  type SystemSlice,
  systemDefaults,
  createSystemSlice,
  normalizeSystemSettings,
} from "./system";
import { SETTINGS_VERSION, migrateSettings } from "./migrations";
import {
  createEmptyLocalCliObservationCache,
  sanitizeLocalCliObservationCache,
} from "../../lib/local-agent/observations";

export type {
  AISettings,
  GenerationRuntime,
  LocalAgentProviderSettings,
  LocalAgentSettings,
  ModelCache,
} from "./ai";
export type {
  LocalCliObservationCache,
  PersistedLocalCliHostObservation,
  PersistedLocalCliObservation,
} from "../../lib/local-agent/observations";
export type { LocalAgentProvider } from "../../lib/local-agent/providers";
export type { WebSearchSettings } from "./web-search";
export type { AssetSearchSettings } from "./asset-search";
export type { Language, Theme, SystemSettings } from "./system";

export type SettingsState = AISlice &
  WebSearchSlice &
  AssetSearchSlice &
  SystemSlice & {
    resetAll: () => void;
  };

export const useSettingsStore = create<SettingsState>()(
  persist(
    (...a) => ({
      ...createAISlice(...a),
      ...createWebSearchSlice(...a),
      ...createAssetSearchSlice(...a),
      ...createSystemSlice(...a),
      resetAll: () => {
        const [set, get] = a;
        get().invalidateLocalCliObservation();
        set({
          ai: aiDefaults,
          webSearch: webSearchDefaults,
          assetSearch: assetSearchDefaults,
          system: systemDefaults,
          modelCache: null,
          localCliObservationCache: createEmptyLocalCliObservationCache(),
        });
      },
    }),
    {
      name: "open-builder-settings",
      version: SETTINGS_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        ai: state.ai,
        webSearch: state.webSearch,
        assetSearch: state.assetSearch,
        system: state.system,
        localCliObservationCache: state.localCliObservationCache,
      }),
      merge: (persisted, current) => {
        const persistedState =
          persisted && typeof persisted === "object"
            ? (persisted as Partial<SettingsState>)
            : {};
        const persistedSystem = persistedState.system;
        const mergedSystem =
          persistedSystem &&
          typeof persistedSystem === "object" &&
          !Array.isArray(persistedSystem)
            ? normalizeSystemSettings({
                ...current.system,
                ...persistedSystem,
              })
            : current.system;
        return {
          ...current,
          ...persistedState,
          system: mergedSystem,
          localCliObservationCache: sanitizeLocalCliObservationCache(
            persistedState.localCliObservationCache,
          ),
        };
      },
      migrate: (persisted, version) =>
        migrateSettings(persisted, version) as SettingsState,
    },
  ),
);
