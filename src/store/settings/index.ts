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
import { type SystemSlice, systemDefaults, createSystemSlice } from "./system";
import { SETTINGS_VERSION, migrateSettings } from "./migrations";

export type {
  AISettings,
  GenerationRuntime,
  LocalAgentCapabilityStatus,
  LocalAgentReadiness,
  LocalAgentProviderSettings,
  LocalAgentSettings,
  ModelCache,
} from "./ai";
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
        const [set] = a;
        set({
          ai: aiDefaults,
          webSearch: webSearchDefaults,
          assetSearch: assetSearchDefaults,
          system: systemDefaults,
          modelCache: null,
          localAgentCapability: "loading",
          localAgentReadiness: {},
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
      }),
      migrate: (persisted, version) =>
        migrateSettings(persisted, version) as SettingsState,
    },
  ),
);
