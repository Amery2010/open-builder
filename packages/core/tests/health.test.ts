import { describe, expect, it } from "vitest";
import { runStaticProjectHealthCheck } from "../src/index.js";

describe("static health report aggregation", () => {
  it("counts and prioritizes every platform finding before truncation", () => {
    const report = runStaticProjectHealthCheck(
      {
        "index.html":
          "<html><head><title>App</title></head><body></body></html>",
      },
      {
        additionalIssues: [
          {
            severity: "error",
            category: "design_system",
            message: "Contract failed.",
          },
          ...Array.from({ length: 25 }, (_, i) => ({
            severity: "error" as const,
            category: "runtime" as const,
            message: `Runtime ${i}`,
          })),
        ],
      },
    );
    expect(report.ok).toBe(false);
    expect(report.summary).toMatchObject({
      errors: 26,
      warnings: 1,
      info: 1,
      totalIssues: 28,
    });
    expect(report.issues).toHaveLength(20);
    expect(report.issues[0].category).toBe("design_system");
    expect(report.issues.every((issue) => issue.severity === "error")).toBe(
      true,
    );
    expect(report.truncated).toBe(true);
  });

  it("does not infer missing secrets when environment inspection is disabled", () => {
    const report = runStaticProjectHealthCheck(
      {
        ".env.example": "SECRET_KEY=example",
        "index.html":
          "<title>App</title><meta name='viewport' content='width=device-width'>",
      },
      { includeEnvironment: false },
    );
    expect(
      report.issues.some((issue) => issue.category === "environment"),
    ).toBe(false);
    expect(report.ok).toBe(true);
  });
});
