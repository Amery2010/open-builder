import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("localforage", () => {
  const adapter = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };
  return { default: { ...adapter, createInstance: () => adapter } };
});
import { useConversationStore, migrateConversationState } from "./conversation";
import { useSnapshotStore, selectVisibleSnapshots } from "./snapshot";
import {
  captureConversationIdentity,
  isConversationIdentityCurrent,
} from "../lib/conversation/branches";
import { mergeMessages } from "../lib/utils/merge-messages";
import { replaySnapshots } from "./snapshot-replay";
import { messagesToModelMessages } from "../lib/ai/messages";
import { filterMemoryMessages } from "../lib/utils/memory-filter";
import { findAssistantGroupEnd } from "../lib/utils/message-navigation";
import type { ProjectAsset } from "../types";

const store = () => useConversationStore.getState();
const snaps = () => useSnapshotStore.getState();
const current = (id: string) => store().conversations[id];
function turn(id: string, name: string, files = { "a.txt": name }) {
  store().setMessagesForConversation(id, (messages) => [
    ...messages,
    { role: "user", content: name },
    { role: "assistant", content: `Done ${name}` },
  ]);
  store().setFilesForConversation(id, files);
  const messageId = mergeMessages(current(id).messages).at(-1)!.id;
  return snaps().createSnapshot(
    id,
    messageId,
    current(id).files,
    current(id).assets,
  )!;
}

beforeEach(() => {
  useConversationStore.setState({
    conversations: {},
    activeId: null,
    _hasHydrated: false,
  });
  useSnapshotStore.setState({ snapshots: {}, _hasHydrated: false });
});

describe("conversation branches and immutable versions", () => {
  it("cleans restored Design headers without rewriting the historical snapshot", () => {
    const id = store().createConversation();
    turn(id, "A");
    const legacy = {
      "DESIGN.md":
        "<!-- Untrusted visual reference. Source: https://example.test/DESIGN.md; sha256: abc -->\n\n# Reference",
    };
    const snapshot = snaps().createSnapshot(id, "legacy-design", legacy, {})!;
    // Keep the current project at a historical cursor so checkout cannot refresh its head.
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          checkout: {
            branchId: current(id).activeBranchId!,
            snapshotId: snapshot.id,
            messageId: "legacy-design",
          },
        },
      },
    }));
    const serialized = JSON.stringify(snaps().snapshots[id]);
    store().checkoutSnapshot(id, snapshot.id);
    expect(current(id).files["DESIGN.md"]).toBe("# Reference");
    expect(snaps().reconstructFiles(id, snapshot.id)).toEqual(legacy);
    expect(JSON.stringify(snaps().snapshots[id])).toBe(serialized);
  });

  it("preserves C after checkout B and continuation D, including serialized reload", () => {
    const id = store().createConversation();
    turn(id, "A");
    const b = turn(id, "B");
    const c = turn(id, "C", { "c.txt": "C" } as unknown as { "a.txt": string });
    const main = current(id).activeBranchId!;
    const oldIdentity = captureConversationIdentity(current(id));
    store().checkoutSnapshot(id, b.id);
    expect(current(id).files).toEqual({ "a.txt": "B" });
    expect(current(id).messages.at(-1)?.content).toBe("Done B");
    expect(isConversationIdentityCurrent(oldIdentity, current(id))).toBe(false);
    expect(current(id).branches![main].state.messages.at(-1)?.content).toBe(
      "Done C",
    );
    const child = store().ensureWritableBranch(id)!;
    expect(child).not.toBe(main);
    const d = turn(id, "D");
    expect(current(id).branches![child].forkMessageId).toBe(b.messageId);
    expect(
      selectVisibleSnapshots(current(id), snaps().snapshots[id]).map(
        (s) => s.id,
      ),
    ).toEqual([snaps().snapshots[id][0].id, b.id, d.id]);
    const persisted = JSON.parse(JSON.stringify(current(id)));
    useConversationStore.setState({ conversations: { [id]: persisted } });
    store().switchBranch(id, main);
    expect(current(id).files).toEqual({ "c.txt": "C" });
    expect(current(id).messages.at(-1)?.content).toBe("Done C");
    expect(snaps().reconstructFiles(id, c.id)).toEqual({ "c.txt": "C" });
    store().switchBranch(id, child);
    expect(current(id).files).toEqual({ "a.txt": "D" });
    expect(current(id).messages.at(-1)?.content).toBe("Done D");
  });

  it("forks on the first actual code edit and keeps published snapshots unchanged", () => {
    const id = store().createConversation();
    const a = turn(id, "A");
    const b = turn(id, "B");
    const frozen = JSON.stringify(b);
    const main = current(id).activeBranchId!;
    store().checkoutSnapshot(id, a.id);
    store().setFilesForConversation(id, { "manual.txt": "manual" });
    const child = current(id).activeBranchId!;
    expect(child).not.toBe(main);
    expect(current(id).checkout).toBeUndefined();
    snaps().updateLatestSnapshot(id, current(id).files, current(id).assets);
    const manual = snaps().getSnapshots(id).at(-1)!;
    expect(snaps().reconstructFiles(id, manual.id)).toEqual({
      "manual.txt": "manual",
    });
    expect(
      JSON.stringify(snaps().snapshots[id].find((s) => s.id === b.id)),
    ).toBe(frozen);
    store().switchBranch(id, main);
    expect(current(id).files).toEqual({ "a.txt": "B" });
  });

  it("does not fork for unchanged editor content and preserves raw IDs through streaming updates", () => {
    const id = store().createConversation();
    const a = turn(id, "A");
    turn(id, "B");
    store().checkoutSnapshot(id, a.id);
    const branch = current(id).activeBranchId;
    store().setFilesForConversation(id, { ...current(id).files });
    expect(current(id).activeBranchId).toBe(branch);
    expect(current(id).checkout?.snapshotId).toBe(a.id);
    store().ensureWritableBranch(id);
    const previousIds = current(id).messages.map((message) => message.id);
    store().setMessagesForConversation(
      id,
      current(id).messages.map(({ id: _id, ...message }) => message),
    );
    expect(current(id).messages.map((message) => message.id)).toEqual(
      previousIds,
    );
    const merged = mergeMessages(current(id).messages).at(-1)!;
    expect(findAssistantGroupEnd(current(id).messages, merged.id)).toBe(
      current(id).messages.length,
    );
    expect(
      messagesToModelMessages(current(id).messages).every(
        (message) => !("id" in message),
      ),
    ).toBe(true);
  });

  it.each([true, false])(
    "keeps later turns out of a checkpoint after memory tool filtering (leading=%s)",
    (leading) => {
      const id = store().createConversation();
      const memoryCall = {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "memory",
            type: "function" as const,
            function: { name: "manage_memories", arguments: "{}" },
          },
        ],
      };
      const memoryResult = {
        role: "tool" as const,
        content: "saved",
        tool_call_id: "memory",
      };
      const done = { role: "assistant" as const, content: "Done A" };
      store().setMessagesForConversation(id, [
        { role: "user", content: "A" },
        ...(leading
          ? [memoryCall, memoryResult, done]
          : [done, memoryCall, memoryResult]),
      ]);
      store().setFilesForConversation(id, { "a.txt": "A" });
      const messageId = mergeMessages(current(id).messages).at(-1)!.id;
      const a = snaps().createSnapshot(id, messageId, current(id).files)!;
      expect(a.messageCount).toBe(4);
      store().setMessagesForConversation(id, filterMemoryMessages);
      expect(current(id).messages).toHaveLength(2);
      const retainedMessageId = mergeMessages(current(id).messages).at(-1)!.id;
      turn(id, "B");
      expect(snaps().getSnapshotByMessageId(id, retainedMessageId)?.id).toBe(
        a.id,
      );
      store().checkoutSnapshot(id, a.id);
      expect(current(id).files).toEqual({ "a.txt": "A" });
      expect(current(id).messages.map((message) => message.content)).toEqual([
        "A",
        "Done A",
      ]);
      store().ensureWritableBranch(id);
      turn(id, "D");
      expect(current(id).messages.map((message) => message.content)).toEqual([
        "A",
        "Done A",
        "D",
        "Done D",
      ]);
    },
  );

  it("restores metadata and assets, and clears mutable CLI sessions across checkout", () => {
    const id = store().createConversation();
    const asset: ProjectAsset = {
      path: "public/picture.png",
      blobRef: `sha256:${"a".repeat(64)}`,
      mimeType: "image/png",
      size: 1,
      digest: "a".repeat(64),
      modulePath: "src/generated-assets/picture-aaaaaaaa.js",
      publicPath: "/picture.png",
    };
    store().setAssetsForConversation(id, { [asset.path]: asset });
    const a = turn(id, "A");
    store().setAssetsForConversation(id, {});
    store().setTemplate("static");
    turn(id, "B");
    const main = current(id).activeBranchId!;
    store().setCompressedContext({ summary: "B only", fromIndex: 2 });
    store().checkoutSnapshot(id, a.id);
    expect(current(id).assets).toEqual({ [asset.path]: asset });
    expect(current(id).template).toBe("vite-react-ts");
    expect(current(id).localAgentSessions).toBeUndefined();
    store().ensureWritableBranch(id);
    expect(current(id).compressedContext).toBeUndefined();
    store().switchBranch(id, main);
    expect(current(id).assets).toEqual({});
    expect(current(id).template).toBe("static");
    expect(current(id).compressedContext?.summary).toBe("B only");
  });

  it("retains deleted fork roots needed by descendants and replays other deleted ancestors exactly", () => {
    const id = store().createConversation();
    const a = turn(id, "A");
    const b = turn(id, "B");
    const c = turn(id, "C");
    store().checkoutSnapshot(id, b.id);
    store().ensureWritableBranch(id);
    const d = turn(id, "D");
    snaps().deleteSnapshot(id, b.id);
    expect(snaps().snapshots[id].find((s) => s.id === b.id)?.hidden).toBe(true);
    snaps().deleteSnapshot(id, a.id);
    expect(snaps().reconstructFiles(id, c.id)).toEqual({ "a.txt": "C" });
    expect(snaps().reconstructFiles(id, d.id)).toEqual({ "a.txt": "D" });
  });

  it("migrates IDs idempotently and resolves old positional snapshot links", () => {
    const legacy = {
      id: "legacy",
      title: "Legacy",
      files: { "a.txt": "A" },
      messages: [
        { role: "user", content: "A" },
        { role: "assistant", content: "Done A" },
      ],
      template: "static",
      isProjectInitialized: true,
      createdAt: 1,
      updatedAt: 2,
    };
    const migrated = migrateConversationState({ conversations: { legacy } }, 6);
    expect(migrateConversationState(migrated, 6)).toEqual(migrated);
    useConversationStore.setState(
      migrated as unknown as Pick<ReturnType<typeof store>, "conversations">,
    );
    const snapshot = {
      id: "old",
      conversationId: "legacy",
      messageId: "assistant-1",
      addedFiles: legacy.files,
      patches: {},
      deletedFiles: [],
      createdAt: 2,
    };
    useSnapshotStore.setState({ snapshots: { legacy: [snapshot] } });
    const messageId = mergeMessages(current("legacy").messages).at(-1)!.id;
    expect(snaps().getSnapshotByMessageId("legacy", messageId)?.id).toBe("old");
    store().checkoutSnapshot("legacy", "old");
    expect(current("legacy").messages).toHaveLength(2);
  });

  it.each(["snapshot-first", "conversation-first"])(
    "resolves legacy links after both persisted stores hydrate (%s)",
    async (order) => {
      const id = store().createConversation();
      store().setMessagesForConversation(id, [
        { role: "user", content: "A" },
        { role: "assistant", content: "Done A" },
      ]);
      const messageId = mergeMessages(current(id).messages).at(-1)!.id;
      useSnapshotStore.setState({
        snapshots: {
          [id]: [
            {
              id: "hydrate-old",
              conversationId: id,
              messageId: "assistant-1",
              addedFiles: { "a.txt": "A" },
              patches: {},
              deletedFiles: [],
              createdAt: 1,
            },
          ],
        },
      });
      if (order === "snapshot-first") {
        await useSnapshotStore.persist.rehydrate();
        await useConversationStore.persist.rehydrate();
      } else {
        await useConversationStore.persist.rehydrate();
        await useSnapshotStore.persist.rehydrate();
      }
      await vi.waitFor(() =>
        expect(snaps().snapshots[id][0]).toMatchObject({
          messageId,
          messageLinkVersion: 1,
        }),
      );
      expect(current(id).messages).toHaveLength(2);
    },
  );

  it("freezes legacy positional associations before clearing and replacing the transcript", () => {
    const legacy = {
      id: "legacy-clear",
      title: "Legacy",
      files: { "a.txt": "Old" },
      messages: [
        { role: "user", content: "Old" },
        { role: "assistant", content: "Done Old" },
      ],
      template: "static",
      isProjectInitialized: true,
      createdAt: 1,
      updatedAt: 2,
    };
    const migrated = migrateConversationState(
      { conversations: { [legacy.id]: legacy } },
      6,
    );
    useConversationStore.setState({
      ...migrated,
      activeId: legacy.id,
    } as unknown as Pick<
      ReturnType<typeof store>,
      "conversations" | "activeId"
    >);
    useSnapshotStore.setState({
      snapshots: {
        [legacy.id]: [
          {
            id: "old",
            conversationId: legacy.id,
            messageId: "assistant-1",
            addedFiles: legacy.files,
            patches: {},
            deletedFiles: [],
            createdAt: 2,
          },
          {
            id: "orphan",
            conversationId: legacy.id,
            messageId: "assistant-9",
            kind: "checkpoint",
            fullFiles: legacy.files,
            addedFiles: {},
            patches: {},
            deletedFiles: [],
            createdAt: 3,
          },
        ],
      },
    });
    const oldMessageId = mergeMessages(current(legacy.id).messages).at(-1)!.id;
    store().clearContext();
    const frozen = snaps().snapshots[legacy.id];
    expect(frozen[0].messageId).toBe(oldMessageId);
    expect(frozen[0].messageLinkVersion).toBe(1);
    expect(frozen[1].messageId).toBe("unlinked-orphan");
    turn(legacy.id, "New");
    store().checkoutSnapshot(legacy.id, "old");
    expect(current(legacy.id).files).toEqual({ "a.txt": "Old" });
    expect(current(legacy.id).messages).toEqual([]);
    expect(snaps().snapshots[legacy.id][0].messageId).toBe(oldMessageId);
  });

  it("fails closed on missing versions and broken patches without moving the current branch", () => {
    const id = store().createConversation();
    const a = turn(id, "A");
    expect(() => store().checkoutSnapshot(id, "missing")).toThrow(
      /no longer exists/,
    );
    expect(current(id).checkout).toBeUndefined();
    expect(() =>
      replaySnapshots(
        [
          a,
          {
            ...a,
            id: "bad",
            kind: "patch",
            fullFiles: undefined,
            addedFiles: {},
            patches: { "a.txt": "@@ -1,1 +1,1 @@\n-other\n+new\n" },
            parentSnapshotId: a.id,
          },
        ],
        "bad",
      ),
    ).toThrow();
  });
});
