import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import localforage from "localforage";
import { createPatch } from "diff";
import type { ProjectAssets, ProjectFiles, ProjectSnapshot } from "../types";
import { createLocalforageStorage } from "./utils/localforage-storage";
import { runMigrations, type MigrationStep } from "./utils/migrate";
import {
  rebuildSnapshotChainWithoutSnapshot,
  replaySnapshotAssets,
  replaySnapshots,
} from "./snapshot-replay";
import {
  isSnapshotWithinStorageBudget,
  pruneSnapshotRecord,
} from "../lib/utils/storage-governance";

export { replaySnapshots } from "./snapshot-replay";

const SNAPSHOT_STORE_VERSION = 3;
/** How many patch snapshots to write between checkpoints. The first snapshot
 *  in a chain is always a checkpoint so reconstruction is anchored even for
 *  short chains. */
const CHECKPOINT_INTERVAL = 10;

const snapshotMigrations: MigrationStep[] = [
  // v1 -> v2: stamp every persisted snapshot with `kind: "patch"`. The shape
  // didn't change otherwise; legacy chains will get their first checkpoint
  // appended naturally on the next snapshot write.
  (state: any) => {
    if (state && state.snapshots && typeof state.snapshots === "object") {
      for (const convId of Object.keys(state.snapshots)) {
        const chain = state.snapshots[convId];
        if (!Array.isArray(chain)) continue;
        for (const snap of chain) {
          if (snap && !snap.kind) snap.kind = "patch";
        }
      }
    }
    return state;
  },
  (state) => state,
];

const snapshotStorage = createLocalforageStorage(
  localforage.createInstance({ name: "open-builder-snapshots" }),
);

interface SnapshotState {
  snapshots: Record<string, ProjectSnapshot[]>;
  _hasHydrated: boolean;

  createSnapshot: (
    conversationId: string,
    messageId: string,
    currentFiles: ProjectFiles,
    currentAssets?: ProjectAssets,
  ) => void;

  getSnapshots: (conversationId: string) => ProjectSnapshot[];

  getSnapshotByMessageId: (
    conversationId: string,
    messageId: string,
  ) => ProjectSnapshot | undefined;

  reconstructFiles: (
    conversationId: string,
    snapshotId: string,
  ) => ProjectFiles;

  reconstructAssets: (
    conversationId: string,
    snapshotId: string,
  ) => ProjectAssets;

  deleteSnapshotsForConversation: (conversationId: string) => void;

  renameSnapshot: (
    conversationId: string,
    snapshotId: string,
    label: string,
  ) => void;

  deleteSnapshot: (conversationId: string, snapshotId: string) => void;

  pruneSnapshots: (maxPerConversation: number) => number;

  /** Update the latest snapshot to include manual file edits */
  updateLatestSnapshot: (
    conversationId: string,
    currentFiles: ProjectFiles,
    currentAssets?: ProjectAssets,
  ) => void;
}

function sameProjectAssets(left: ProjectAssets, right: ProjectAssets): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([path, asset]) => {
      const other = right[path];
      return (
        other !== undefined &&
        asset.blobRef === other.blobRef &&
        asset.modulePath === other.modulePath &&
        asset.publicPath === other.publicPath
      );
    })
  );
}

function releaseSnapshotAssetCandidates(
  snapshots: readonly ProjectSnapshot[],
): void {
  const candidateRefs = new Set(
    snapshots.flatMap((snapshot) =>
      Object.values(snapshot.assets ?? {}).map((asset) => asset.blobRef),
    ),
  );
  if (candidateRefs.size === 0) return;
  void Promise.all([
    import("./conversation"),
    import("./project-templates"),
    import("../lib/project-assets/core"),
  ])
    .then(
      ([
        { useConversationStore },
        { useProjectTemplateStore },
        { releaseUnreferencedProjectAssetBlobs },
      ]) =>
        releaseUnreferencedProjectAssetBlobs(candidateRefs, () => {
          const conversations = useConversationStore.getState();
          const snapshots = useSnapshotStore.getState();
          const templates = useProjectTemplateStore.getState();
          if (
            !conversations._hasHydrated ||
            !snapshots._hasHydrated ||
            !templates._hasHydrated
          ) {
            return null;
          }
          return [
            ...Object.values(conversations.conversations).map(
              (conversation) => conversation.assets,
            ),
            ...Object.values(snapshots.snapshots)
              .flat()
              .map((snapshot) => snapshot.assets),
            ...Object.values(templates.templates).map(
              (template) => template.assets,
            ),
          ];
        }),
    )
    .catch((error) => {
      console.warn("Failed to release snapshot project assets:", error);
    });
}

/** Count patch snapshots that have accumulated since the most recent checkpoint. */
function patchesSinceCheckpoint(chain: ProjectSnapshot[]): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].kind === "checkpoint") {
      return chain.length - 1 - i;
    }
  }
  return chain.length;
}

export const useSnapshotStore = create<SnapshotState>()(
  persist(
    (set, get) => ({
      snapshots: {},
      _hasHydrated: false,

      createSnapshot: (
        conversationId,
        messageId,
        currentFiles,
        currentAssets = {},
      ) => {
        const state = get();
        const chain = state.snapshots[conversationId] ?? [];

        // Deduplicate: if a snapshot for this messageId already exists, skip
        if (chain.some((s) => s.messageId === messageId)) return;

        // Reconstruct previous file state
        const prevFiles: ProjectFiles =
          chain.length > 0
            ? replaySnapshots(chain, chain[chain.length - 1].id)
            : {};
        const prevAssets = chain.at(-1)?.assets ?? {};

        const patches: Record<string, string> = {};
        const addedFiles: Record<string, string> = {};
        const deletedFiles: string[] = [];

        // Detect added and modified files
        for (const [path, content] of Object.entries(currentFiles)) {
          if (!(path in prevFiles)) {
            addedFiles[path] = content;
          } else if (prevFiles[path] !== content) {
            patches[path] = createPatch(path, prevFiles[path], content);
          }
        }

        // Detect deleted files
        for (const path of Object.keys(prevFiles)) {
          if (!(path in currentFiles)) {
            deletedFiles.push(path);
          }
        }

        // Skip if nothing changed
        if (
          Object.keys(patches).length === 0 &&
          Object.keys(addedFiles).length === 0 &&
          deletedFiles.length === 0 &&
          sameProjectAssets(prevAssets, currentAssets)
        ) {
          return;
        }

        // Decide whether this snapshot should be a checkpoint. The first
        // snapshot in a chain is always a checkpoint; otherwise we emit one
        // every CHECKPOINT_INTERVAL patches so future reconstructions don't
        // walk the entire history.
        const isFirst = chain.length === 0;
        const dueForCheckpoint =
          patchesSinceCheckpoint(chain) >= CHECKPOINT_INTERVAL;
        const asCheckpoint = isFirst || dueForCheckpoint;

        const base: ProjectSnapshot = {
          id: crypto.randomUUID(),
          conversationId,
          messageId,
          patches,
          addedFiles,
          deletedFiles,
          createdAt: Date.now(),
          kind: asCheckpoint ? "checkpoint" : "patch",
          assets: { ...currentAssets },
        };
        const snapshot: ProjectSnapshot = asCheckpoint
          ? { ...base, fullFiles: { ...currentFiles } }
          : base;

        if (!isSnapshotWithinStorageBudget(snapshot)) {
          return;
        }

        set((s) => ({
          snapshots: {
            ...s.snapshots,
            [conversationId]: [
              ...(s.snapshots[conversationId] ?? []),
              snapshot,
            ],
          },
        }));
      },

      getSnapshots: (conversationId) => {
        return get().snapshots[conversationId] ?? [];
      },

      getSnapshotByMessageId: (conversationId, messageId) => {
        return (get().snapshots[conversationId] ?? []).find(
          (s) => s.messageId === messageId,
        );
      },

      reconstructFiles: (conversationId, snapshotId) => {
        const chain = get().snapshots[conversationId] ?? [];
        return replaySnapshots(chain, snapshotId);
      },

      reconstructAssets: (conversationId, snapshotId) => {
        const chain = get().snapshots[conversationId] ?? [];
        return replaySnapshotAssets(chain, snapshotId);
      },

      updateLatestSnapshot: (conversationId, currentFiles, currentAssets) => {
        const state = get();
        const chain = state.snapshots[conversationId] ?? [];
        if (chain.length === 0) return;

        const latest = chain[chain.length - 1];
        const nextAssets = currentAssets ?? latest.assets ?? {};

        // Reconstruct file state before the latest snapshot
        const prevFiles: ProjectFiles =
          chain.length > 1
            ? replaySnapshots(chain, chain[chain.length - 2].id)
            : {};

        const patches: Record<string, string> = {};
        const addedFiles: Record<string, string> = {};
        const deletedFiles: string[] = [];

        for (const [path, content] of Object.entries(currentFiles)) {
          if (!(path in prevFiles)) {
            addedFiles[path] = content;
          } else if (prevFiles[path] !== content) {
            patches[path] = createPatch(path, prevFiles[path], content);
          }
        }
        for (const path of Object.keys(prevFiles)) {
          if (!(path in currentFiles)) {
            deletedFiles.push(path);
          }
        }

        const updatedSnapshot: ProjectSnapshot = {
          ...latest,
          patches,
          addedFiles,
          deletedFiles,
          assets: { ...nextAssets },
          // Keep checkpoint metadata in sync with the new file state so a
          // future replay anchored at this snapshot stays correct.
          ...(latest.kind === "checkpoint"
            ? { fullFiles: { ...currentFiles } }
            : {}),
        };

        if (!isSnapshotWithinStorageBudget(updatedSnapshot)) {
          return;
        }

        set((s) => ({
          snapshots: {
            ...s.snapshots,
            [conversationId]: [...chain.slice(0, -1), updatedSnapshot],
          },
        }));
      },

      deleteSnapshotsForConversation: (conversationId) => {
        const removed = get().snapshots[conversationId] ?? [];
        set((s) => {
          const { [conversationId]: _, ...rest } = s.snapshots;
          return { snapshots: rest };
        });
        releaseSnapshotAssetCandidates(removed);
      },

      renameSnapshot: (conversationId, snapshotId, label) => {
        set((s) => {
          const chain = s.snapshots[conversationId] ?? [];
          return {
            snapshots: {
              ...s.snapshots,
              [conversationId]: chain.map((snapshot) =>
                snapshot.id === snapshotId
                  ? { ...snapshot, label: label.trim() || undefined }
                  : snapshot,
              ),
            },
          };
        });
      },

      deleteSnapshot: (conversationId, snapshotId) => {
        const removed = (get().snapshots[conversationId] ?? []).filter(
          (snapshot) => snapshot.id === snapshotId,
        );
        set((s) => {
          const chain = s.snapshots[conversationId] ?? [];
          return {
            snapshots: {
              ...s.snapshots,
              [conversationId]: rebuildSnapshotChainWithoutSnapshot(
                chain,
                snapshotId,
                CHECKPOINT_INTERVAL,
              ),
            },
          };
        });
        releaseSnapshotAssetCandidates(removed);
      },

      pruneSnapshots: (maxPerConversation) => {
        const before = Object.values(get().snapshots).flat();
        let removedCount = 0;
        set((s) => {
          const result = pruneSnapshotRecord(
            s.snapshots,
            maxPerConversation,
            CHECKPOINT_INTERVAL,
          );
          removedCount = result.removedCount;
          return { snapshots: result.snapshots };
        });
        const retainedIds = new Set(
          Object.values(get().snapshots)
            .flat()
            .map((snapshot) => snapshot.id),
        );
        releaseSnapshotAssetCandidates(
          before.filter((snapshot) => !retainedIds.has(snapshot.id)),
        );
        return removedCount;
      },
    }),
    {
      name: "open-builder-snapshots",
      version: SNAPSHOT_STORE_VERSION,
      storage: createJSONStorage(() => snapshotStorage),
      partialize: (state) => ({
        snapshots: state.snapshots,
      }),
      migrate: (persisted, version) =>
        runMigrations(
          snapshotMigrations,
          persisted,
          version,
          SNAPSHOT_STORE_VERSION,
        ),
      onRehydrateStorage: () => () => {
        useSnapshotStore.setState({ _hasHydrated: true });
      },
    },
  ),
);
