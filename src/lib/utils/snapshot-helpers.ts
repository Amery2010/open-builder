import { mergeMessages } from "./merge-messages";
import { useConversationStore } from "../../store/conversation";
import { useSnapshotStore } from "../../store/snapshot";

/**
 * Snapshot the current files of the active conversation, keyed to its latest
 * assistant message so the user can roll back to this exact UI state.
 */
export function createSnapshotForCurrentState(): void {
  const state = useConversationStore.getState();
  const conv = state.activeId ? state.conversations[state.activeId] : null;
  if (!conv || Object.keys(conv.files).length === 0) return;
  const merged = mergeMessages(conv.messages);
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].role === "assistant") {
      useSnapshotStore
        .getState()
        .createSnapshot(conv.id, merged[i].id, conv.files, conv.assets ?? {});
      return;
    }
  }
}
