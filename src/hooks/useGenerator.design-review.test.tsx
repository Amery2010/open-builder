// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../store/conversation";
import { useDesignReviewStore } from "../store/design-review";
import { useSettingsStore } from "../store/settings";
import type { AutomaticDesignReviewEvidence } from "../lib/design/automatic-review";
import { computeDesignReviewSourceDigest } from "../lib/design/review-jobs/digest";
import { useGenerator } from "./useGenerator";

const reviewRunner = vi.hoisted(() => ({
  start: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("../lib/design/review-jobs/digest", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/design/review-jobs/digest")>();
  return {
    ...original,
    computeDesignReviewSourceDigest: vi.fn(
      original.computeDesignReviewSourceDigest,
    ),
  };
});

function setAutoQa(enabled: boolean) {
  useSettingsStore.setState((state) => ({
    system: { ...state.system, autoQaEnabled: enabled },
  }));
}

function renderGenerator() {
  const settings = useSettingsStore.getState();
  return renderHook(() =>
    useGenerator({
      settings: settings.ai,
      webSearchSettings: settings.webSearch,
      assetSearchSettings: settings.assetSearch,
      setMessages: useConversationStore.getState().setMessages,
      setFiles: useConversationStore.getState().setFiles,
      setIsGenerating: vi.fn(),
      setTemplate: useConversationStore.getState().setTemplate,
      restartSandpack: vi.fn(),
    }),
  );
}

function seedAutomatic() {
  const conversationId = useConversationStore.getState().createConversation();
  useConversationStore.getState().setWorkspaceMode("design");
  useConversationStore.getState().setFiles({ "src/App.tsx": "export {}" });
  const evidence = automaticEvidence(conversationId, "a".repeat(64));
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
  return { conversationId, evidence };
}

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
    reviewRunner.cancel.mockReset().mockImplementation((id) => {
      useDesignReviewStore.getState().updateRunStatus(id, "cancelled");
      return true;
    });
    vi.mocked(computeDesignReviewSourceDigest).mockClear();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "zh", autoQaEnabled: false },
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
    setAutoQa(true);
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
    expect(useDesignReviewStore.getState().dialogRequestId).toBe(0);
  });

  it("records automatic capture failure details without starting a review run", async () => {
    setAutoQa(true);
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
      await computeDesignReviewSourceDigest({ files }),
    );
    useDesignReviewStore.getState().requestAutomaticCapture(evidence);
    await act(async () => {
      await hook.result.current.automaticDesignReviewUnavailable(
        evidence,
        "Preview bridge timed out",
      );
    });

    const run =
      useDesignReviewStore.getState().runsByConversation[conversationId]?.[0];
    expect(run).toMatchObject({
      id: evidence.requestId,
      kind: "automatic",
      status: "failed",
      error: "Preview bridge timed out",
    });
    expect(reviewRunner.start).not.toHaveBeenCalled();
    expect(useDesignReviewStore.getState().dialogRequestId).toBe(0);
  });

  it("waits for a manual review and revalidates before starting automatic review", async () => {
    setAutoQa(true);
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
    setAutoQa(true);
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

    expect(useDesignReviewStore.getState().automatic?.stage).toBe("warning");
    expect(
      useConversationStore
        .getState()
        .conversations[conversationId].messages.some(
          (message) => message.metadata?.origin === "design_auto_fix",
        ),
    ).toBe(false);
  });

  it("reports current Design findings without starting a repair request", async () => {
    setAutoQa(true);
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
    ).toBe(false);
  });
});

describe("automatic Design Review QA setting", () => {
  beforeEach(() => {
    useDesignReviewStore.getState().reset();
    useDesignReviewStore.getState().clearRuns();
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
    reviewRunner.start.mockReset();
    reviewRunner.cancel.mockReset().mockImplementation((id) => {
      useDesignReviewStore.getState().updateRunStatus(id, "cancelled");
      return true;
    });
    vi.mocked(computeDesignReviewSourceDigest).mockClear();
    setAutoQa(false);
  });

  it("rejects automatic review and capture failure callbacks while disabled", async () => {
    const { evidence } = seedAutomatic();
    const hook = renderGenerator();
    await act(async () => {
      await hook.result.current.automaticDesignReview([screenshot], evidence);
      await hook.result.current.designReview([screenshot], {
        automaticEvidence: evidence,
      });
      await hook.result.current.automaticDesignReviewUnavailable(
        evidence,
        "Late capture failure",
      );
    });
    expect(reviewRunner.start).not.toHaveBeenCalled();
    expect(useDesignReviewStore.getState().automatic).toBeUndefined();
    expect(
      Object.values(useDesignReviewStore.getState().runsByConversation).flat(),
    ).toHaveLength(0);
  });

  it("clears progress when QA is disabled before the preview consumes a capture request", async () => {
    setAutoQa(true);
    seedAutomatic();
    renderGenerator();
    expect(useDesignReviewStore.getState().status).toBe("capturing");
    expect(useDesignReviewStore.getState().captureProgress).toBeDefined();
    await act(async () => {
      setAutoQa(false);
    });
    expect(useDesignReviewStore.getState().automatic).toBeUndefined();
    expect(useDesignReviewStore.getState().status).toBe("idle");
    expect(useDesignReviewStore.getState().captureProgress).toBeUndefined();
    expect(reviewRunner.start).not.toHaveBeenCalled();
  });

  it("does not revive a review digest after QA is turned off and on", async () => {
    setAutoQa(true);
    const { conversationId, evidence } = seedAutomatic();
    const hook = renderGenerator();
    let finishDigest!: (value: string) => void;
    vi.mocked(computeDesignReviewSourceDigest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDigest = resolve;
        }),
    );
    let pending!: ReturnType<typeof hook.result.current.designReview>;
    await act(async () => {
      pending = hook.result.current.designReview([screenshot], {
        automaticEvidence: evidence,
      });
      await Promise.resolve();
      setAutoQa(false);
      setAutoQa(true);
      finishDigest("a".repeat(64));
      await pending;
      // A capture callback delivered after the toggle must also be ignored.
      await hook.result.current.automaticDesignReview([screenshot], evidence);
    });
    expect(reviewRunner.start).not.toHaveBeenCalled();
    expect(useDesignReviewStore.getState().automatic).toBeUndefined();
    expect(
      useConversationStore
        .getState()
        .conversations[conversationId].messages.at(-1)?.metadata?.reviewSummary
        ?.status,
    ).toBe("interrupted");
  });

  it("stops waiting for manual review immediately without cancelling it", async () => {
    setAutoQa(true);
    const { conversationId, evidence } = seedAutomatic();
    useDesignReviewStore.getState().createRun({
      id: "manual-running",
      conversationId,
      kind: "manual",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "test", model: "test" },
    });
    useDesignReviewStore
      .getState()
      .updateRunStatus("manual-running", "running");
    const hook = renderGenerator();
    let pending!: Promise<void>;
    await act(async () => {
      pending = hook.result.current.automaticDesignReview(
        [screenshot],
        evidence,
      );
      await Promise.resolve();
    });
    expect(useDesignReviewStore.getState().automatic?.stage).toBe("deferred");
    await act(async () => {
      setAutoQa(false);
      setAutoQa(true);
      await pending;
    });
    expect(reviewRunner.cancel).not.toHaveBeenCalled();
    expect(
      useDesignReviewStore.getState().runsByConversation[conversationId][0]
        .status,
    ).toBe("running");
    expect(reviewRunner.start).not.toHaveBeenCalled();
  });

  it("aborts an executing automatic review without accepting a late completion", async () => {
    setAutoQa(true);
    const { conversationId, evidence } = seedAutomatic();
    reviewRunner.start.mockImplementation((input) => {
      const run = useDesignReviewStore.getState().createRun({
        id: "executing-automatic",
        conversationId,
        kind: "automatic",
        sourceDigest: input.sourceDigest,
        provider: { runtime: "api", provider: "test", model: "test" },
      });
      useDesignReviewStore
        .getState()
        .updateRunStatus("executing-automatic", "running");
      return run;
    });
    const hook = renderGenerator();
    let pending!: Promise<void>;
    await act(async () => {
      pending = hook.result.current.automaticDesignReview(
        [screenshot],
        evidence,
      );
    });
    await waitFor(() => expect(reviewRunner.start).toHaveBeenCalledOnce());
    await act(async () => {
      setAutoQa(false);
      expect(reviewRunner.cancel).toHaveBeenCalledWith("executing-automatic");
      setAutoQa(true);
      await pending;
    });
    expect(useDesignReviewStore.getState().automatic).toBeUndefined();
    expect(
      useDesignReviewStore.getState().runsByConversation[conversationId][0]
        .status,
    ).toBe("cancelled");
    expect(useDesignReviewStore.getState().dialogRequestId).toBe(0);
  });

  it("cancels active and queued automatic runs while preserving manual and completed runs", async () => {
    setAutoQa(true);
    seedAutomatic();
    for (const [id, kind, status] of [
      ["automatic-running", "automatic", "running"],
      ["automatic-queued", "automatic", "queued"],
      ["manual-running", "manual", "running"],
      ["automatic-complete", "automatic", "succeeded"],
    ] as const) {
      useDesignReviewStore.getState().createRun({
        id,
        conversationId: id,
        kind,
        sourceDigest: "a".repeat(64),
        provider: { runtime: "api", provider: "test", model: "test" },
      });
      useDesignReviewStore.getState().updateRunStatus(id, status);
    }
    renderGenerator();
    await act(async () => {
      setAutoQa(false);
    });
    await waitFor(() => expect(reviewRunner.cancel).toHaveBeenCalledTimes(2));
    expect(reviewRunner.cancel.mock.calls.map(([id]) => id).sort()).toEqual([
      "automatic-queued",
      "automatic-running",
    ]);
    expect(
      useDesignReviewStore.getState().runsByConversation["manual-running"][0]
        .status,
    ).toBe("running");
    expect(
      useDesignReviewStore.getState().runsByConversation[
        "automatic-complete"
      ][0].status,
    ).toBe("succeeded");
  });
});
