import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import localforage from "localforage";
import { useSnapshotStore } from "./snapshot";
import { useProjectTemplateStore } from "./project-templates";
import { useProjectDesignWorkspaceStore } from "./project-design-workspace";
import { runMigrations, type MigrationStep } from "./utils/migrate";
import type {
  Conversation,
  PendingUserInstruction,
  CompressedContext,
  LocalAgentProvider,
  LocalAgentSessionRef,
  Message,
  ConversationDesignState,
  WorkspaceMode,
  ProjectPreviewMode,
  ProjectAsset,
  ProjectAssets,
  ProjectFiles,
  PreviewView,
} from "../types";
import { normalizePreviewView } from "../types";
import { removeDesignReferenceHeaders } from "../lib/design-systems/reference-header";
import {
  normalizeProjectFiles,
  validateProjectFiles,
} from "../lib/utils/project-files";
import { deleteAttachmentsForMessages } from "../lib/attachments/store";
import { normalizeCompressedSummary } from "../lib/utils/compress-context";
import { findWithdrawableUserMessageIndex } from "../lib/utils/merge-messages";
import {
  addProjectAssetModules,
  collectProjectAssetBlobRefs,
  normalizeProjectAssets,
  releaseUnreferencedProjectAssetBlobs,
  syncProjectAssetModules,
  validateProjectAssets,
} from "../lib/project-assets/core";

import {
  defaultBranchId,
  normalizeConversationBranches,
  reconcileConversation,
  writableConversation,
  conversationBranchStates,
  canonicalSnapshotMessageId,
} from "../lib/conversation/branches";
import { findAssistantGroupEnd } from "../lib/utils/message-navigation";

const CONVERSATION_STORE_VERSION = 7;
const DEFAULT_PROJECT_TEMPLATE = "vite-react-ts";

function attachmentMessages(conversation: Conversation | undefined): Message[] {
  if (!conversation) return [];
  return [
    ...conversationBranchStates(conversation).flatMap(
      (branch) => branch.messages,
    ),
    ...(conversation.pendingUserInstructions ?? []).map((item): Message => ({
      role: "user",
      content: item.content,
      metadata: { attachments: item.attachments },
    })),
  ];
}

function retainedProjectAssetCollections(conversationState: {
  conversations: Record<string, Conversation>;
  _hasHydrated: boolean;
}): readonly (ProjectAssets | undefined)[] | null {
  const snapshots = useSnapshotStore.getState();
  const templates = useProjectTemplateStore.getState();
  if (
    !conversationState._hasHydrated ||
    !snapshots._hasHydrated ||
    !templates._hasHydrated
  ) {
    return null;
  }
  return [
    ...Object.values(conversationState.conversations).flatMap((conversation) =>
      conversationBranchStates(conversation).map((branch) => branch.assets),
    ),
    ...Object.values(snapshots.snapshots)
      .flat()
      .map((snapshot) => snapshot.assets),
    ...Object.values(templates.templates).map((template) => template.assets),
  ];
}

export function normalizeConversationProjectState<T extends Conversation>(
  conversation: T,
): T {
  let files = removeDesignReferenceHeaders(
    normalizeProjectFiles(conversation.files),
  );
  let assets = normalizeProjectAssets(conversation.assets);
  if (Object.keys(assets).length > 0) {
    try {
      const reconciledFiles = addProjectAssetModules(files, assets);
      const filesChanged =
        Object.keys(reconciledFiles).length !== Object.keys(files).length ||
        Object.entries(reconciledFiles).some(
          ([path, content]) => files[path] !== content,
        );
      if (filesChanged) files = reconciledFiles;
    } catch {
      // Corrupt asset metadata must not make the whole persisted conversation
      // unrenderable. Keep the text project and conservatively retain Blobs
      // for explicit storage cleanup.
      assets = {};
    }
  }
  const paths = Object.keys(files);
  const activeFile =
    conversation.activeFile && conversation.activeFile in files
      ? conversation.activeFile
      : paths[0];
  const isProjectInitialized = paths.length > 0;
  const previewMode: ProjectPreviewMode =
    conversation.previewMode === "code-only" ? "code-only" : "sandpack";
  const defaultPreviewView = normalizePreviewView(
    conversation.defaultPreviewView,
  );
  const workspaceMode: WorkspaceMode =
    conversation.workspaceMode === "plan" ||
    conversation.workspaceMode === "design"
      ? conversation.workspaceMode
      : "auto";
  const planReturnMode =
    workspaceMode === "plan"
      ? conversation.planReturnMode === "design"
        ? "design"
        : "auto"
      : undefined;
  const rootDesignPath = paths.find(
    (path) => !path.includes("/") && path.toLowerCase() === "design.md",
  );
  const designState =
    conversation.designState ??
    (rootDesignPath
      ? {
          selectedSystem: {
            id: "legacy-design-md",
            name: rootDesignPath,
            source: "legacy" as const,
            version: "legacy",
          },
          appliedSystem: {
            id: "legacy-design-md",
            name: rootDesignPath,
            source: "legacy" as const,
            version: "legacy",
          },
        }
      : undefined);

  if (
    conversation.activeFile === activeFile &&
    conversation.files === files &&
    conversation.isProjectInitialized === isProjectInitialized &&
    conversation.previewMode === previewMode &&
    conversation.defaultPreviewView === defaultPreviewView &&
    conversation.workspaceMode === workspaceMode &&
    conversation.planReturnMode === planReturnMode &&
    conversation.assets === assets &&
    conversation.designState === designState
  ) {
    return conversation;
  }

  return {
    ...conversation,
    files,
    activeFile,
    assets,
    previewMode,
    defaultPreviewView,
    isProjectInitialized,
    workspaceMode,
    planReturnMode,
    designState,
  } as T;
}

export function normalizePersistedConversationProjects<T>(state: T): T {
  if (!state || typeof state !== "object") return state;
  const conversations = (state as { conversations?: unknown }).conversations;
  if (!conversations || typeof conversations !== "object") return state;

  return {
    ...state,
    conversations: Object.fromEntries(
      Object.entries(conversations).map(([id, conversation]) => [
        id,
        normalizeConversationBranches(
          normalizeConversationProjectState(conversation as Conversation),
        ),
      ]),
    ),
  };
}

const conversationMigrations: MigrationStep[] = [
  (state) => state,
  normalizePersistedConversationProjects,
  normalizePersistedConversationProjects,
  normalizePersistedConversationProjects,
  normalizePersistedConversationProjects,
  normalizePersistedConversationProjects,
  normalizePersistedConversationProjects,
];

export function migrateConversationState<T>(persisted: T, version: number): T {
  return runMigrations(
    conversationMigrations,
    persisted,
    version,
    CONVERSATION_STORE_VERSION,
  );
}

function normalizeStoredCompressedContext(
  context: CompressedContext | undefined,
): CompressedContext | undefined {
  if (
    !context ||
    typeof context.summary !== "string" ||
    !Number.isFinite(context.fromIndex)
  ) {
    return undefined;
  }
  return {
    ...context,
    fromIndex: Math.max(0, Math.floor(context.fromIndex)),
    summary: normalizeCompressedSummary(context.summary),
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Sentinel value for the default untitled conversation title */
export const DEFAULT_TITLE = "__new_app__";

// ─── localforage storage adapter ─────────────────────────────────────────────

let pendingConversationPersistence: Promise<unknown> = Promise.resolve();
export async function flushConversationPersistence(): Promise<void> {
  await pendingConversationPersistence;
}
const localforageStorage = {
  getItem: async (name: string) => {
    await pendingConversationPersistence;
    const value = await localforage.getItem<string>(name);
    return value ?? null;
  },
  setItem: async (name: string, value: string) => {
    const pending = pendingConversationPersistence
      .catch(() => undefined)
      .then(() => localforage.setItem(name, value));
    pendingConversationPersistence = pending;
    await pending;
  },
  removeItem: async (name: string) => {
    const pending = pendingConversationPersistence
      .catch(() => undefined)
      .then(() => localforage.removeItem(name));
    pendingConversationPersistence = pending;
    await pending;
  },
};

// ─── Store types ─────────────────────────────────────────────────────────────

type Updater<T> = T | ((prev: T) => T);
function applyUpdater<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function"
    ? (updater as (p: T) => T)(prev)
    : updater;
}

interface ConversationState {
  conversations: Record<string, Conversation>;
  activeId: string | null;
  _hasHydrated: boolean;
  legacyPlanModeMigrated: boolean;

  ensureWritableBranch: (id: string) => string | undefined;
  checkoutSnapshot: (id: string, snapshotId: string) => void;
  switchBranch: (id: string, branchId: string) => void;
  setBranchHeadSnapshot: (id: string, snapshotId: string) => void;
  createConversation: () => string;
  addConversation: (conversation: Conversation) => string;
  deleteConversation: (id: string) => void;
  switchConversation: (id: string) => void;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setDefaultPreviewView: (view: PreviewView) => void;
  setDefaultPreviewViewForConversation: (id: string, view: PreviewView) => void;
  returnFromPlan: (id?: string) => Exclude<WorkspaceMode, "plan">;
  setDesignState: (
    updater: Updater<ConversationDesignState | undefined>,
  ) => void;
  setDesignStateForConversation: (
    id: string,
    updater: Updater<ConversationDesignState | undefined>,
  ) => void;
  migrateLegacyPlanMode: (enabled: boolean) => boolean;

  forkConversation: () => string;
  setPendingUserInstructions: (
    id: string,
    updater: Updater<PendingUserInstruction[]>,
  ) => void;
  cancelUserInstructions: (id: string, runId?: string) => void;
  commitUserInstructions: (
    id: string,
    runId: string,
    instructionIds: readonly string[],
    messages: Message[],
  ) => boolean;
  setMessages: (updater: Updater<Message[]>) => void;
  setMessagesForConversation: (id: string, updater: Updater<Message[]>) => void;
  /** Remove the final visible genuine user message plus trailing hidden
   *  records, and return that user message for draft restoration. */
  withdrawLastUserMessage: (conversationId?: string) => Message | undefined;
  setFiles: (updater: Updater<ProjectFiles>) => void;
  setFilesForConversation: (id: string, updater: Updater<ProjectFiles>) => void;
  setAssetsForConversation: (
    id: string,
    updater: Updater<ProjectAssets>,
  ) => void;
  addProjectAsset: (
    id: string,
    asset: ProjectAsset,
  ) => { ok: true } | { ok: false; error: string };
  replaceProject: (input: {
    files: ProjectFiles;
    assets?: ProjectAssets;
    template: string;
    previewMode: ProjectPreviewMode;
    activeFile?: string;
  }) => { ok: true } | { ok: false; error: string };
  setActiveFile: (path: string) => void;
  setTemplate: (updater: Updater<string>) => void;
  clearContext: () => void;
  resetProject: () => void;
  setCompressedContext: (ctx: CompressedContext) => void;
  setCompressedContextForConversation: (
    id: string,
    ctx: CompressedContext,
  ) => void;
  setLocalAgentSessionForConversation: (
    id: string,
    provider: LocalAgentProvider,
    session: LocalAgentSessionRef | undefined,
  ) => void;
  /** Drop every provider's session after the transcript is edited, so no
   * stale fingerprint can ever match again. */
  clearLocalAgentSessions: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  pinConversation: (id: string) => void;
  unpinConversation: (id: string) => void;
  archiveConversation: (id: string) => void;
  unarchiveConversation: (id: string) => void;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useConversationStore = create<ConversationState>()(
  persist(
    (rawSet, get) => {
      const set = (
        update:
          | Partial<ConversationState>
          | ((state: ConversationState) => Partial<ConversationState>),
      ) =>
        rawSet((previous) => {
          const patch =
            typeof update === "function" ? update(previous) : update;
          if (
            !patch.conversations ||
            patch.conversations === previous.conversations
          )
            return patch;
          // Freeze old positional links against the pre-edit transcript, before
          // clear/withdraw/filter operations can make an index name another turn.
          useSnapshotStore.getState().migrateLegacyMessageLinks();
          return {
            ...patch,
            conversations: Object.fromEntries(
              Object.entries(patch.conversations).map(([id, conversation]) => [
                id,
                conversation === previous.conversations[id]
                  ? conversation
                  : reconcileConversation(
                      conversation,
                      previous.conversations[id],
                    ),
              ]),
            ),
          };
        });
      return {
        conversations: {},
        activeId: null,
        _hasHydrated: false,
        legacyPlanModeMigrated: false,

        ensureWritableBranch: (id) => {
          const conversation = get().conversations[id];
          if (!conversation) return undefined;
          const next = writableConversation(conversation);
          if (next !== conversation)
            set((state) => ({
              conversations: { ...state.conversations, [id]: next },
            }));
          return get().conversations[id].activeBranchId;
        },

        setBranchHeadSnapshot: (id, snapshotId) => {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation || conversation.checkout) return state;
            const current = normalizeConversationBranches(conversation);
            const branchId = current.activeBranchId!;
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...current,
                  branches: {
                    ...current.branches,
                    [branchId]: {
                      ...current.branches![branchId],
                      headSnapshotId: snapshotId,
                    },
                  },
                },
              },
            };
          });
        },

        checkoutSnapshot: (id, snapshotId) => {
          const initial = get().conversations[id];
          if (!initial) return;
          const store = useSnapshotStore.getState();
          const snapshot = (store.snapshots[id] ?? []).find(
            (item) => item.id === snapshotId,
          );
          if (!snapshot)
            throw new Error("The requested project version no longer exists.");
          const files = removeDesignReferenceHeaders(
            store.reconstructFiles(id, snapshotId),
          );
          const assets = store.reconstructAssets(id, snapshotId);
          // Save dirty work before moving the cursor, never overwrite a version.
          if (!initial.checkout)
            store.updateLatestSnapshot(id, initial.files, initial.assets);
          const conversation = normalizeConversationBranches(
            get().conversations[id],
          );
          const branchId = snapshot.branchId ?? defaultBranchId(id);
          const source =
            conversation.branches?.[branchId]?.state ?? conversation;
          const messageId = canonicalSnapshotMessageId(snapshot, {
            ...conversation,
            messages: source.messages,
          });
          const linked = source.messages.some(
            (message) =>
              message.id && `${message.role}-${message.id}` === messageId,
          );
          const endIndex = snapshot.endMessageId
            ? source.messages.findIndex(
                (message) => message.id === snapshot.endMessageId,
              )
            : -1;
          const count = linked
            ? findAssistantGroupEnd(source.messages, messageId)
            : endIndex >= 0
              ? endIndex + 1
              : 0;
          set((state) => ({
            conversations: {
              ...state.conversations,
              [id]: {
                ...conversation,
                ...(snapshot.projectState ?? source),
                // Snapshot metadata must not replace the branch graph.
                messages: source.messages.slice(0, count),
                files,
                assets,
                compressedContext: undefined,
                localAgentSessions: undefined,
                pendingUserInstructions: [],
                activeBranchId: branchId,
                checkout: { branchId, snapshotId, messageId },
                checkoutEpoch: (conversation.checkoutEpoch ?? 0) + 1,
                activeFile:
                  snapshot.projectState?.activeFile &&
                  snapshot.projectState.activeFile in files
                    ? snapshot.projectState.activeFile
                    : Object.keys(files)[0],
                isProjectInitialized: Object.keys(files).length > 0,
                updatedAt: Date.now(),
              },
            },
          }));
        },

        switchBranch: (id, branchId) => {
          const initial = get().conversations[id];
          if (!initial) return;
          const normalized = normalizeConversationBranches(initial);
          if (!normalized.branches?.[branchId])
            throw new Error(
              "The requested conversation branch no longer exists.",
            );
          if (!normalized.checkout)
            useSnapshotStore
              .getState()
              .updateLatestSnapshot(id, normalized.files, normalized.assets);
          const conversation = normalizeConversationBranches(
            get().conversations[id],
          );
          const branch = conversation.branches![branchId];
          set((state) => ({
            conversations: {
              ...state.conversations,
              [id]: {
                ...conversation,
                ...branch.state,
                files: removeDesignReferenceHeaders(branch.state.files),
                activeBranchId: branchId,
                checkout: undefined,
                checkoutEpoch: (conversation.checkoutEpoch ?? 0) + 1,
                localAgentSessions: undefined,
                pendingUserInstructions: [],
                updatedAt: Date.now(),
              },
            },
          }));
        },

        createConversation: () => {
          const id = crypto.randomUUID();
          const conv: Conversation = {
            id,
            title: DEFAULT_TITLE,
            messages: [],
            files: {},
            assets: {},
            template: DEFAULT_PROJECT_TEMPLATE,
            previewMode: "sandpack",
            defaultPreviewView: "desktop",
            isProjectInitialized: false,
            workspaceMode: "auto",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          set((s) => ({
            conversations: { ...s.conversations, [id]: conv },
            activeId: id,
          }));
          return id;
        },

        addConversation: (conversation) => {
          const assets = normalizeProjectAssets(conversation.assets);
          const assetValidation = validateProjectAssets(assets);
          if (!assetValidation.ok) {
            throw new Error(assetValidation.error);
          }
          const preparedFiles = addProjectAssetModules(
            conversation.files,
            assets,
          );
          const validation = validateProjectFiles(preparedFiles);
          if (!validation.ok) {
            throw new Error(validation.error);
          }
          const id = conversation.id || crypto.randomUUID();
          const now = Date.now();
          const conv = normalizeConversationProjectState<Conversation>({
            ...conversation,
            id,
            title: conversation.title || DEFAULT_TITLE,
            messages: [...conversation.messages],
            files: { ...preparedFiles },
            assets,
            compressedContext: normalizeStoredCompressedContext(
              conversation.compressedContext,
            ),
            createdAt: conversation.createdAt || now,
            updatedAt: now,
          });
          set((s) => ({
            conversations: { ...s.conversations, [id]: conv },
            activeId: id,
          }));
          return id;
        },

        forkConversation: () => {
          const s = get();
          const src = s.activeId ? s.conversations[s.activeId] : null;
          const id = crypto.randomUUID();
          const conv = normalizeConversationProjectState<Conversation>({
            id,
            title: src ? src.title : DEFAULT_TITLE,
            messages: src ? [...src.messages] : [],
            files: src ? { ...src.files } : {},
            assets: src ? { ...(src.assets ?? {}) } : {},
            activeFile: src?.activeFile,
            template: src?.template ?? DEFAULT_PROJECT_TEMPLATE,
            previewMode: src?.previewMode ?? "sandpack",
            defaultPreviewView: normalizePreviewView(src?.defaultPreviewView),
            isProjectInitialized: src?.isProjectInitialized ?? false,
            workspaceMode: src?.workspaceMode ?? "auto",
            planReturnMode: src?.planReturnMode,
            designState: src?.designState
              ? {
                  ...src.designState,
                  selectedSystem: src.designState.selectedSystem
                    ? { ...src.designState.selectedSystem }
                    : undefined,
                  appliedSystem: src.designState.appliedSystem
                    ? { ...src.designState.appliedSystem }
                    : undefined,
                  recommendation: src.designState.recommendation
                    ? { ...src.designState.recommendation }
                    : undefined,
                }
              : undefined,
            compressedContext: normalizeStoredCompressedContext(
              src?.compressedContext,
            ),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          set({
            conversations: { ...s.conversations, [id]: conv },
            activeId: id,
          });
          return id;
        },

        deleteConversation: (id) => {
          const current = get();
          useProjectDesignWorkspaceStore.getState().clearConversation(id);
          const deletedAssets = current.conversations[id]
            ? conversationBranchStates(current.conversations[id]).map(
                (branch) => branch.assets,
              )
            : [];
          const deletedMessages = attachmentMessages(current.conversations[id]);
          const retainedMessages = Object.values(current.conversations)
            .filter((conversation) => conversation.id !== id)
            .flatMap(attachmentMessages);
          useSnapshotStore.getState().deleteSnapshotsForConversation(id);
          set((s) => {
            const { [id]: _, ...rest } = s.conversations;
            let nextActiveId = s.activeId;
            if (s.activeId === id) {
              const remaining = Object.values(rest).sort(
                (a, b) => b.updatedAt - a.updatedAt,
              );
              nextActiveId = remaining[0]?.id ?? null;
            }
            return { conversations: rest, activeId: nextActiveId };
          });
          void deleteAttachmentsForMessages(
            deletedMessages,
            retainedMessages,
          ).catch((error) => {
            console.warn("Failed to release conversation attachments:", error);
          });
          const candidateAssetRefs = collectProjectAssetBlobRefs(deletedAssets);
          if (candidateAssetRefs.size > 0) {
            void releaseUnreferencedProjectAssetBlobs(candidateAssetRefs, () =>
              retainedProjectAssetCollections(get()),
            ).catch((error) => {
              console.warn("Failed to release project assets:", error);
            });
          }
          void import("../lib/design/review-jobs/runner")
            .then(({ designReviewJobRunner }) => {
              designReviewJobRunner.removeConversation(id);
            })
            .catch((error) => {
              console.warn(
                "Failed to clear conversation Design Reviews:",
                error,
              );
            });
        },

        switchConversation: (id) => {
          const previousId = get().activeId;
          if (previousId && previousId !== id)
            get().cancelUserInstructions(previousId);
          set({ activeId: id });
        },

        setWorkspaceMode: (mode) => {
          set((state) => {
            const id = state.activeId;
            const conversation = id ? state.conversations[id] : undefined;
            if (!id || !conversation || conversation.workspaceMode === mode) {
              return state;
            }
            const currentMode = conversation.workspaceMode ?? "auto";
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...conversation,
                  workspaceMode: mode,
                  planReturnMode:
                    mode === "plan"
                      ? currentMode === "design"
                        ? "design"
                        : "auto"
                      : undefined,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        setDefaultPreviewView: (view) => {
          const activeId = get().activeId;
          if (activeId)
            get().setDefaultPreviewViewForConversation(activeId, view);
        },

        setDefaultPreviewViewForConversation: (id, view) => {
          const normalizedView = normalizePreviewView(view);
          set((state) => {
            const conversation = state.conversations[id];
            if (
              !conversation ||
              conversation.defaultPreviewView === normalizedView
            ) {
              return state;
            }
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...conversation,
                  defaultPreviewView: normalizedView,
                  updatedAt: Math.max(Date.now(), conversation.updatedAt + 1),
                },
              },
            };
          });
        },

        returnFromPlan: (requestedId) => {
          const state = get();
          const id = requestedId ?? state.activeId;
          const conversation = id ? state.conversations[id] : undefined;
          const returnMode =
            conversation?.planReturnMode === "design" ? "design" : "auto";
          if (!id || !conversation) return returnMode;
          set((current) => ({
            conversations: {
              ...current.conversations,
              [id]: {
                ...current.conversations[id],
                workspaceMode: returnMode,
                planReturnMode: undefined,
                updatedAt: Date.now(),
              },
            },
          }));
          return returnMode;
        },

        setDesignState: (updater) => {
          const id = get().activeId;
          if (id) get().setDesignStateForConversation(id, updater);
        },

        setDesignStateForConversation: (id, updater) => {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation) return state;
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...conversation,
                  designState: applyUpdater(updater, conversation.designState),
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        migrateLegacyPlanMode: (enabled) => {
          const state = get();
          if (state.legacyPlanModeMigrated) return false;
          const id = state.activeId;
          set((current) => {
            const conversation = id ? current.conversations[id] : undefined;
            return {
              legacyPlanModeMigrated: true,
              ...(enabled && id && conversation
                ? {
                    conversations: {
                      ...current.conversations,
                      [id]: {
                        ...conversation,
                        workspaceMode: "plan" as const,
                        planReturnMode: "auto" as const,
                        updatedAt: Date.now(),
                      },
                    },
                  }
                : {}),
            };
          });
          return enabled && !!id;
        },

        setPendingUserInstructions: (id, updater) => {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation) return state;
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...conversation,
                  pendingUserInstructions: applyUpdater(
                    updater,
                    conversation.pendingUserInstructions ?? [],
                  ),
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        cancelUserInstructions: (id, runId) => {
          get().setPendingUserInstructions(id, (items) =>
            items.map((item) =>
              (!runId || item.runId === runId) &&
              (item.status === "queued" || item.status === "delivering")
                ? { ...item, status: "cancelled" }
                : item,
            ),
          );
        },

        commitUserInstructions: (id, runId, instructionIds, messages) => {
          let committed = false;
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation || state.activeId !== id) return state;
            const pending = conversation.pendingUserInstructions ?? [];
            if (
              !instructionIds.length ||
              !instructionIds.every((instructionId) =>
                pending.some(
                  (item) =>
                    item.id === instructionId &&
                    item.runId === runId &&
                    item.status === "delivering",
                ),
              )
            )
              return state;
            const ids = new Set(instructionIds);
            const existing = new Set(
              conversation.messages.map(
                (message) => message.metadata?.instructionId,
              ),
            );
            committed = true;
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...conversation,
                  messages: [
                    ...conversation.messages,
                    ...messages.filter(
                      (message) =>
                        !existing.has(message.metadata?.instructionId),
                    ),
                  ],
                  pendingUserInstructions: pending.filter(
                    (item) => !ids.has(item.id),
                  ),
                  updatedAt: Date.now(),
                },
              },
            };
          });
          return committed;
        },

        setMessages: (updater) => {
          const activeId = get().activeId;
          if (activeId) get().setMessagesForConversation(activeId, updater);
        },

        setMessagesForConversation: (id, updater) => {
          set((s) => {
            if (!s.conversations[id]) return s;
            const conv = s.conversations[id];
            const newMessages = applyUpdater(updater, conv.messages);
            return {
              conversations: {
                ...s.conversations,
                [id]: {
                  ...conv,
                  messages: newMessages,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        withdrawLastUserMessage: (requestedId) => {
          const id = requestedId ?? get().activeId;
          const conversation = id ? get().conversations[id] : undefined;
          const withdrawableIndex = conversation
            ? findWithdrawableUserMessageIndex(conversation.messages)
            : null;
          const lastMessage =
            withdrawableIndex === null
              ? undefined
              : conversation?.messages[withdrawableIndex];
          if (
            !id ||
            !conversation ||
            !lastMessage ||
            lastMessage.role !== "user" ||
            lastMessage.metadata?.origin
          ) {
            return undefined;
          }

          let removed = false;
          set((state) => {
            const current = state.conversations[id];
            const currentIndex = current
              ? findWithdrawableUserMessageIndex(current.messages)
              : null;
            const currentLast =
              currentIndex === null
                ? undefined
                : current?.messages[currentIndex];
            if (
              !current ||
              currentIndex === null ||
              currentLast !== lastMessage ||
              currentLast.role !== "user" ||
              currentLast.metadata?.origin
            ) {
              return state;
            }
            removed = true;
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...current,
                  messages: current.messages.slice(0, currentIndex),
                  updatedAt: Date.now(),
                },
              },
            };
          });
          return removed ? lastMessage : undefined;
        },

        setFiles: (updater) => {
          const activeId = get().activeId;
          if (activeId) get().setFilesForConversation(activeId, updater);
        },

        setFilesForConversation: (id, updater) => {
          set((s) => {
            if (!s.conversations[id]) return s;
            const conv = s.conversations[id];
            let files: ProjectFiles;
            try {
              files = addProjectAssetModules(
                applyUpdater(updater, conv.files),
                conv.assets ?? {},
              );
            } catch (error) {
              console.warn(
                "[conversation] Rejected project files:",
                error instanceof Error ? error.message : String(error),
              );
              return s;
            }
            const validation = validateProjectFiles(files);
            if (!validation.ok) {
              console.warn(
                "[conversation] Rejected project files:",
                validation.error,
              );
              return s;
            }
            const nextConversation = normalizeConversationProjectState({
              ...conv,
              files,
              updatedAt: Date.now(),
            });
            return {
              conversations: {
                ...s.conversations,
                [id]: nextConversation,
              },
            };
          });
        },

        setAssetsForConversation: (id, updater) => {
          const previousAssets = get().conversations[id]?.assets ?? {};
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation) return state;
            const requestedAssets = applyUpdater(
              updater,
              conversation.assets ?? {},
            );
            const assets = normalizeProjectAssets(requestedAssets);
            if (
              Object.keys(assets).length !== Object.keys(requestedAssets).length
            ) {
              console.warn(
                "[conversation] Rejected malformed project asset records.",
              );
              return state;
            }
            const validation = validateProjectAssets(assets);
            if (!validation.ok) {
              console.warn(
                "[conversation] Rejected project assets:",
                validation.error,
              );
              return state;
            }
            let files: ProjectFiles;
            try {
              files = syncProjectAssetModules(
                conversation.files,
                conversation.assets ?? {},
                assets,
              );
            } catch (error) {
              console.warn(
                "[conversation] Rejected project assets:",
                error instanceof Error ? error.message : String(error),
              );
              return state;
            }
            return {
              conversations: {
                ...state.conversations,
                [id]: { ...conversation, files, assets, updatedAt: Date.now() },
              },
            };
          });
          const candidateAssetRefs = collectProjectAssetBlobRefs([
            previousAssets,
          ]);
          if (candidateAssetRefs.size > 0) {
            void releaseUnreferencedProjectAssetBlobs(candidateAssetRefs, () =>
              retainedProjectAssetCollections(get()),
            ).catch((error) => {
              console.warn("Failed to release project assets:", error);
            });
          }
        },

        addProjectAsset: (id, asset) => {
          const conversation = get().conversations[id];
          if (!conversation) {
            return {
              ok: false,
              error: "The target conversation does not exist.",
            };
          }
          if (
            conversation.files[asset.path] !== undefined ||
            conversation.assets?.[asset.path]
          ) {
            return {
              ok: false,
              error: `Project path "${asset.path}" already exists.`,
            };
          }
          const assets = {
            ...(conversation.assets ?? {}),
            [asset.path]: asset,
          };
          const assetValidation = validateProjectAssets(assets);
          if (!assetValidation.ok) return assetValidation;
          let files: ProjectFiles;
          try {
            files = addProjectAssetModules(conversation.files, assets);
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          set((state) => {
            const current = state.conversations[id];
            if (current !== conversation) return state;
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...conversation,
                  files,
                  assets,
                  updatedAt: Date.now(),
                },
              },
            };
          });
          if (get().conversations[id] === conversation) {
            return {
              ok: false,
              error: "The project changed while importing the asset.",
            };
          }
          return { ok: true };
        },

        replaceProject: ({
          files,
          assets = {},
          template,
          previewMode,
          activeFile,
        }) => {
          const activeId = get().activeId;
          if (!activeId || !get().conversations[activeId]) {
            return { ok: false, error: "No active conversation." };
          }
          const preparedAssets = normalizeProjectAssets(assets);
          if (
            Object.keys(preparedAssets).length !== Object.keys(assets).length
          ) {
            return { ok: false, error: "Project assets are invalid." };
          }
          let preparedFiles: ProjectFiles;
          try {
            preparedFiles = addProjectAssetModules(files, preparedAssets);
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          const validation = validateProjectFiles(preparedFiles);
          if (!validation.ok) {
            return { ok: false, error: validation.error };
          }
          const assetValidation = validateProjectAssets(preparedAssets);
          if (!assetValidation.ok) return assetValidation;
          const previousAssets = conversationBranchStates(
            get().conversations[activeId],
          ).map((branch) => branch.assets);
          const paths = Object.keys(preparedFiles);
          const nextActiveFile =
            activeFile && activeFile in preparedFiles ? activeFile : paths[0];
          useProjectDesignWorkspaceStore.getState().clearConversation(activeId);
          useSnapshotStore.getState().deleteSnapshotsForConversation(activeId);
          set((state) => {
            const conversation = state.conversations[activeId];
            if (!conversation) return state;
            return {
              conversations: {
                ...state.conversations,
                [activeId]: {
                  ...conversation,
                  pendingUserInstructions:
                    conversation.pendingUserInstructions?.map((item) => ({
                      ...item,
                      status: "cancelled" as const,
                    })),
                  branches: undefined,
                  activeBranchId: undefined,
                  checkout: undefined,
                  checkoutEpoch: (conversation.checkoutEpoch ?? 0) + 1,
                  files: { ...preparedFiles },
                  assets: { ...preparedAssets },
                  template,
                  previewMode,
                  defaultPreviewView: "desktop",
                  activeFile: nextActiveFile,
                  isProjectInitialized: paths.length > 0,
                  localAgentSessions: undefined,
                  designState: undefined,
                  updatedAt: Date.now(),
                },
              },
            };
          });
          const candidateAssetRefs =
            collectProjectAssetBlobRefs(previousAssets);
          if (candidateAssetRefs.size > 0) {
            void releaseUnreferencedProjectAssetBlobs(candidateAssetRefs, () =>
              retainedProjectAssetCollections(get()),
            ).catch((error) => {
              console.warn("Failed to release project assets:", error);
            });
          }
          return { ok: true };
        },

        setActiveFile: (path) => {
          const activeId = get().activeId;
          const conv = activeId ? get().conversations[activeId] : undefined;
          if (!activeId || !conv || !(path in conv.files)) return;
          set((state) => ({
            conversations: {
              ...state.conversations,
              [activeId]: {
                ...conv,
                activeFile: path,
                updatedAt: Date.now(),
              },
            },
          }));
        },

        clearContext: () => {
          set((s) => {
            if (!s.activeId || !s.conversations[s.activeId]) return s;
            const conv = s.conversations[s.activeId];
            return {
              conversations: {
                ...s.conversations,
                [s.activeId]: {
                  ...conv,
                  messages: [],
                  compressedContext: undefined,
                  localAgentSessions: undefined,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        resetProject: () => {
          const activeId = get().activeId;
          if (!activeId || !get().conversations[activeId]) return;
          useProjectDesignWorkspaceStore.getState().clearConversation(activeId);
          const previousAssets = conversationBranchStates(
            get().conversations[activeId],
          ).map((branch) => branch.assets);
          useSnapshotStore.getState().deleteSnapshotsForConversation(activeId);
          set((s) => {
            const conv = s.conversations[activeId];
            if (!conv) return s;
            return {
              conversations: {
                ...s.conversations,
                [activeId]: {
                  ...conv,
                  branches: undefined,
                  activeBranchId: undefined,
                  checkout: undefined,
                  checkoutEpoch: (conv.checkoutEpoch ?? 0) + 1,
                  pendingUserInstructions: [],
                  messages: [],
                  files: {},
                  assets: {},
                  template: DEFAULT_PROJECT_TEMPLATE,
                  previewMode: "sandpack",
                  defaultPreviewView: "desktop",
                  isProjectInitialized: false,
                  compressedContext: undefined,
                  localAgentSessions: undefined,
                  activeFile: undefined,
                  designState: undefined,
                  updatedAt: Date.now(),
                },
              },
            };
          });
          const candidateAssetRefs =
            collectProjectAssetBlobRefs(previousAssets);
          if (candidateAssetRefs.size > 0) {
            void releaseUnreferencedProjectAssetBlobs(candidateAssetRefs, () =>
              retainedProjectAssetCollections(get()),
            ).catch((error) => {
              console.warn("Failed to release project assets:", error);
            });
          }
        },

        setTemplate: (updater) => {
          set((s) => {
            if (!s.activeId || !s.conversations[s.activeId]) return s;
            const conv = s.conversations[s.activeId];
            return {
              conversations: {
                ...s.conversations,
                [s.activeId]: {
                  ...conv,
                  template: applyUpdater(updater, conv.template),
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        setCompressedContext: (ctx) => {
          const activeId = get().activeId;
          if (activeId)
            get().setCompressedContextForConversation(activeId, ctx);
        },

        setCompressedContextForConversation: (id, ctx) => {
          set((s) => {
            if (!s.conversations[id]) return s;
            const conv = s.conversations[id];
            const normalizedContext = normalizeStoredCompressedContext(ctx);
            return {
              conversations: {
                ...s.conversations,
                [id]: {
                  ...conv,
                  compressedContext: normalizedContext,
                  localAgentSessions: undefined,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        setLocalAgentSessionForConversation: (id, provider, session) => {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation) return state;
            const localAgentSessions = {
              ...(conversation.localAgentSessions ?? {}),
            };
            if (session) localAgentSessions[provider] = session;
            else delete localAgentSessions[provider];
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...conversation,
                  localAgentSessions:
                    Object.keys(localAgentSessions).length > 0
                      ? localAgentSessions
                      : undefined,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        clearLocalAgentSessions: (id) => {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation?.localAgentSessions) return state;
            return {
              conversations: {
                ...state.conversations,
                [id]: {
                  ...conversation,
                  localAgentSessions: undefined,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        renameConversation: (id, title) => {
          set((s) => {
            if (!s.conversations[id]) return s;
            return {
              conversations: {
                ...s.conversations,
                [id]: { ...s.conversations[id], title, updatedAt: Date.now() },
              },
            };
          });
        },

        pinConversation: (id) => {
          set((s) => {
            if (!s.conversations[id]) return s;
            return {
              conversations: {
                ...s.conversations,
                [id]: {
                  ...s.conversations[id],
                  pinned: true,
                  archived: false,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        unpinConversation: (id) => {
          set((s) => {
            if (!s.conversations[id]) return s;
            return {
              conversations: {
                ...s.conversations,
                [id]: {
                  ...s.conversations[id],
                  pinned: false,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        archiveConversation: (id) => {
          set((s) => {
            if (!s.conversations[id]) return s;
            return {
              conversations: {
                ...s.conversations,
                [id]: {
                  ...s.conversations[id],
                  archived: true,
                  pinned: false,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        unarchiveConversation: (id) => {
          set((s) => {
            if (!s.conversations[id]) return s;
            return {
              conversations: {
                ...s.conversations,
                [id]: {
                  ...s.conversations[id],
                  archived: false,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },
      };
    },
    {
      name: "open-builder-conversations",
      version: CONVERSATION_STORE_VERSION,
      storage: createJSONStorage(() => localforageStorage),
      partialize: (state) => ({
        conversations: state.conversations,
        activeId: state.activeId,
        legacyPlanModeMigrated: state.legacyPlanModeMigrated,
      }),
      migrate: (persisted, version) =>
        migrateConversationState(persisted, version),
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Migrate old hardcoded default titles to sentinel value
          const convs = state.conversations;
          let changed = false;
          for (const id of Object.keys(convs)) {
            if (
              convs[id].pendingUserInstructions?.some(
                (item) =>
                  item.status === "queued" || item.status === "delivering",
              )
            ) {
              convs[id] = {
                ...convs[id],
                pendingUserInstructions: convs[id].pendingUserInstructions?.map(
                  (item) =>
                    item.status === "queued" || item.status === "delivering"
                      ? { ...item, status: "cancelled" as const }
                      : item,
                ),
              };
              changed = true;
            }
            if (convs[id].title === "新应用" || convs[id].title === "New App") {
              convs[id] = { ...convs[id], title: DEFAULT_TITLE };
              changed = true;
            }
            const compressedContext = normalizeStoredCompressedContext(
              convs[id].compressedContext,
            );
            if (
              compressedContext?.summary !==
                convs[id].compressedContext?.summary ||
              compressedContext?.fromIndex !==
                convs[id].compressedContext?.fromIndex
            ) {
              convs[id] = { ...convs[id], compressedContext };
              changed = true;
            }
            const normalized = normalizeConversationBranches(
              normalizeConversationProjectState(convs[id]),
            );
            if (normalized !== convs[id]) {
              convs[id] = normalized;
              changed = true;
            }
          }
          if (changed) {
            useConversationStore.setState({ conversations: { ...convs } });
          }
        }
        useConversationStore.setState({ _hasHydrated: true });
        if (useSnapshotStore?.getState()._hasHydrated)
          useSnapshotStore.getState().migrateLegacyMessageLinks();
      },
    },
  ),
);
