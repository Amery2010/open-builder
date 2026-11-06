import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushConversationPersistence,
  useConversationStore,
} from "./conversation";

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock("localforage", () => {
  const adapter = {
    getItem: async (key: string) => disk.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      disk.set(key, value);
    },
    removeItem: async (key: string) => {
      disk.delete(key);
    },
  };
  return { default: { ...adapter, createInstance: () => adapter } };
});

describe("conversation thinking persistence", () => {
  beforeEach(() => {
    disk.clear();
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
  });

  it("rehydrates readable thinking independently of the final answer", async () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.getState().setMessages([
      { role: "user", content: "Inspect the layout" },
      {
        role: "assistant",
        content: "Layout is valid",
        thinking: "检查布局🌱和边界",
      },
    ]);
    await vi.waitFor(() =>
      expect([...disk.values()].join("")).toContain("检查布局🌱和边界"),
    );
    const saved = new Map(disk);
    useConversationStore.setState({ conversations: {}, activeId: null });
    await flushConversationPersistence();
    disk.clear();
    for (const [key, value] of saved) disk.set(key, value);
    await useConversationStore.persist.rehydrate();
    expect(
      useConversationStore.getState().conversations[id].messages[1],
    ).toMatchObject({
      content: "Layout is valid",
      thinking: "检查布局🌱和边界",
    });
  });
});
