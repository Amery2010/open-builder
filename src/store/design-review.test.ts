import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomaticDesignReviewEvidence } from "../lib/design/automatic-review";
import type { DesignReviewRun } from "../lib/design/review-jobs/types";
import {
  normalizePersistedDesignReviewRuns,
  pruneDesignReviewRuns,
  useDesignReviewStore,
} from "./design-review";

const localforageMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  const instance = {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
  return { instance, createInstance: vi.fn(() => instance) };
});

vi.mock("localforage", () => ({
  default: { createInstance: localforageMock.createInstance },
}));

const evidence = {
  requestId: "request",
  conversationId: "conversation",
  phase: "initial",
  originalRequest: "Build a page",
  contract: {
    surface_mode: "persuade",
    change_mode: "create",
    target: "Landing page",
    audience: "Buyers",
    primary_goal: "Understand the product",
    concept: "Editorial precision",
    system_id: null,
    translation: {
      foundations: "Roles",
      composition: "Narrative",
      components: "Actions",
    },
    preserve: ["Accessibility"],
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
      files: 3,
      dependencies: 1,
      errors: 0,
      warnings: 0,
      info: 0,
      totalIssues: 0,
    },
    issues: [],
  },
} satisfies AutomaticDesignReviewEvidence;

describe("Design review automation state", () => {
  beforeEach(() => {
    useDesignReviewStore.getState().reset();
    useDesignReviewStore.getState().clearRuns();
  });

  it("uses monotonic capture requests across resets", () => {
    useDesignReviewStore.getState().requestAutomaticCapture(evidence);
    const first = useDesignReviewStore.getState().automatic?.captureRequestId;
    useDesignReviewStore.getState().reset();
    useDesignReviewStore.getState().requestAutomaticCapture({
      ...evidence,
      requestId: "request-2",
    });
    const second = useDesignReviewStore.getState().automatic?.captureRequestId;

    expect(first).toBeTypeOf("number");
    expect(second).toBeGreaterThan(first ?? 0);
  });

  it("keeps clean completion non-modal and requests the dialog for warnings", () => {
    useDesignReviewStore.getState().requestAutomaticCapture(evidence);
    const initialDialogRequest =
      useDesignReviewStore.getState().dialogRequestId;
    useDesignReviewStore.getState().finishAutomatic(false);
    expect(useDesignReviewStore.getState().automatic?.stage).toBe("complete");
    expect(useDesignReviewStore.getState().dialogRequestId).toBe(
      initialDialogRequest,
    );

    useDesignReviewStore.getState().finishAutomatic(true);
    expect(useDesignReviewStore.getState().automatic?.stage).toBe("warning");
    expect(useDesignReviewStore.getState().dialogRequestId).toBeGreaterThan(
      initialDialogRequest,
    );
  });

  it("allows at most one nonterminal run per conversation", () => {
    const store = useDesignReviewStore.getState();
    const first = store.createRun({
      id: "review-1",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt" },
    });
    const duplicate = store.createRun({
      id: "review-2",
      conversationId: "conversation",
      kind: "automatic",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt" },
    });

    expect(first?.status).toBe("queued");
    expect(duplicate).toBeNull();
    store.updateRunStatus("review-1", "cancelled");
    expect(
      store.createRun({
        id: "review-2",
        conversationId: "conversation",
        kind: "automatic",
        sourceDigest: "a".repeat(64),
        provider: { runtime: "api", provider: "openai", model: "gpt" },
      }),
    ).not.toBeNull();
  });

  it("interrupts nonterminal persisted runs without retaining volatile evidence", () => {
    const run = persistedRun({ status: "running" });
    const normalized = normalizePersistedDesignReviewRuns(
      { conversation: [run] },
      500,
    );

    expect(normalized.conversation[0]).toMatchObject({
      status: "interrupted",
      completedAt: 500,
    });
    expect(normalized.conversation[0].logs.at(-1)?.event).toBe("interrupted");
    expect(normalized.conversation[0]).not.toHaveProperty("screenshots");
    expect(normalized.conversation[0]).not.toHaveProperty("files");
  });

  it("drops invalid persisted blueprint revisions and prototype routes", () => {
    const run = persistedRun({
      status: "succeeded",
      blueprintRevision: "x".repeat(129),
      coverage: [
        {
          pageId: "dashboard",
          route: "javascript:alert(1)",
          scenarioId: "default",
          viewport: "desktop",
          status: "passed",
        },
      ],
    });
    const normalized = normalizePersistedDesignReviewRuns({
      conversation: [run],
    });

    expect(normalized.conversation[0].blueprintRevision).toBeUndefined();
    expect(normalized.conversation[0].coverage).toBeUndefined();
  });

  it("retains only the latest 20 terminal runs per conversation", () => {
    const runs = Array.from({ length: 23 }, (_, index) =>
      persistedRun({
        id: `review-${index}`,
        status: "succeeded",
        createdAt: index,
        updatedAt: index,
        completedAt: index,
      }),
    );
    const pruned = pruneDesignReviewRuns(runs);

    expect(pruned).toHaveLength(20);
    expect(pruned.map((run) => run.id)).not.toContain("review-0");
    expect(pruned[0].id).toBe("review-22");
  });

  it("rejects deleting an active run", () => {
    const store = useDesignReviewStore.getState();
    const run = store.createRun({
      id: "review-active-delete",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt" },
    });

    expect(run).not.toBeNull();
    expect(store.removeRun("review-active-delete")).toBe(false);
    expect(
      useDesignReviewStore.getState().runsByConversation.conversation,
    ).toHaveLength(1);
  });

  it("selects the next history item and clears findings when deleting the selected run", () => {
    const store = useDesignReviewStore.getState();
    const older = store.createRun({
      id: "review-older",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt" },
      now: 100,
    });
    expect(older).not.toBeNull();
    store.updateRunStatus("review-older", "succeeded");
    const newer = store.createRun({
      id: "review-newer",
      conversationId: "conversation",
      kind: "automatic",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt" },
      now: 200,
    });
    expect(newer).not.toBeNull();
    store.updateRunStatus("review-newer", "failed");
    store.selectRun("conversation", "review-newer");
    store.setSelectedFindingIds(["finding-1"]);

    expect(store.removeRun("review-newer")).toBe(true);
    const state = useDesignReviewStore.getState();
    expect(state.runsByConversation.conversation.map((run) => run.id)).toEqual([
      "review-older",
    ]);
    expect(state.selectedRunIdByConversation.conversation).toBe("review-older");
    expect(state.selectedFindingIds).toEqual([]);
  });

  it("clears the selected history item when its last run is deleted", () => {
    const store = useDesignReviewStore.getState();
    store.createRun({
      id: "review-only",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt" },
    });
    store.updateRunStatus("review-only", "cancelled");

    expect(store.removeRun("review-only")).toBe(true);
    const state = useDesignReviewStore.getState();
    expect(state.runsByConversation.conversation).toEqual([]);
    expect(state.selectedRunIdByConversation.conversation).toBeUndefined();
    expect(state.selectedFindingIds).toEqual([]);
  });

  it("clears finding selection when deleting the history item shown by fallback", () => {
    const store = useDesignReviewStore.getState();
    for (const [id, now] of [
      ["review-older", 1],
      ["review-newer", 2],
    ] as const) {
      store.createRun({
        id,
        conversationId: "conversation",
        kind: "manual",
        sourceDigest: "a".repeat(64),
        provider: { runtime: "api", provider: "openai", model: "gpt" },
        now,
      });
      store.updateRunStatus(id, "succeeded");
    }
    store.selectRun("conversation", undefined);
    store.setSelectedFindingIds(["finding-1"]);

    expect(store.removeRun("review-newer")).toBe(true);
    const state = useDesignReviewStore.getState();
    expect(state.selectedRunIdByConversation.conversation).toBe("review-older");
    expect(state.selectedFindingIds).toEqual([]);
  });

  it("deduplicates volatile finding selections", () => {
    const store = useDesignReviewStore.getState();

    store.setSelectedFindingIds(["finding-1", "finding-2", "finding-1"]);

    expect(useDesignReviewStore.getState().selectedFindingIds).toEqual([
      "finding-1",
      "finding-2",
    ]);
  });

  it("marks reports stale when the project digest changes", () => {
    const store = useDesignReviewStore.getState();
    store.createRun({
      id: "review-1",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt" },
    });
    store.updateRunStatus("review-1", "failed");
    store.markConversationFreshness("conversation", "b".repeat(64));

    const run =
      useDesignReviewStore.getState().runsByConversation.conversation[0];
    expect(run.freshness).toBe("stale");
    expect(run.logs.at(-1)?.event).toBe("stale");
  });

  it("tracks page, scenario, and viewport coverage through review completion", () => {
    const store = useDesignReviewStore.getState();
    store.createRun({
      id: "review-coverage",
      conversationId: "conversation",
      kind: "automatic",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt" },
      expectedCoverage: [
        {
          pageId: "dashboard",
          route: "#/dashboard?scenario=default",
          scenarioId: "default",
          viewport: "desktop",
        },
        {
          pageId: "settings",
          route: "#/settings?scenario=error",
          scenarioId: "error",
          viewport: "mobile",
        },
      ],
      capturedCoverage: [
        {
          pageId: "dashboard",
          route: "#/dashboard?scenario=default",
          scenarioId: "default",
          viewport: "desktop",
        },
      ],
    });

    expect(
      useDesignReviewStore.getState().runsByConversation.conversation[0]
        .coverage,
    ).toEqual([
      expect.objectContaining({ pageId: "dashboard", status: "captured" }),
      expect.objectContaining({ pageId: "settings", status: "unreviewed" }),
    ]);

    store.completeRun("review-coverage", {
      overview: "Dashboard needs a visual fix.",
      findings: [
        {
          id: "dashboard-spacing",
          priority: "P1",
          dimension: "visual_hierarchy",
          title: "Spacing",
          evidence: "The primary action is crowded.",
          recommendation: "Add space around the action.",
          page_id: "dashboard",
          scenario_id: "default",
        },
      ],
    });

    expect(
      useDesignReviewStore.getState().runsByConversation.conversation[0]
        .coverage,
    ).toEqual([
      expect.objectContaining({ pageId: "dashboard", status: "needs-fix" }),
      expect.objectContaining({ pageId: "settings", status: "unreviewed" }),
    ]);
  });

  it("can detect project changes after reload without retaining source files", () => {
    const store = useDesignReviewStore.getState();
    store.createRun({
      id: "review-project-digest",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      sourceProjectDigest: "b".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt" },
    });
    store.updateRunStatus("review-project-digest", "succeeded");

    store.markRunProjectFreshness("review-project-digest", "c".repeat(64));

    expect(
      useDesignReviewStore.getState().runsByConversation.conversation[0]
        .freshness,
    ).toBe("stale");
  });

  it("never persists screenshots or project file snapshots", async () => {
    localforageMock.instance.setItem.mockClear();
    const store = useDesignReviewStore.getState();
    store.setScreenshots([
      {
        dataUrl: "data:image/png;base64,volatile-image-secret",
        mimeType: "image/png",
      },
    ]);
    store.createRun({
      id: "review-persisted",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      capturedCount: 1,
      provider: { runtime: "api", provider: "openai", model: "gpt" },
    });

    await vi.waitFor(() =>
      expect(localforageMock.instance.setItem).toHaveBeenCalled(),
    );
    const serialized = localforageMock.instance.setItem.mock.calls.at(-1)?.[1];
    expect(serialized).not.toContain("volatile-image-secret");
    expect(serialized).not.toContain("screenshots");
    expect(serialized).not.toContain("files");
    expect(serialized).toContain("review-persisted");
  });
});

function persistedRun(
  overrides: Partial<DesignReviewRun> = {},
): DesignReviewRun {
  return {
    id: "review",
    conversationId: "conversation",
    kind: "manual",
    phase: "initial",
    status: "queued",
    freshness: "fresh",
    sourceDigest: "a".repeat(64),
    provider: { runtime: "api", provider: "openai", model: "gpt" },
    logs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
