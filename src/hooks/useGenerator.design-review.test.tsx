// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../store/conversation";
import { useSettingsStore } from "../store/settings";
import { useGenerator } from "./useGenerator";

const reviewRunner = vi.hoisted(() => ({ start: vi.fn(), retry: vi.fn() }));

vi.mock("../lib/design/review-jobs/runner", () => ({
  designReviewJobRunner: reviewRunner,
}));

const screenshot = {
  dataUrl: `data:image/png;base64,${btoa(
    String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10),
  )}`,
  mimeType: "image/png" as const,
  name: "preview.png",
};

describe("useGenerator background Design Review", () => {
  beforeEach(() => {
    reviewRunner.start.mockReset();
    reviewRunner.retry.mockReset();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "zh" },
    }));
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
  });

  it("queues a manual review without changing chat messages or generation state", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore.getState().setFiles({ "src/App.tsx": "export {}" });
    useConversationStore
      .getState()
      .setMessages([{ role: "user", content: "Review this UI" }]);
    const before =
      useConversationStore.getState().conversations[conversationId];
    reviewRunner.start.mockImplementation((input) => ({
      id: "review-1",
      conversationId,
      kind: "manual",
      phase: "initial",
      status: "queued",
      freshness: "fresh",
      sourceDigest: input.sourceDigest,
      provider: { runtime: "api", provider: "test", model: "test" },
      logs: [],
      createdAt: 1,
      updatedAt: 1,
    }));
    const settingsState = useSettingsStore.getState();
    const hook = renderHook(() => {
      const [isGenerating, setIsGenerating] = useState(false);
      return {
        isGenerating,
        ...useGenerator({
          settings: settingsState.ai,
          webSearchSettings: settingsState.webSearch,
          assetSearchSettings: settingsState.assetSearch,
          setMessages: useConversationStore.getState().setMessages,
          setFiles: useConversationStore.getState().setFiles,
          setIsGenerating,
          setTemplate: useConversationStore.getState().setTemplate,
          restartSandpack: vi.fn(),
        }),
      };
    });

    await act(async () => {
      await hook.result.current.designReview([screenshot]);
    });

    const after = useConversationStore.getState().conversations[conversationId];
    expect(reviewRunner.start).toHaveBeenCalledOnce();
    expect(reviewRunner.start.mock.calls[0][0].locale).toBe("zh");
    expect(after.messages).toEqual(before.messages);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(hook.result.current.isGenerating).toBe(false);
  });
});
