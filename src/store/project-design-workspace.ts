import localforage from "localforage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createLocalforageStorage } from "./utils/localforage-storage";

export interface ProjectDesignWorkspaceSelection {
  pageId: string;
  /** Only a deliberate page choice may restrict the next Design run. */
  explicit?: boolean;
}

export interface DesignCanvasPosition {
  x: number;
  y: number;
}

export interface DesignCanvasCamera extends DesignCanvasPosition {
  zoom: number;
}

export interface DesignCanvasLayout {
  camera: DesignCanvasCamera;
  positions: Record<string, DesignCanvasPosition>;
}

export function designWorkspaceLayoutKey(
  conversationId: string,
  branchId: string,
): string {
  return JSON.stringify([conversationId, branchId]);
}

interface ProjectDesignWorkspaceState {
  selections: Record<string, ProjectDesignWorkspaceSelection | undefined>;
  layouts: Record<string, DesignCanvasLayout>;
  _hasHydrated: boolean;
  persistenceError: string | null;
  setSelection: (
    conversationId: string,
    selection: ProjectDesignWorkspaceSelection,
  ) => void;
  clearSelection: (conversationId: string) => void;
  ensureLayout: (
    conversationId: string,
    branchId: string,
    initial: DesignCanvasLayout,
    parentBranchId?: string,
  ) => DesignCanvasLayout | undefined;
  setLayout: (
    conversationId: string,
    branchId: string,
    layout: DesignCanvasLayout,
  ) => void;
  clearConversation: (conversationId: string) => void;
  clearLayouts: () => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function position(value: unknown): value is DesignCanvasPosition {
  return (
    record(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

function sanitizeLayout(value: unknown): DesignCanvasLayout | undefined {
  if (!record(value) || !position(value.camera)) return;
  const camera = value.camera as unknown as Record<string, unknown>;
  if (
    typeof camera.zoom !== "number" ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0 ||
    !record(value.positions)
  )
    return;
  return {
    camera: {
      x: value.camera.x,
      y: value.camera.y,
      zoom: Math.min(2, Math.max(0.1, camera.zoom)),
    },
    positions: Object.fromEntries(
      Object.entries(value.positions)
        .filter((entry): entry is [string, DesignCanvasPosition] =>
          position(entry[1]),
        )
        .map(([id, point]) => [id, { x: point.x, y: point.y }]),
    ),
  };
}

function keyConversation(key: string): string | undefined {
  try {
    const parts: unknown = JSON.parse(key);
    if (
      Array.isArray(parts) &&
      parts.length === 2 &&
      parts.every((part) => typeof part === "string" && part.length > 0)
    )
      return parts[0];
  } catch {
    // Invalid persisted keys do not belong to a workspace.
  }
}

const disk = createLocalforageStorage(
  localforage.createInstance({ name: "open-builder-design-workspace" }),
);
let storageReady = false;
let pendingWrites: Promise<void> = Promise.resolve();
const clearedBeforeHydration = new Set<string>();
let clearedAllBeforeHydration = false;

function reportStorageError(error: unknown) {
  if (useProjectDesignWorkspaceStore.getState().persistenceError) return;
  useProjectDesignWorkspaceStore.setState({
    persistenceError: error instanceof Error ? error.message : String(error),
  });
}

const workspaceStorage = {
  getItem: (name: string) => disk.getItem(name),
  setItem: (name: string, value: string) => {
    // Volatile selection updates may happen before the disk read completes.
    if (!storageReady) return Promise.resolve();
    pendingWrites = pendingWrites
      .then(() => disk.setItem(name, value))
      .catch(reportStorageError);
    return pendingWrites;
  },
  removeItem: async (name: string) => {
    await pendingWrites;
    await disk.removeItem(name);
  },
};

export const useProjectDesignWorkspaceStore =
  create<ProjectDesignWorkspaceState>()(
    persist(
      (set, get) => ({
        selections: {},
        layouts: {},
        _hasHydrated: false,
        persistenceError: null,
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
        ensureLayout: (conversationId, branchId, initial, parentBranchId) => {
          if (!get()._hasHydrated) return;
          const key = designWorkspaceLayoutKey(conversationId, branchId);
          const existing = get().layouts[key];
          if (existing) return existing;
          const parent = parentBranchId
            ? get().layouts[
                designWorkspaceLayoutKey(conversationId, parentBranchId)
              ]
            : undefined;
          const layout = sanitizeLayout(
            parent
              ? {
                  camera: parent.camera,
                  positions: { ...initial.positions, ...parent.positions },
                }
              : initial,
          );
          if (!layout) return;
          set((state) => ({ layouts: { ...state.layouts, [key]: layout } }));
          return layout;
        },
        setLayout: (conversationId, branchId, input) => {
          if (!get()._hasHydrated) return;
          const key = designWorkspaceLayoutKey(conversationId, branchId);
          const previous = get().layouts[key];
          const layout = sanitizeLayout(input);
          // A late unmount flush must not resurrect a reset/deleted project.
          if (!previous || !layout) return;
          set((state) => ({
            layouts: {
              ...state.layouts,
              [key]: {
                camera: layout.camera,
                // Historical checkouts can temporarily omit newer pages.
                positions: { ...previous.positions, ...layout.positions },
              },
            },
          }));
        },
        clearConversation: (conversationId) => {
          if (!get()._hasHydrated) clearedBeforeHydration.add(conversationId);
          set((state) => {
            const selections = { ...state.selections };
            delete selections[conversationId];
            return {
              selections,
              layouts: Object.fromEntries(
                Object.entries(state.layouts).filter(
                  ([key]) => keyConversation(key) !== conversationId,
                ),
              ),
            };
          });
        },
        clearLayouts: () => {
          if (!get()._hasHydrated) clearedAllBeforeHydration = true;
          set({ layouts: {}, selections: {} });
        },
      }),
      {
        name: "project-design-workspace",
        version: 1,
        storage: createJSONStorage(() => workspaceStorage),
        partialize: (state) => ({ layouts: state.layouts }),
        merge: (saved, current) => {
          const layouts =
            record(saved) && record(saved.layouts) ? saved.layouts : {};
          const validated: Record<string, DesignCanvasLayout> = {};
          if (!clearedAllBeforeHydration) {
            for (const [key, value] of Object.entries(layouts)) {
              const conversationId = keyConversation(key);
              const layout = sanitizeLayout(value);
              if (
                conversationId &&
                layout &&
                !clearedBeforeHydration.has(conversationId)
              ) {
                validated[key] = layout;
              }
            }
          }
          return { ...current, layouts: validated };
        },
        onRehydrateStorage: () => {
          storageReady = false;
          return (_state, error) => {
            storageReady = true;
            useProjectDesignWorkspaceStore.setState({
              _hasHydrated: true,
              ...(error
                ? {
                    persistenceError:
                      error instanceof Error ? error.message : String(error),
                  }
                : {}),
            });
            clearedBeforeHydration.clear();
            clearedAllBeforeHydration = false;
          };
        },
      },
    ),
  );
