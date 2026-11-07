import { create } from "zustand";

export interface ProjectDesignWorkspaceSelection {
  pageId: string;
  scenarioId: string;
  /** Only a deliberate page/scenario choice may restrict the next Design run. */
  explicit?: boolean;
}

interface ProjectDesignWorkspaceState {
  selections: Record<string, ProjectDesignWorkspaceSelection | undefined>;
  setSelection: (
    conversationId: string,
    selection: ProjectDesignWorkspaceSelection,
  ) => void;
  clearSelection: (conversationId: string) => void;
}

export const useProjectDesignWorkspaceStore =
  create<ProjectDesignWorkspaceState>((set) => ({
    selections: {},
    setSelection: (conversationId, selection) =>
      set((state) => ({
        selections: { ...state.selections, [conversationId]: selection },
      })),
    clearSelection: (conversationId) =>
      set((state) => {
        const selections = { ...state.selections };
        delete selections[conversationId];
        return { selections };
      }),
  }));
