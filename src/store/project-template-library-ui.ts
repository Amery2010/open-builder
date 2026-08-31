import { create } from "zustand";

interface ProjectTemplateLibraryUiState {
  open: boolean;
  sourceConversationId: string | null;
  openLibrary: (sourceConversationId?: string | null) => void;
  closeLibrary: () => void;
}

/** Ephemeral UI state only; project/template authority remains persisted. */
export const useProjectTemplateLibraryUi =
  create<ProjectTemplateLibraryUiState>((set) => ({
    open: false,
    sourceConversationId: null,
    openLibrary: (sourceConversationId) =>
      set({ open: true, sourceConversationId: sourceConversationId ?? null }),
    closeLibrary: () => set({ open: false, sourceConversationId: null }),
  }));
