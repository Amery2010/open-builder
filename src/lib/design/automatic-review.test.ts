import { describe, expect, it } from "vitest";
import type { DesignReviewReport } from "./review";
import {
  buildAutomaticDesignRepairPrompt,
  buildAutomaticDesignReviewContext,
  hasRemainingAutomaticDesignIssues,
  requiredSkillsForContract,
  selectAutomaticDesignRepairScope,
  shouldRequestAutomaticDesignReview,
  shouldRunAutomaticDesignRepair,
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

const report: DesignReviewReport = {
  overview: "Review",
  findings: [
    {
      id: "p1-hierarchy",
      priority: "P1",
      dimension: "visual_hierarchy",
      title: "Weak hierarchy",
      evidence: "The primary action is hard to find.",
      recommendation: "Strengthen the primary action.",
    },
    {
      id: "p2-system",
      priority: "P2",
      dimension: "system_consistency",
      title: "Token drift",
      evidence: "The card radius differs from the system.",
      recommendation: "Use the semantic radius.",
    },
    {
      id: "p2-copy",
      priority: "P2",
      dimension: "copy_specificity",
      title: "Generic copy",
      evidence: "The label is vague.",
      recommendation: "Use a specific label.",
    },
    {
      id: "p3-system",
      priority: "P3",
      dimension: "system_consistency",
      title: "Minor drift",
      evidence: "A secondary gap is slightly inconsistent.",
      recommendation: "Align it later.",
    },
  ],
};

describe("automatic Design review policy", () => {
  it("selects every static issue, P0/P1, and non-P3 system consistency", () => {
    const scope = selectAutomaticDesignRepairScope(evidence(), report);

    expect(scope.staticIssues.map((issue) => issue.message)).toEqual([
      "tokens.css is not loaded",
      "Preview failed",
    ]);
    expect(scope.visualFindings.map((finding) => finding.id)).toEqual([
      "p1-hierarchy",
      "p2-system",
    ]);
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

  it("builds a single bounded repair and reviewer context", () => {
    const current = evidence();
    const scope = selectAutomaticDesignRepairScope(current, report);
    const repair = buildAutomaticDesignRepairPrompt(current, scope);
    const context = buildAutomaticDesignReviewContext(current);

    expect(repair).toContain("the only repair pass");
    expect(repair).toContain("Reuse the accepted Design contract");
    expect(repair).toContain("p2-system");
    expect(repair).not.toContain("p2-copy");
    expect(context).toContain("automatic_design_review_context");
    expect(context).toContain('"digest":"aaaaaaaa');
    expect(requiredSkillsForContract(current.contract)).toEqual([
      "design-product-ui",
    ]);
    expect(
      requiredSkillsForContract({
        ...current.contract,
        surface_mode: "mixed",
      }),
    ).toEqual(["design-product-ui", "art-direct-web"]);
  });

  it("skips code-only turns and never repairs during verification", () => {
    const scope = selectAutomaticDesignRepairScope(evidence(), report);
    expect(shouldRequestAutomaticDesignReview([], "initial")).toBe(false);
    expect(shouldRequestAutomaticDesignReview([], "verify")).toBe(true);
    expect(shouldRunAutomaticDesignRepair("initial", scope)).toBe(true);
    expect(shouldRunAutomaticDesignRepair("verify", scope)).toBe(false);
  });
});
