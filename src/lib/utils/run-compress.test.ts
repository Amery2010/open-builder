// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";
import { runCompress } from "./run-compress";
import { useConversationStore } from "../../store/conversation";

const compressContext = vi.hoisted(() => vi.fn());
vi.mock("./compress-context", async (original) => ({
  ...(await original<typeof import("./compress-context")>()),
  compressContext,
}));

beforeEach(() => {
  useConversationStore.setState({
    conversations: {},
    activeId: null,
    _hasHydrated: true,
  });
  compressContext.mockReset();
});

it("does not commit compression from a superseded run", async () => {
  const id = useConversationStore.getState().createConversation();
  const conversation = useConversationStore.getState().conversations[id];
  let release!: (value: unknown) => void;
  compressContext.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let current = true;
  const running = runCompress(
    { apiType: "openai-compatible", apiKey: "", apiBaseUrl: "", model: "test" },
    conversation,
    undefined,
    () => current,
  );
  current = false;
  release({ summary: "stale", fromIndex: 1 });
  expect(await running).toBeNull();
  expect(
    useConversationStore.getState().conversations[id].compressedContext,
  ).toBeUndefined();
});

it("does not publish an old branch summary after a same-project checkout", async () => {
  const store = useConversationStore.getState();
  const id = store.createConversation();
  const conversation = useConversationStore.getState().conversations[id];
  let release!: (value: unknown) => void;
  compressContext.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = runCompress(
    { apiType: "openai-compatible", apiKey: "", apiBaseUrl: "", model: "test" },
    conversation,
  );
  useConversationStore.setState((state) => ({
    conversations: {
      ...state.conversations,
      [id]: {
        ...state.conversations[id],
        checkoutEpoch: (conversation.checkoutEpoch ?? 0) + 1,
      },
    },
  }));
  release({ summary: "old branch", fromIndex: 1 });
  expect(await pending).toBeNull();
  expect(
    useConversationStore.getState().conversations[id].compressedContext,
  ).toBeUndefined();
});
