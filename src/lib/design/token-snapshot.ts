import type { ProjectFiles } from "../../types";
import { useConversationStore } from "../../store/conversation";
import { useSnapshotStore } from "../../store/snapshot";

export function createDesignTokenSnapshot(
  conversationId: string,
  files: ProjectFiles,
  label: string,
): string | undefined {
  const messageId = `design-tokens-${Date.now()}-${crypto.randomUUID()}`;
  const store = useSnapshotStore.getState();
  const assets =
    useConversationStore.getState().conversations[conversationId]?.assets ?? {};
  store.createSnapshot(conversationId, messageId, files, assets);
  const snapshot = store.getSnapshotByMessageId(conversationId, messageId);
  if (!snapshot) return undefined;
  store.renameSnapshot(conversationId, snapshot.id, label);
  return snapshot.id;
}
