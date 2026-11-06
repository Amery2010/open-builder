import { expect, it, vi } from "vitest";

const disk = vi.hoisted(() => {
  const records = new Map<string, unknown>();
  let writeBarrier: Promise<void> | undefined;
  const adapter = {
    getItem: vi.fn(async (key: string) => records.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => {
      const barrier = writeBarrier;
      writeBarrier = undefined;
      await barrier;
      records.set(key, value);
      return value;
    }),
    removeItem: vi.fn(async (key: string) => {
      records.delete(key);
    }),
  };
  return {
    records,
    adapter,
    hold(promise: Promise<void>) {
      writeBarrier = promise;
    },
  };
});
vi.mock("localforage", () => ({
  default: { ...disk.adapter, createInstance: () => disk.adapter },
}));

import {
  flushConversationPersistence,
  useConversationStore,
} from "../../store/conversation";

it("does not acknowledge project persistence until the real conversation write completes", async () => {
  useConversationStore.setState({
    conversations: {},
    activeId: null,
    _hasHydrated: true,
  });
  const id = useConversationStore.getState().createConversation();
  await flushConversationPersistence();
  let release!: () => void;
  disk.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  useConversationStore
    .getState()
    .setFilesForConversation(id, { "styles.css": "saved exactly once" });
  let durable = false;
  const saved = flushConversationPersistence().then(() => {
    durable = true;
  });
  await Promise.resolve();
  expect(durable).toBe(false);
  release();
  await saved;
  const persisted = JSON.parse(
    String(disk.records.get("open-builder-conversations")),
  );
  expect(persisted.state.conversations[id].files["styles.css"]).toBe(
    "saved exactly once",
  );
});

it("serializes storage removal after pending writes so cleared projects cannot reappear", async () => {
  const id = useConversationStore.getState().createConversation();
  await flushConversationPersistence();
  let release!: () => void;
  disk.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  useConversationStore
    .getState()
    .setFilesForConversation(id, { "pending.txt": "must be removed" });
  useConversationStore.persist.clearStorage();
  const cleared = flushConversationPersistence();
  release();
  await cleared;
  expect(disk.records.has("open-builder-conversations")).toBe(false);
});
