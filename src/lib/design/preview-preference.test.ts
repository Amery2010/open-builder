import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { setConversationDefaultPreviewView } from "./preview-preference";

const localforageMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  const adapter = {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
  };
  return { ...adapter, createInstance: () => adapter };
});

vi.mock("localforage", () => ({ default: localforageMock }));

beforeEach(() => {
  useConversationStore.setState({ conversations: {}, activeId: null });
});

describe("preview preference Host mutation", () => {
  it("defers an empty-project preference and treats the same value as a no-op", () => {
    const id = useConversationStore.getState().createConversation();
    expect(
      setConversationDefaultPreviewView({ conversationId: id, view: "mobile" }),
    ).toEqual({ ok: true, status: "deferred", view: "mobile" });
    const updatedAt =
      useConversationStore.getState().conversations[id].updatedAt;
    expect(
      setConversationDefaultPreviewView({ conversationId: id, view: "mobile" }),
    ).toEqual({ ok: true, status: "no-op", view: "mobile" });
    expect(useConversationStore.getState().conversations[id].updatedAt).toBe(
      updatedAt,
    );
  });

  it("rejects code-only, invalid, and inactive Conversation writes", () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], previewMode: "code-only" },
      },
    }));
    expect(
      setConversationDefaultPreviewView({ conversationId: id, view: "tablet" }),
    ).toMatchObject({ ok: false, status: "unavailable", view: "desktop" });
    expect(
      setConversationDefaultPreviewView({ conversationId: id, view: "watch" }),
    ).toMatchObject({ ok: false, status: "invalid" });

    const other = useConversationStore.getState().createConversation();
    expect(other).not.toBe(id);
    expect(
      setConversationDefaultPreviewView({ conversationId: id, view: "mobile" }),
    ).toMatchObject({ ok: false, status: "stale" });
  });
});
