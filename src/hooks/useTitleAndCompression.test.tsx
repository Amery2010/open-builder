// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TITLE, useConversationStore } from "../store/conversation";
import type { Conversation, Message } from "../types";
import { useTitleAndCompression } from "./useTitleAndCompression";

const config = {
  apiType: "openai" as const,
  apiBaseUrl: "https://api.openai.com",
  apiKey: "test-key",
  model: "test-model",
};

function conversation(id: string, title = DEFAULT_TITLE): Conversation {
  return {
    id,
    title,
    messages: [],
    files: {},
    template: "vite-react-ts",
    previewMode: "sandpack",
    isProjectInitialized: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

const firstRequest: Message = {
  role: "user",
  content: "Fix automatic titles",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("useTitleAndCompression smart titles", () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: {
        target: conversation("target"),
        active: conversation("active", "Manual active title"),
      },
      activeId: "active",
      _hasHydrated: true,
    });
  });

  it("targets the completed conversation and deduplicates concurrent work", async () => {
    const pending = deferred<string>();
    const generateTextOverride = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useTitleAndCompression({
        resolveConfig: vi.fn(async () => config),
        setIsGenerating: vi.fn(),
        setMessages: vi.fn(),
        generateTextOverride,
      }),
    );

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = result.current.triggerSmartTitle({
        conversationId: "target",
        firstRequest,
        config,
      });
      duplicate = result.current.triggerSmartTitle({
        conversationId: "target",
        firstRequest,
        config,
      });
    });

    await duplicate;
    await vi.waitFor(() =>
      expect(generateTextOverride).toHaveBeenCalledTimes(1),
    );
    expect(useConversationStore.getState().conversations.target.title).toBe(
      "Fix automatic titles",
    );
    pending.resolve('"Automatic title fix"');
    await first;

    expect(useConversationStore.getState().conversations.target.title).toBe(
      "Automatic title fix",
    );
    expect(useConversationStore.getState().activeId).toBe("active");
  });

  it("does not overwrite a manual rename completed while the model is running", async () => {
    const pending = deferred<string>();
    const generateTextOverride = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useTitleAndCompression({
        resolveConfig: vi.fn(async () => config),
        setIsGenerating: vi.fn(),
        setMessages: vi.fn(),
        generateTextOverride,
      }),
    );

    let task!: Promise<void>;
    act(() => {
      task = result.current.triggerSmartTitle({
        conversationId: "target",
        firstRequest,
        config,
      });
    });
    await vi.waitFor(() => expect(generateTextOverride).toHaveBeenCalledOnce());
    act(() => {
      useConversationStore
        .getState()
        .renameConversation("target", "My chosen title");
    });
    pending.resolve("Generated title");
    await task;

    expect(useConversationStore.getState().conversations.target.title).toBe(
      "My chosen title",
    );
  });

  it("keeps the provisional fallback when title generation fails", async () => {
    const generateTextOverride = vi.fn(async () => {
      throw new Error("offline");
    });
    const { result } = renderHook(() =>
      useTitleAndCompression({
        resolveConfig: vi.fn(async () => config),
        setIsGenerating: vi.fn(),
        setMessages: vi.fn(),
        generateTextOverride,
      }),
    );

    await act(async () => {
      await result.current.triggerSmartTitle({
        conversationId: "target",
        firstRequest,
        config,
      });
    });

    expect(useConversationStore.getState().conversations.target.title).toBe(
      "Fix automatic titles",
    );
  });

  it("does not recreate a conversation deleted while the title task is running", async () => {
    const pending = deferred<string>();
    const generateTextOverride = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useTitleAndCompression({
        resolveConfig: vi.fn(async () => config),
        setIsGenerating: vi.fn(),
        setMessages: vi.fn(),
        generateTextOverride,
      }),
    );

    let task!: Promise<void>;
    act(() => {
      task = result.current.triggerSmartTitle({
        conversationId: "target",
        firstRequest,
        config,
      });
    });
    await vi.waitFor(() => expect(generateTextOverride).toHaveBeenCalledOnce());
    act(() => {
      useConversationStore.setState((state) => {
        const { target: _deleted, ...conversations } = state.conversations;
        return { conversations };
      });
    });
    pending.resolve("Generated title");
    await task;

    expect(
      useConversationStore.getState().conversations.target,
    ).toBeUndefined();
  });
});
