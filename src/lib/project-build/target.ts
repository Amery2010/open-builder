import type { ProjectAssets, ProjectFiles } from "../../types";
import { useConversationStore } from "../../store/conversation";
import { useSnapshotStore } from "../../store/snapshot";
import { resolveSnapshotArchiveSource } from "../project-archives/service";

export type ProjectBuildTarget =
  | { kind: "current"; conversationId: string }
  | { kind: "snapshot"; conversationId: string; snapshotId: string };

export interface ResolvedBuildTarget {
  files: ProjectFiles;
  assets: ProjectAssets;
  isCurrent: () => boolean;
}

/** Capture one version when the dialog opens or the user starts a fresh build. */
export function resolveBuildTarget(
  target: ProjectBuildTarget,
): ResolvedBuildTarget | undefined {
  const conversation =
    useConversationStore.getState().conversations[target.conversationId];
  if (!conversation) return undefined;
  const active = () => {
    const state = useConversationStore.getState();
    return (
      state.activeId === target.conversationId &&
      !!state.conversations[target.conversationId]
    );
  };
  if (target.kind === "snapshot") {
    const exists = () =>
      useSnapshotStore
        .getState()
        .snapshots[target.conversationId]?.some(
          (snapshot) => snapshot.id === target.snapshotId && !snapshot.hidden,
        ) ?? false;
    if (!exists()) return undefined;
    const source = resolveSnapshotArchiveSource(
      target.conversationId,
      target.snapshotId,
    );
    if (!source) return undefined;
    return {
      files: source.files,
      assets: source.assets,
      isCurrent: () => active() && exists(),
    };
  }
  return {
    files: conversation.files,
    assets: conversation.assets ?? {},
    isCurrent: () => {
      const latest =
        useConversationStore.getState().conversations[target.conversationId];
      return (
        active() &&
        latest?.files === conversation.files &&
        latest?.assets === conversation.assets
      );
    },
  };
}
