import { describe, expect, it } from "vitest";
import {
  buildAutomaticDesignReviewContext,
  automaticDesignReviewStageForOutcome,
  hasRemainingAutomaticDesignIssues,
  shouldRequestAutomaticDesignReview,
  type AutomaticDesignReviewEvidence,
} from "./automatic-review";

function evidence(): AutomaticDesignReviewEvidence {
  return {
    requestId: "request-1",
    conversationId: "conversation-1",
    phase: "initial",
    originalRequest: "Redesign the settings workspace.",
    contract: {
      surface_mode: "operate",
      change_mode: "migrate",
      target: "Settings workspace",
      audience: "Administrators",
      primary_goal: "Configure safely",
      concept: "A precise operations bench",
      system_id: "graphite",
      translation: {
        foundations: "Semantic roles",
        composition: "Clear hierarchy",
        components: "Shared controls",
      },
      preserve: ["Routes and behavior"],
      acceptance: ["Runtime Token consumption"],
    },
    appliedSystem: {
      id: "graphite",
      name: "Graphite",
      version: "2.0.0",
      digest: "a".repeat(64),
    },
    designReport: {
      ok: false,
      summary: { errors: 1, warnings: 0, totalIssues: 1 },
      changedUiPaths: ["src/App.tsx"],
      tokenUsage: {
        color: [],
        typography: [],
        shape: [],
        layout: [],
        motion: [],
      },
      issues: [
        {
          severity: "error",
          category: "design_system",
          code: "tokens_not_loaded",
          message: "tokens.css is not loaded",
        },
      ],
    },
    healthReport: {
      ok: false,
      summary: {
        files: 4,
        dependencies: 2,
        errors: 1,
        warnings: 1,
        info: 1,
        totalIssues: 3,
      },
      issues: [
        {
          severity: "error",
          category: "runtime",
          message: "Preview failed",
        },
        {
          severity: "warning",
          category: "design_system",
          message: "duplicate Design issue",
        },
        {
          severity: "info",
          category: "responsive",
          message: "Informational only",
        },
      ],
    },
  };
}

describe("automatic Design review policy", () => {
  it("maps explicit outcomes without conflating unavailable work with clean", () => {
    expect(automaticDesignReviewStageForOutcome("clean")).toBe("complete");
    expect(automaticDesignReviewStageForOutcome("findings")).toBe("warning");
    expect(automaticDesignReviewStageForOutcome("deferred")).toBe("deferred");
    expect(automaticDesignReviewStageForOutcome("superseded")).toBe(
      "superseded",
    );
  });

  it("never treats a clean result without capture errors as remaining work", () => {
    const clean = evidence();
    clean.designReport = {
      ...clean.designReport,
      ok: true,
      issues: [],
      summary: { errors: 0, warnings: 0, totalIssues: 0 },
    };
    clean.healthReport = {
      ...clean.healthReport,
      ok: true,
      issues: [],
      summary: {
        ...clean.healthReport.summary,
        errors: 0,
        warnings: 0,
        info: 0,
        totalIssues: 0,
      },
    };

    expect(
      hasRemainingAutomaticDesignIssues(clean, {
        overview: "Clean",
        findings: [],
      }),
    ).toBe(false);
    expect(
      hasRemainingAutomaticDesignIssues(
        { ...clean, captureErrors: ["tablet unavailable"] },
        { overview: "Clean", findings: [] },
      ),
    ).toBe(true);
  });

  it("builds advisory context from known intent without requiring complete metadata", () => {
    const current = evidence();
    current.contract.audience = "";
    current.contract.concept = "";
    current.contract.acceptance = [];
    const context = buildAutomaticDesignReviewContext(current);
    expect(context).toContain("host-prepared Design run context");
    expect(context).toContain("Missing intent fields are unknown");
    expect(context).toContain('"digest":"aaaaaaaa');
  });

  it("only schedules a report for changed UI or explicit verification", () => {
    expect(shouldRequestAutomaticDesignReview([], "initial")).toBe(false);
    expect(shouldRequestAutomaticDesignReview([], "verify")).toBe(true);
    expect(shouldRequestAutomaticDesignReview(["App.tsx"], "initial")).toBe(
      true,
    );
  });
});
