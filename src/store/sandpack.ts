import { create } from "zustand";

export interface ConsoleLogData {
  method: string;
  data: unknown[];
  id: string;
  timestamp?: number;
}

interface SandpackState {
  consoleLogs: ConsoleLogData[];
  setConsoleLogs: (logs: ConsoleLogData[]) => void;
}

export const useSandpackStore = create<SandpackState>()((set) => ({
  consoleLogs: [],
  setConsoleLogs: (logs) => set({ consoleLogs: logs }),
}));
