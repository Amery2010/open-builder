import { useState, useCallback } from "react";
import { findPrecedingUserLabel } from "../lib/utils/message-navigation";
import { useConversationStore } from "../store/conversation";
import { useSnapshotStore } from "../store/snapshot";
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
}

export function useRollback({
  activeId,
  messages,
  snapshotsLength,
  onSetFiles,
}: UseRollbackArgs) {
  const [rollbackConfirmId, setRollbackConfirmId] = useState<string | null>(
    null,
  );
  const [rollbackInfo, setRollbackInfo] = useState<RollbackInfo | null>(null);

  const flushSnapshotUpdate = useCallback(() => {
    if (!activeId || snapshotsLength === 0) return;
    const conversation =
      useConversationStore.getState().conversations[activeId];
    if (conversation) {
      useSnapshotStore
        .getState()
        .updateLatestSnapshot(
          activeId,
          conversation.files,
          conversation.assets,
        );
    }
  }, [activeId, snapshotsLength]);

  const handleRollback = useCallback(
    (messageId: string) => {
      if (!activeId) return;
      flushSnapshotUpdate();
      const snap = useSnapshotStore
        .getState()
        .getSnapshotByMessageId(activeId, messageId);
      if (!snap) return;
      const restoredFiles = useSnapshotStore
        .getState()
        .reconstructFiles(activeId, snap.id);
      const restoredAssets = useSnapshotStore
        .getState()
        .reconstructAssets(activeId, snap.id);
      onSetFiles(restoredFiles);
      useConversationStore
        .getState()
        .setAssetsForConversation(activeId, restoredAssets);
      setRollbackConfirmId(null);
      const label = findPrecedingUserLabel(messages, messageId);
      setRollbackInfo({ messageId, label });
    },
    [activeId, onSetFiles, messages, flushSnapshotUpdate],
  );

  return {
    rollbackConfirmId,
    setRollbackConfirmId,
    rollbackInfo,
    setRollbackInfo,
    handleRollback,
    flushSnapshotUpdate,
  };
}
