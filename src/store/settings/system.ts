import type { StateCreator } from "zustand";

export type Language = "system" | "zh" | "en";
export type Theme = "system" | "light" | "dark";

export const IMAGE_COMPRESSION_DEFAULT_QUALITY = 0.85;
export const IMAGE_COMPRESSION_MIN_QUALITY = 0.01;
export const IMAGE_COMPRESSION_MAX_QUALITY = 1;

export interface SystemSettings {
  language: Language;
  theme: Theme;
  reverseProxy: boolean;
  reverseProxyAllowedHosts: string;
  planModeEnabled: boolean;
  autoQaEnabled: boolean;
  developerSkillScriptsEnabled: boolean;
  permissionBrokerBypassEnabled: boolean;
  customSystemPrompt: string;
  imageCompressionEnabled: boolean;
  imageCompressionQuality: number;
}

export const systemDefaults: SystemSettings = {
  language: "system",
  theme: "system",
  reverseProxy: false,
  reverseProxyAllowedHosts: "",
  planModeEnabled: false,
  autoQaEnabled: false,
  developerSkillScriptsEnabled: false,
  permissionBrokerBypassEnabled: false,
  customSystemPrompt: "",
  imageCompressionEnabled: true,
  imageCompressionQuality: IMAGE_COMPRESSION_DEFAULT_QUALITY,
};

export function normalizeSystemSettings(
  settings: SystemSettings,
): SystemSettings {
  const candidate = settings as SystemSettings & {
    imageCompressionEnabled?: unknown;
    imageCompressionQuality?: unknown;
  };
  return {
    ...settings,
    imageCompressionEnabled:
      typeof candidate.imageCompressionEnabled === "boolean"
        ? candidate.imageCompressionEnabled
        : systemDefaults.imageCompressionEnabled,
    imageCompressionQuality:
      typeof candidate.imageCompressionQuality === "number" &&
      Number.isFinite(candidate.imageCompressionQuality) &&
      candidate.imageCompressionQuality >= IMAGE_COMPRESSION_MIN_QUALITY &&
      candidate.imageCompressionQuality <= IMAGE_COMPRESSION_MAX_QUALITY
        ? candidate.imageCompressionQuality
        : systemDefaults.imageCompressionQuality,
  };
}

export interface SystemSlice {
  system: SystemSettings;
  setSystem: (settings: SystemSettings) => void;
  setPlanMode: (enabled: boolean) => void;
}

export const createSystemSlice: StateCreator<
  SystemSlice,
  [],
  [],
  SystemSlice
> = (set) => ({
  system: systemDefaults,
  setSystem: (settings) => set({ system: normalizeSystemSettings(settings) }),
  setPlanMode: (enabled) =>
    set((state) => ({
      system: {
        ...state.system,
        planModeEnabled: enabled,
      },
    })),
});
