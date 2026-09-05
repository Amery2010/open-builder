import type { StateCreator } from "zustand";

export type Language = "system" | "zh" | "en";
export type Theme = "system" | "light" | "dark";

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
};

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
  setSystem: (settings) => set({ system: settings }),
  setPlanMode: (enabled) =>
    set((state) => ({
      system: {
        ...state.system,
        planModeEnabled: enabled,
      },
    })),
});
