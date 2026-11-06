import { expect, type Page } from "@playwright/test";

/** Fixture writes must follow hydration and the app's initial Conversation. */
export async function waitForAppReady(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const conversationUrl = "/src/store/conversation.ts";
        const snapshotsUrl = "/src/store/snapshot.ts";
        const archivesUrl = "/src/store/project-archives.ts";
        const { useConversationStore } = await import(conversationUrl);
        const { useSnapshotStore } = await import(snapshotsUrl);
        const { useProjectArchiveStore } = await import(archivesUrl);
        const state = useConversationStore.getState();
        return Boolean(
          state._hasHydrated &&
          state.activeId &&
          state.conversations[state.activeId] &&
          useSnapshotStore.getState()._hasHydrated &&
          useProjectArchiveStore.getState()._hasHydrated,
        );
      }),
    )
    .toBe(true);
}
