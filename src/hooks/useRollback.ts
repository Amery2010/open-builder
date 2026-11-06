import { useState, useCallback } from "react";
import { findPrecedingUserLabel } from "../lib/utils/message-navigation";
import { useConversationStore } from "../store/conversation";
import { useSnapshotStore } from "../store/snapshot";
import { flushPendingSandpackFileChanges } from "../components/code-viewer/sandpack-file-changes";
import type { Message, ProjectFiles } from "../types";

export interface RollbackInfo {
  messageId: string;
  label: string;
}

interface UseRollbackArgs {
  activeId: string | null;
  messages: Message[];
  snapshotsLength: number;
  onSetFiles: (files: ProjectFiles) => void;
  onBeforeCheckout?: () => void;
}

export function useRollback({
  activeId,
  messages,
  onBeforeCheckout,
}: UseRollbackArgs) {
  const [rollbackConfirmId, setRollbackConfirmId] = useState<string | null>(
    null,
  );
  const [dismissedSnapshotId, setDismissedSnapshotId] = useState<string | null>(
    null,
  );
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const checkout = useConversationStore((state) =>
    activeId ? state.conversations[activeId]?.checkout : undefined,
  );
  const rollbackInfo: RollbackInfo | null =
    checkout && checkout.snapshotId !== dismissedSnapshotId
      ? {
          messageId: checkout.messageId,
          label: findPrecedingUserLabel(messages, checkout.messageId),
        }
      : null;

  const flushSnapshotUpdate = useCallback(() => {
    if (!activeId) return;
    flushPendingSandpackFileChanges(activeId);
    const conversation =
      useConversationStore.getState().conversations[activeId];
    if (conversation && !conversation.checkout) {
      useSnapshotStore
        .getState()
        .updateLatestSnapshot(
          activeId,
          conversation.files,
          conversation.assets,
        );
    }
  }, [activeId]);

  const handleRollback = useCallback(
    (messageOrSnapshotId: string) => {
      if (!activeId) return;
      try {
        onBeforeCheckout?.();
        flushSnapshotUpdate();
        const snapshots = useSnapshotStore.getState();
        const snapshot =
          snapshots.snapshots[activeId]?.find(
            (item) => item.id === messageOrSnapshotId,
          ) ?? snapshots.getSnapshotByMessageId(activeId, messageOrSnapshotId);
        if (!snapshot)
          throw new Error("The requested checkpoint is unavailable.");
        useConversationStore.getState().checkoutSnapshot(activeId, snapshot.id);
        setRollbackConfirmId(null);
        setDismissedSnapshotId(null);
        setRollbackError(null);
      } catch (error) {
        setRollbackConfirmId(null);
        setRollbackError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [activeId, flushSnapshotUpdate, onBeforeCheckout],
  );

  const setRollbackInfo = useCallback(
    (_value: null) => {
      setDismissedSnapshotId(checkout?.snapshotId ?? null);
    },
    [checkout?.snapshotId],
  );

  return {
    rollbackConfirmId,
    setRollbackConfirmId,
    rollbackInfo,
    setRollbackInfo,
    rollbackError,
    handleRollback,
    flushSnapshotUpdate,
  };
}
