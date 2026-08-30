import { beforeEach, describe, expect, it } from "vitest";
import type { AutomaticDesignReviewEvidence } from "../lib/design/automatic-review";
import { useDesignReviewStore } from "./design-review";

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
  beforeEach(() => useDesignReviewStore.getState().reset());

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
});
