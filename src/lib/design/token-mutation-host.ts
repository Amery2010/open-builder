import { reconcileConversation } from "../conversation/branches";
import { useConversationStore } from "../../store/conversation";
import { useDesignReviewStore } from "../../store/design-review";
import { useSnapshotStore } from "../../store/snapshot";
import type { FileChange, ProjectFiles } from "../../types";
import { validateProjectFiles } from "../utils/project-files";
import { createDesignTokenSnapshot } from "./token-snapshot";
import {
  mutateDesignTokens,
  type DesignTokenChange,
  type DesignTokenMutationResult,
} from "./token-mutation";
import type { DesignContract } from "./run-contract";

export interface MutateConversationDesignTokensInput {
  conversationId: string;
  changes: readonly DesignTokenChange[];
  principal: "model" | "user";
  acceptedDesignContract?: DesignContract | unknown;
  snapshotLabel?: string;
  onProjectFilesChanged?: (
    files: ProjectFiles,
    changes: readonly FileChange[],
  ) => void;
}

/** Production adapter for the store-backed Design Token transaction. */
export async function mutateConversationDesignTokens(
  input: MutateConversationDesignTokensInput,
): Promise<DesignTokenMutationResult> {
  const initial =
    useConversationStore.getState().conversations[input.conversationId];
  if (!initial) {
    return {
      ok: false,
      code: "stale_revision",
      error: "The Design project is no longer available.",
      conversationId: input.conversationId,
    };
  }
  const expectedRevision = initial.updatedAt;
  let createdSnapshotId: string | undefined;
  let committedConversation: typeof initial | undefined;

  return mutateDesignTokens(
    {
      conversationId: input.conversationId,
      expectedRevision,
      changes: input.changes,
      principal: input.principal,
      acceptedDesignContract: input.acceptedDesignContract,
    },
    {
      readProject: (conversationId) => {
        const state = useConversationStore.getState();
        const conversation = state.conversations[conversationId];
        if (
          !conversation ||
          state.activeId !== conversationId ||
          conversation !== initial
        ) {
          throw new Error("The active Conversation changed.");
        }
        return {
          conversationId,
          files: conversation.files,
          revision: conversation.updatedAt,
          designState: conversation.designState,
        };
      },
      prepareSnapshot: () => {
        if (!useSnapshotStore.getState()._hasHydrated) {
          throw new Error("Snapshot storage is not ready.");
        }
        return {
          reservationId: crypto.randomUUID(),
          discard: () => {
            if (!createdSnapshotId) return;
            useSnapshotStore
              .getState()
              .deleteSnapshot(input.conversationId, createdSnapshotId);
            createdSnapshotId = undefined;
          },
        };
      },
      commitProject: (request) => {
        const validation = validateProjectFiles(request.nextFiles);
        if (!validation.ok) throw new Error(validation.error);
        let previousFiles: ProjectFiles | undefined;
        let committedRevision: number | undefined;
        useConversationStore.setState((state) => {
          const conversation = state.conversations[request.conversationId];
          if (
            !conversation ||
            state.activeId !== request.conversationId ||
            conversation !== initial ||
            conversation.updatedAt !== request.currentRevision
          ) {
            return state;
          }
          previousFiles = conversation.files;
          committedRevision = Math.max(Date.now(), conversation.updatedAt + 1);
          committedConversation = reconcileConversation(
            {
              ...conversation,
              files: { ...request.nextFiles },
              isProjectInitialized: Object.keys(request.nextFiles).length > 0,
              updatedAt: committedRevision,
            },
            conversation,
          );
          return {
            conversations: {
              ...state.conversations,
              [request.conversationId]: committedConversation,
            },
          };
        });
        if (!previousFiles || committedRevision === undefined) {
          throw new Error("The project revision changed before commit.");
        }
        const changedTokenPath = Object.keys(request.nextFiles).find(
          (path) => request.previousFiles[path] !== request.nextFiles[path],
        );
        const fileChanges: FileChange[] = [
          { path: changedTokenPath ?? "tokens.css", action: "modified" },
        ];
        try {
          input.onProjectFilesChanged?.(request.nextFiles, fileChanges);
        } catch (error) {
          useConversationStore.setState((state) => {
            const conversation = state.conversations[request.conversationId];
            if (
              !conversation ||
              conversation !== committedConversation ||
              conversation.updatedAt !== committedRevision
            ) {
              return state;
            }
            return {
              conversations: {
                ...state.conversations,
                [request.conversationId]: reconcileConversation(
                  {
                    ...initial,
                    files: previousFiles!,
                    updatedAt: request.currentRevision as number,
                  },
                  conversation,
                ),
              },
            };
          });
          throw error;
        }
        return {
          committedRevision,
          rollback: () => {
            let rolledBack = false;
            useConversationStore.setState((state) => {
              const conversation = state.conversations[request.conversationId];
              if (
                !conversation ||
                conversation !== committedConversation ||
                conversation.updatedAt !== committedRevision
              ) {
                return state;
              }
              rolledBack = true;
              return {
                conversations: {
                  ...state.conversations,
                  [request.conversationId]: reconcileConversation(
                    {
                      ...initial,
                      files: previousFiles!,
                      updatedAt: request.currentRevision as number,
                    },
                    conversation,
                  ),
                },
              };
            });
            if (!rolledBack) {
              throw new Error("The project changed before token rollback.");
            }
            input.onProjectFilesChanged?.(previousFiles!, fileChanges);
          },
        };
      },
      invalidateReview: ({ committedRevision }) => {
        const before = useDesignReviewStore.getState();
        const previousRuns = before.runsByConversation[input.conversationId];
        const previousSelected =
          before.selectedRunIdByConversation[input.conversationId];
        const previousVolatile = {
          status: before.status,
          screenshots: before.screenshots,
          report: before.report,
          error: before.error,
          captureErrors: before.captureErrors,
          captureProgress: before.captureProgress,
          selectedFindingIds: before.selectedFindingIds,
          automatic: before.automatic,
        };
        before.reset();
        before.markConversationFreshness(
          input.conversationId,
          `design-token-mutation:${committedRevision}`,
        );
        return {
          rollback: () => {
            useDesignReviewStore.setState((state) => ({
              ...previousVolatile,
              runsByConversation: {
                ...state.runsByConversation,
                [input.conversationId]: previousRuns ?? [],
              },
              selectedRunIdByConversation: {
                ...state.selectedRunIdByConversation,
                [input.conversationId]: previousSelected,
              },
            }));
          },
        };
      },
      finalizeSnapshot: (_reservation, request) => {
        createdSnapshotId = createDesignTokenSnapshot(
          request.conversationId,
          request.nextFiles,
          request.label,
        );
        if (!createdSnapshotId) {
          throw new Error("Snapshot storage rejected the Design Token update.");
        }
        return createdSnapshotId;
      },
    },
    { snapshotLabel: input.snapshotLabel },
  );
}
