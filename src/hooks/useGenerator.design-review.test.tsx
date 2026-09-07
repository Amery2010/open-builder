// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../store/conversation";
import { useDesignReviewStore } from "../store/design-review";
import { useSettingsStore } from "../store/settings";
import type { AutomaticDesignReviewEvidence } from "../lib/design/automatic-review";
import { computeDesignReviewSourceDigest } from "../lib/design/review-jobs/digest";
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

function automaticEvidence(
  conversationId: string,
  sourceDigest: string,
): AutomaticDesignReviewEvidence {
  return {
    requestId: "automatic-request",
    conversationId,
    sourceDigest,
    phase: "initial",
    originalRequest: "Build this page",
    contract: {
      surface_mode: "persuade",
      change_mode: "extend",
      target: "Landing page",
      audience: "Buyers",
      primary_goal: "Understand the product",
      concept: "Editorial precision",
      system_id: null,
      translation: {
        foundations: "Semantic roles",
        composition: "Clear hierarchy",
        components: "Shared controls",
      },
      preserve: ["Behavior"],
      acceptance: ["Responsive"],
    },
    appliedSystem: null,
    designReport: {
      ok: true,
      summary: { errors: 0, warnings: 0, totalIssues: 0 },
      issues: [],
      changedUiPaths: ["src/App.tsx"],
      tokenUsage: {
        color: [],
        typography: [],
        shape: [],
        layout: [],
        motion: [],
      },
    },
    healthReport: {
      ok: true,
      summary: {
        files: 1,
        dependencies: 0,
        errors: 0,
        warnings: 0,
        info: 0,
        totalIssues: 0,
      },
      issues: [],
    },
  };
}

const repairReport = {
  overview: "One reviewed issue needs repair.",
  findings: [
    {
      id: "contrast-finding",
      priority: "P1" as const,
      dimension: "accessibility" as const,
      title: "Insufficient contrast",
      evidence: "The primary action is hard to distinguish.",
      recommendation: "Use the accepted semantic contrast token.",
    },
  ],
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
    useDesignReviewStore.getState().reset();
    useDesignReviewStore.getState().clearRuns();
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

  it("marks a failed automatic review unavailable instead of clean", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore.getState().setFiles({ "src/App.tsx": "export {}" });
    const settingsState = useSettingsStore.getState();
    const hook = renderHook(() => {
      const [, setIsGenerating] = useState(false);
      return useGenerator({
        settings: settingsState.ai,
        webSearchSettings: settingsState.webSearch,
        assetSearchSettings: settingsState.assetSearch,
        setMessages: useConversationStore.getState().setMessages,
        setFiles: useConversationStore.getState().setFiles,
        setIsGenerating,
        setTemplate: useConversationStore.getState().setTemplate,
        restartSandpack: vi.fn(),
      });
    });
    const files =
      useConversationStore.getState().conversations[conversationId].files;
    const evidence = automaticEvidence(
      conversationId,
      await computeDesignReviewSourceDigest({
        files,
        designSystem: null,
        designContract: automaticEvidence(conversationId, "").contract,
      }),
    );
    useDesignReviewStore.getState().requestAutomaticCapture(evidence);
    reviewRunner.start.mockImplementation((input) => {
      const run = useDesignReviewStore.getState().createRun({
        id: "failed-automatic",
        conversationId,
        kind: "automatic",
        sourceDigest: input.sourceDigest,
        provider: { runtime: "api", provider: "test", model: "test" },
      });
      useDesignReviewStore
        .getState()
        .updateRunStatus("failed-automatic", "failed", "Review failed");
      return run;
    });

    await act(async () => {
      await hook.result.current.automaticDesignReview([screenshot], evidence);
    });

    expect(useDesignReviewStore.getState().automatic?.stage).toBe(
      "unavailable",
    );
    expect(useDesignReviewStore.getState().automatic?.stage).not.toBe(
      "complete",
    );
  });

  it("waits for a manual review and revalidates before starting automatic review", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore.getState().setFiles({ "src/App.tsx": "export {}" });
    const files =
      useConversationStore.getState().conversations[conversationId].files;
    const baseEvidence = automaticEvidence(conversationId, "");
    const sourceDigest = await computeDesignReviewSourceDigest({
      files,
      designSystem: null,
      designContract: baseEvidence.contract,
    });
    const evidence = automaticEvidence(conversationId, sourceDigest);
    useConversationStore.getState().setMessages([
      { role: "user", content: "Build this page" },
      {
        role: "user",
        content: "",
        metadata: {
          origin: "design_review",
          reviewJobId: evidence.requestId,
          reviewSummary: { status: "capturing" },
        },
      },
    ]);
    useDesignReviewStore.getState().requestAutomaticCapture(evidence);
    useDesignReviewStore.getState().createRun({
      id: "manual-review",
      conversationId,
      kind: "manual",
      sourceDigest,
      provider: { runtime: "api", provider: "test", model: "test" },
    });
    reviewRunner.start.mockImplementation(() => {
      throw new Error("Synthetic start failure");
    });
    const settingsState = useSettingsStore.getState();
    const hook = renderHook(() => {
      const [, setIsGenerating] = useState(false);
      return useGenerator({
        settings: settingsState.ai,
        webSearchSettings: settingsState.webSearch,
        assetSearchSettings: settingsState.assetSearch,
        setMessages: useConversationStore.getState().setMessages,
        setFiles: useConversationStore.getState().setFiles,
        setIsGenerating,
        setTemplate: useConversationStore.getState().setTemplate,
        restartSandpack: vi.fn(),
      });
    });

    let automatic!: Promise<void>;
    await act(async () => {
      automatic = hook.result.current.automaticDesignReview(
        [screenshot],
        evidence,
      );
      await Promise.resolve();
    });
    expect(useDesignReviewStore.getState().automatic?.stage).toBe("deferred");
    expect(reviewRunner.start).not.toHaveBeenCalled();

    await act(async () => {
      useDesignReviewStore
        .getState()
        .updateRunStatus("manual-review", "cancelled");
      await automatic;
    });
    expect(reviewRunner.start).toHaveBeenCalledOnce();
    expect(useDesignReviewStore.getState().automatic?.stage).toBe(
      "unavailable",
    );
  });

  it("does not start automatic repair after leaving Design mode", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore.getState().setFiles({ "src/App.tsx": "export {}" });
    const baseEvidence = automaticEvidence(conversationId, "");
    const evidence = automaticEvidence(
      conversationId,
      await computeDesignReviewSourceDigest({
        files:
          useConversationStore.getState().conversations[conversationId].files,
        designSystem: null,
        designContract: baseEvidence.contract,
      }),
    );
    useConversationStore.getState().setMessages([
      { role: "user", content: "Build this page" },
      {
        role: "user",
        content: "",
        metadata: {
          origin: "design_review",
          reviewJobId: evidence.requestId,
          reviewSummary: { status: "capturing" },
        },
      },
    ]);
    useDesignReviewStore.getState().requestAutomaticCapture(evidence);
    reviewRunner.start.mockImplementation((input) => {
      const run = useDesignReviewStore.getState().createRun({
        id: "mode-switch-review",
        conversationId,
        kind: "automatic",
        sourceDigest: input.sourceDigest,
        provider: { runtime: "api", provider: "test", model: "test" },
      });
      queueMicrotask(() => {
        useConversationStore.getState().setWorkspaceMode("auto");
        useDesignReviewStore
          .getState()
          .completeRun("mode-switch-review", repairReport);
      });
      return run;
    });
    const settingsState = useSettingsStore.getState();
    const hook = renderHook(() => {
      const [, setIsGenerating] = useState(false);
      return useGenerator({
        settings: settingsState.ai,
        webSearchSettings: settingsState.webSearch,
        assetSearchSettings: settingsState.assetSearch,
        setMessages: useConversationStore.getState().setMessages,
        setFiles: useConversationStore.getState().setFiles,
        setIsGenerating,
        setTemplate: useConversationStore.getState().setTemplate,
        restartSandpack: vi.fn(),
      });
    });

    await act(async () => {
      await hook.result.current.automaticDesignReview([screenshot], evidence);
    });

    expect(useDesignReviewStore.getState().automatic?.stage).toBe("superseded");
    expect(
      useConversationStore
        .getState()
        .conversations[conversationId].messages.some(
          (message) => message.metadata?.origin === "design_auto_fix",
        ),
    ).toBe(false);
  });

  it("promotes a current Design review into one bounded repair request", async () => {
    const conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore.getState().setFiles({ "src/App.tsx": "export {}" });
    const baseEvidence = automaticEvidence(conversationId, "");
    const evidence = automaticEvidence(
      conversationId,
      await computeDesignReviewSourceDigest({
        files:
          useConversationStore.getState().conversations[conversationId].files,
        designSystem: null,
        designContract: baseEvidence.contract,
      }),
    );
    useConversationStore.getState().setMessages([
      { role: "user", content: "Build this page" },
      {
        role: "user",
        content: "",
        metadata: {
          origin: "design_review",
          reviewJobId: evidence.requestId,
          reviewSummary: { status: "capturing" },
        },
      },
    ]);
    useDesignReviewStore.getState().requestAutomaticCapture(evidence);
    reviewRunner.start.mockImplementation((input) => {
      const run = useDesignReviewStore.getState().createRun({
        id: "repair-review",
        conversationId,
        kind: "automatic",
        sourceDigest: input.sourceDigest,
        provider: { runtime: "api", provider: "test", model: "test" },
      });
      queueMicrotask(() => {
        useDesignReviewStore
          .getState()
          .completeRun("repair-review", repairReport);
      });
      return run;
    });
    const settingsState = useSettingsStore.getState();
    const hook = renderHook(() => {
      const [, setIsGenerating] = useState(false);
      return useGenerator({
        settings: settingsState.ai,
        webSearchSettings: settingsState.webSearch,
        assetSearchSettings: settingsState.assetSearch,
        setMessages: useConversationStore.getState().setMessages,
        setFiles: useConversationStore.getState().setFiles,
        setIsGenerating,
        setTemplate: useConversationStore.getState().setTemplate,
        restartSandpack: vi.fn(),
      });
    });

    await act(async () => {
      await hook.result.current.automaticDesignReview([screenshot], evidence);
    });

    expect(
      useConversationStore
        .getState()
        .conversations[conversationId].messages.some(
          (message) => message.metadata?.origin === "design_auto_fix",
        ),
    ).toBe(true);
  });
});
