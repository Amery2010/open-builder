import { create } from "zustand";
import type { DesignSelectionContext } from "../types";

interface DesignSelectionState {
  selections: Record<string, DesignSelectionContext>;
  setSelection: (
    conversationId: string,
    selection: DesignSelectionContext,
  ) => void;
  clearSelection: (conversationId: string) => void;
  clearAll: () => void;
}

export const useDesignSelectionStore = create<DesignSelectionState>((set) => ({
  selections: {},
  setSelection: (conversationId, selection) =>
    set((state) => ({
      selections: { ...state.selections, [conversationId]: selection },
    })),
  clearSelection: (conversationId) =>
    set((state) => {
      const { [conversationId]: _removed, ...selections } = state.selections;
      return { selections };
    }),
  clearAll: () => set({ selections: {} }),
}));
