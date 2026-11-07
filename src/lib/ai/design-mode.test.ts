import { describe, expect, it } from "vitest";
import {
  buildDesignSystemContext,
  DESIGN_MODE_SYSTEM_SUFFIX,
} from "./design-mode";
import type { DesignSystemPackage } from "../design-systems/validation";

describe("Design mode design-system context", () => {
  it("orders Skill loading and scoped contract guidance before the first UI write", () => {
    const loadSkill = DESIGN_MODE_SYSTEM_SUFFIX.indexOf(
      "Load the required Design Skill",
    );
    const submitContract = DESIGN_MODE_SYSTEM_SUFFIX.indexOf(
      "Call submit_design_contract",
    );
    const firstWrite = DESIGN_MODE_SYSTEM_SUFFIX.indexOf(
      'output exactly one concise line beginning "Design Read:"',
    );

    expect(loadSkill).toBeGreaterThan(-1);
    expect(submitContract).toBeGreaterThan(loadSkill);
    expect(firstWrite).toBeGreaterThan(submitContract);
    expect(DESIGN_MODE_SYSTEM_SUFFIX).toContain(
      "recommended, but not required, for ordinary project file edits",
    );
    expect(DESIGN_MODE_SYSTEM_SUFFIX).toContain(
      "Automatic visual review and repair require an accepted contract",
    );
    expect(DESIGN_MODE_SYSTEM_SUFFIX).toContain("selected-but-unapplied");
    expect(DESIGN_MODE_SYSTEM_SUFFIX).toContain("one automatic repair");
  });

  it("requires stable selection ids on independently editable content", () => {
    expect(DESIGN_MODE_SYSTEM_SUFFIX).toContain(
      "independently editable headings, body copy, and media",
    );
    expect(DESIGN_MODE_SYSTEM_SUFFIX).toContain(
      "stable semantic suffixes, not array indexes",
    );
  });

  it("grounds content in inspected evidence and keeps exploration opt-in", () => {
    expect(DESIGN_MODE_SYSTEM_SUFFIX).toContain(
      "Do not invent filler, proof, assets, or capabilities",
    );
    expect(DESIGN_MODE_SYSTEM_SUFFIX).toContain(
      "Explore alternatives only when the user asks",
    );
    expect(DESIGN_MODE_SYSTEM_SUFFIX).toContain(
      "implement only the chosen direction",
    );
  });

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
    expect(context).toContain("selected-unapplied");
  });

  it("makes an applied package authoritative only inside the accepted target", () => {
    const reference = {
      id: "graphite",
      name: "Graphite",
      source: "builtin" as const,
      version: "2.0.0",
      digest: "b".repeat(64),
    };
    const context = buildDesignSystemContext({
      selectedSystem: reference,
      appliedSystem: reference,
    });

    expect(context).toContain("it is the visual authority");
    expect(context).toContain("consume its semantic Tokens");
  });
});
