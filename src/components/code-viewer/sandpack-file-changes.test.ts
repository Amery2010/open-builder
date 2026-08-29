import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSandpackFileChangeScheduler,
  discardPendingSandpackFileChanges,
  flushPendingSandpackFileChanges,
} from "./sandpack-file-changes";

describe("Sandpack file change scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists empty file content after the debounce", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const scheduler = createSandpackFileChangeScheduler();

    scheduler.schedule({
      conversationId: "conversation-a",
      path: "src/empty.ts",
      content: "",
      commit,
    });
    vi.advanceTimersByTime(500);

    expect(commit).toHaveBeenCalledWith("conversation-a", "src/empty.ts", "");
    scheduler.dispose();
  });

  it("flushes the latest edit before switching files or conversations", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const scheduler = createSandpackFileChangeScheduler();

    scheduler.schedule({
      conversationId: "conversation-a",
      path: "src/App.tsx",
      content: "first",
      commit,
    });
    scheduler.schedule({
      conversationId: "conversation-a",
      path: "src/App.tsx",
      content: "latest",
      commit,
    });
    scheduler.schedule({
      conversationId: "conversation-a",
      path: "src/main.tsx",
      content: "main",
      commit,
    });
    scheduler.schedule({
      conversationId: "conversation-b",
      path: "src/main.tsx",
      content: "other conversation",
      commit,
    });

    expect(commit.mock.calls).toEqual([
      ["conversation-a", "src/App.tsx", "latest"],
      ["conversation-a", "src/main.tsx", "main"],
    ]);

    scheduler.dispose();
    expect(commit).toHaveBeenLastCalledWith(
      "conversation-b",
      "src/main.tsx",
      "other conversation",
    );
  });

  it("can discard a pending edit before a destructive reset", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const scheduler = createSandpackFileChangeScheduler();

    scheduler.schedule({
      conversationId: "conversation-a",
      path: "src/App.tsx",
      content: "pending",
      commit,
    });
    discardPendingSandpackFileChanges("conversation-a");
    scheduler.dispose();

    expect(commit).not.toHaveBeenCalled();
  });

  it("flushes a pending edit before a hard preview reload", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const scheduler = createSandpackFileChangeScheduler();
    scheduler.schedule({
      conversationId: "conversation-a",
      path: "src/App.tsx",
      content: "latest edit",
      commit,
    });

    flushPendingSandpackFileChanges("conversation-a");

    expect(commit).toHaveBeenCalledWith(
      "conversation-a",
      "src/App.tsx",
      "latest edit",
    );
    scheduler.dispose();
  });
});
