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
  snapshotLineage,
} from "./snapshot-replay";
import { isSnapshotWithinStorageBudget } from "../lib/utils/storage-governance";

export { replaySnapshots } from "./snapshot-replay";

import { useConversationStore } from "./conversation";
import {
  canonicalSnapshotMessageId,
  conversationBranchStates,
  defaultBranchId,
} from "../lib/conversation/branches";
import { filterMemoryMessages } from "../lib/utils/memory-filter";
import { mergeMessages } from "../lib/utils/merge-messages";

const SNAPSHOT_STORE_VERSION = 4;
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
  ) => ProjectSnapshot | undefined;

  getSnapshots: (conversationId: string) => ProjectSnapshot[];
  migrateLegacyMessageLinks: () => void;
  getRetainedSnapshotIds: (conversationId: string) => Set<string>;

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
            ...Object.values(conversations.conversations).flatMap(
              (conversation) =>
                conversationBranchStates(conversation).map(
                  (branch) => branch.assets,
                ),
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

function branchSnapshots(
  conversationId: string,
  chain: ProjectSnapshot[],
): ProjectSnapshot[] {
  const conversation =
    useConversationStore.getState().conversations[conversationId];
  if (!conversation) return chain;
  const branchId =
    conversation.activeBranchId ?? defaultBranchId(conversationId);
  const head =
    conversation.checkout?.snapshotId ??
    conversation.branches?.[branchId]?.headSnapshotId;
  if (head && chain.some((snapshot) => snapshot.id === head))
    return snapshotLineage(chain, head);
  return chain.filter(
    (snapshot) => snapshot.branchId === branchId || !snapshot.branchId,
  );
}

export function selectVisibleSnapshots(
  conversation: import("../types").Conversation | undefined,
  chain: ProjectSnapshot[],
): ProjectSnapshot[] {
  if (!conversation) return chain.filter((snapshot) => !snapshot.hidden);
  const branchId =
    conversation.activeBranchId ?? defaultBranchId(conversation.id);
  const head =
    conversation.checkout?.snapshotId ??
    conversation.branches?.[branchId]?.headSnapshotId;
  let lineage = chain.filter(
    (snapshot) => snapshot.branchId === branchId || !snapshot.branchId,
  );
  if (head && chain.some((snapshot) => snapshot.id === head)) {
    try {
      lineage = snapshotLineage(chain, head);
    } catch {
      /* Keep corrupt history inspectable; checkout/export still fail closed. */
    }
  }
  return lineage
    .filter((snapshot) => !snapshot.hidden)
    .map((snapshot) => {
      const messageId = canonicalSnapshotMessageId(snapshot, conversation);
      return messageId === snapshot.messageId
        ? snapshot
        : { ...snapshot, messageId };
    });
}

function retainedSnapshotIds(conversationId: string): Set<string> {
  const conversation =
    useConversationStore.getState().conversations[conversationId];
  return new Set([
    ...(conversation?.checkout ? [conversation.checkout.snapshotId] : []),
    ...Object.values(conversation?.branches ?? {}).flatMap((branch) =>
      [branch.headSnapshotId, branch.forkSnapshotId].filter(
        (id): id is string => !!id,
      ),
    ),
  ]);
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
        const all = state.snapshots[conversationId] ?? [];
        const conversation =
          useConversationStore.getState().conversations[conversationId];
        if (conversation?.checkout) return;
        const chain = branchSnapshots(conversationId, all);
        const branchId =
          conversation?.activeBranchId ?? defaultBranchId(conversationId);

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
          sameProjectAssets(prevAssets, currentAssets) &&
          (!conversation ||
            !chain.at(-1)?.projectState ||
            (chain.at(-1)!.projectState!.template === conversation.template &&
              chain.at(-1)!.projectState!.previewMode ===
                conversation.previewMode &&
              JSON.stringify(chain.at(-1)!.projectState!.designState) ===
                JSON.stringify(conversation.designState)))
        ) {
          return;
        }

        // Decide whether this snapshot should be a checkpoint. The first
        // snapshot in a chain is always a checkpoint; otherwise we emit one
        // every CHECKPOINT_INTERVAL patches so future reconstructions don't
        // walk the entire history.
        const isFirst =
          chain.length === 0 || chain.at(-1)?.branchId !== branchId;
        const dueForCheckpoint =
          patchesSinceCheckpoint(chain) >= CHECKPOINT_INTERVAL;
        const asCheckpoint = isFirst || dueForCheckpoint;

        const base: ProjectSnapshot = {
          id: crypto.randomUUID(),
          conversationId,
          messageId,
          branchId,
          parentSnapshotId: chain.at(-1)?.id ?? null,
          messageCount: conversation?.messages.length,
          endMessageId: conversation
            ? filterMemoryMessages(conversation.messages).at(-1)?.id
            : undefined,
          messageLinkVersion: 1,
          projectState: conversation
            ? {
                template: conversation.template,
                previewMode: conversation.previewMode,
                designState: conversation.designState,
                activeFile: conversation.activeFile,
                isProjectInitialized: conversation.isProjectInitialized,
              }
            : undefined,
          patches,
          addedFiles,
          deletedFiles,
          createdAt: Date.now(),
          kind: asCheckpoint ? "checkpoint" : "patch",
          assets: { ...currentAssets },
        };
        base.messageId = canonicalSnapshotMessageId(
          { ...base, messageLinkVersion: undefined },
          conversation,
        );
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
        useConversationStore
          .getState()
          .setBranchHeadSnapshot(conversationId, snapshot.id);
        return snapshot;
      },

      migrateLegacyMessageLinks: () => {
        const conversations = useConversationStore.getState().conversations;
        const old = get().snapshots;
        let changed = false;
        const snapshots = Object.fromEntries(
          Object.entries(old).map(([id, chain]) => {
            const conversation = conversations[id];
            if (!conversation) return [id, chain];
            const next = chain.map((snapshot) => {
              if (snapshot.messageLinkVersion === 1) return snapshot;
              changed = true;
              return {
                ...snapshot,
                messageId: canonicalSnapshotMessageId(snapshot, conversation),
                messageLinkVersion: 1 as const,
              };
            });
            return [id, next];
          }),
        );
        if (changed) set({ snapshots });
      },

      getRetainedSnapshotIds: retainedSnapshotIds,

      getSnapshots: (conversationId) => {
        const conversation =
          useConversationStore.getState().conversations[conversationId];
        return selectVisibleSnapshots(
          conversation,
          get().snapshots[conversationId] ?? [],
        );
      },

      getSnapshotByMessageId: (conversationId, messageId) => {
        const conversation =
          useConversationStore.getState().conversations[conversationId];
        return [
          ...selectVisibleSnapshots(
            conversation,
            get().snapshots[conversationId] ?? [],
          ),
        ]
          .reverse()
          .find(
            (snapshot) =>
              snapshot.messageId === messageId ||
              canonicalSnapshotMessageId(snapshot, conversation) === messageId,
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
        const conversation =
          useConversationStore.getState().conversations[conversationId];
        if (conversation?.checkout) return;
        const chain = branchSnapshots(
          conversationId,
          get().snapshots[conversationId] ?? [],
        );
        const messageId = conversation
          ? mergeMessages(conversation.messages)
              .filter((message) => message.role === "assistant")
              .at(-1)?.id
          : chain.at(-1)?.messageId;
        if (!messageId && Object.keys(currentFiles).length === 0) return;
        get().createSnapshot(
          conversationId,
          messageId ?? `manual-${crypto.randomUUID()}`,
          currentFiles,
          currentAssets ?? conversation?.assets ?? chain.at(-1)?.assets ?? {},
        );
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
        if (retainedSnapshotIds(conversationId).has(snapshotId)) {
          set((state) => ({
            snapshots: {
              ...state.snapshots,
              [conversationId]: (state.snapshots[conversationId] ?? []).map(
                (snapshot) =>
                  snapshot.id === snapshotId
                    ? { ...snapshot, hidden: true }
                    : snapshot,
              ),
            },
          }));
          return;
        }
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
        const next = { ...get().snapshots };
        let removedCount = 0;
        for (const [id, source] of Object.entries(next)) {
          const protectedIds = retainedSnapshotIds(id);
          let chain = source;
          for (const snapshot of source.slice(
            0,
            Math.max(0, source.length - Math.max(0, maxPerConversation)),
          )) {
            if (protectedIds.has(snapshot.id)) continue;
            chain = rebuildSnapshotChainWithoutSnapshot(chain, snapshot.id);
            removedCount++;
          }
          next[id] = chain;
        }
        set({ snapshots: next });
        const retainedIds = new Set(
          Object.values(next)
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
        void import("./conversation").then(({ useConversationStore }) => {
          if (
            useConversationStore?.persist?.hasHydrated() &&
            useConversationStore.getState()._hasHydrated &&
            useSnapshotStore
          )
            useSnapshotStore.getState().migrateLegacyMessageLinks();
        });
      },
    },
  ),
);
