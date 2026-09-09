import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import localforage from "localforage";
import { useSnapshotStore } from "./snapshot";
import { useProjectTemplateStore } from "./project-templates";
import { runMigrations, type MigrationStep } from "./utils/migrate";
import type {
  Conversation,
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

const CONVERSATION_STORE_VERSION = 6;
const DEFAULT_PROJECT_TEMPLATE = "vite-react-ts";

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
    ...Object.values(conversationState.conversations).map(
      (conversation) => conversation.assets,
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
  let files = normalizeProjectFiles(conversation.files);
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
        normalizeConversationProjectState(conversation as Conversation),
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

const localforageStorage = {
  getItem: async (name: string) => {
    const value = await localforage.getItem<string>(name);
    return value ?? null;
  },
  setItem: async (name: string, value: string) => {
    await localforage.setItem(name, value);
  },
  removeItem: async (name: string) => {
    await localforage.removeItem(name);
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
    (set, get) => ({
      conversations: {},
      activeId: null,
      _hasHydrated: false,
      legacyPlanModeMigrated: false,

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
        const deletedAssets = current.conversations[id]?.assets;
        const deletedMessages = current.conversations[id]?.messages ?? [];
        const retainedMessages = Object.values(current.conversations)
          .filter((conversation) => conversation.id !== id)
          .flatMap((conversation) => conversation.messages);
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
        const candidateAssetRefs = collectProjectAssetBlobRefs([deletedAssets]);
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
            console.warn("Failed to clear conversation Design Reviews:", error);
          });
      },

      switchConversation: (id) => {
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
            currentIndex === null ? undefined : current?.messages[currentIndex];
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
        const assets = { ...(conversation.assets ?? {}), [asset.path]: asset };
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
        if (Object.keys(preparedAssets).length !== Object.keys(assets).length) {
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
        const previousAssets = get().conversations[activeId].assets;
        const paths = Object.keys(preparedFiles);
        const nextActiveFile =
          activeFile && activeFile in preparedFiles ? activeFile : paths[0];
        useSnapshotStore.getState().deleteSnapshotsForConversation(activeId);
        set((state) => {
          const conversation = state.conversations[activeId];
          if (!conversation) return state;
          return {
            conversations: {
              ...state.conversations,
              [activeId]: {
                ...conversation,
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
        const previousAssets = get().conversations[activeId].assets;
        useSnapshotStore.getState().deleteSnapshotsForConversation(activeId);
        set((s) => {
          const conv = s.conversations[activeId];
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [activeId]: {
                ...conv,
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
        if (activeId) get().setCompressedContextForConversation(activeId, ctx);
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
    }),
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
            const normalized = normalizeConversationProjectState(convs[id]);
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
      },
    },
  ),
);
