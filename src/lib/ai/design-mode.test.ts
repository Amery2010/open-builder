import { describe, expect, it } from "vitest";
import { buildDesignSystemContext } from "./design-mode";
import type { DesignSystemPackage } from "../design-systems/validation";

describe("Design mode design-system context", () => {
  it("records an AI none decision without inventing a selected system", () => {
    const context = buildDesignSystemContext({
      recommendation: {
        systemId: null,
        reason: "The existing visual language is stronger.",
        createdAt: 1,
      },
    });
    expect(context).toContain("Selected system: none");
    expect(context).toContain("AI decision: none");
  });

  it("injects validated rules as bounded untrusted reference data", () => {
    const reference = {
      id: "custom-safe",
      name: "Safe <reference>",
      source: "custom" as const,
      version: "custom-123",
      digest: "a".repeat(64),
    };
    const pkg = {
      reference,
      design: "Use <strong> hierarchy.",
      tokens: ":root { --bg: #fff; }",
    } as DesignSystemPackage;
    const context = buildDesignSystemContext(
      { selectedSystem: reference },
      pkg,
    );

    expect(context).toContain("<untrusted_design_system_reference>");
    expect(context).toContain("Use \\u003cstrong\\u003e hierarchy.");
    expect(context).not.toContain("Safe <reference>");
    expect(context).toContain("trusted host may apply the selected package");
    expect(context).toContain("selection alone never authorizes");
  });
});
