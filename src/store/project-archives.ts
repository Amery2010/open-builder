import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import localforage from "localforage";
import { createLocalforageStorage } from "./utils/localforage-storage";

export interface ProjectArchiveRecord {
  conversationId: string;
  snapshotId: string;
  branchId?: string;
  contentDigest?: string;
  fileName: string;
  size: number;
  status: "pending" | "ready" | "failed";
  createdAt: number;
  error?: string;
}
export type ProjectArchiveCleanupTask = {
  id: string;
  createdAt: number;
  error?: string;
} & (
  | { kind: "snapshot"; conversationId: string; snapshotId: string }
  | { kind: "project"; conversationId: string }
  | { kind: "all" }
);
export function archiveRecordKey(conversationId: string, snapshotId: string) {
  return JSON.stringify([conversationId, snapshotId]);
}
interface ArchiveState {
  records: Record<string, ProjectArchiveRecord>;
  cleanup: Record<string, ProjectArchiveCleanupTask>;
  putCleanup(task: ProjectArchiveCleanupTask): void;
  removeCleanup(ids: string[]): void;
  _hasHydrated: boolean;
  put(record: ProjectArchiveRecord): void;
  remove(keys: string[]): void;
}
export const useProjectArchiveStore = create<ArchiveState>()(
  persist(
    (set) => ({
      records: {},
      cleanup: {},
      putCleanup: (task) =>
        set((state) => ({ cleanup: { ...state.cleanup, [task.id]: task } })),
      removeCleanup: (ids) =>
        set((state) => {
          const cleanup = { ...state.cleanup };
          for (const id of ids) delete cleanup[id];
          return { cleanup };
        }),
      _hasHydrated: false,
      put: (record) =>
        set((state) => ({
          records: {
            ...state.records,
            [archiveRecordKey(record.conversationId, record.snapshotId)]:
              record,
          },
        })),
      remove: (keys) =>
        set((state) => {
          const records = { ...state.records };
          for (const key of keys) delete records[key];
          return { records };
        }),
    }),
    {
      name: "project-archives",
      version: 1,
      storage: createJSONStorage(() =>
        createLocalforageStorage(
          localforage.createInstance({ name: "open-builder-project-archives" }),
        ),
      ),
      partialize: (state) => ({
        records: state.records,
        cleanup: state.cleanup,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state._hasHydrated = true;
      },
    },
  ),
);
