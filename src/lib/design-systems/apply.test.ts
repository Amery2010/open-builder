import { describe, expect, it } from "vitest";
import type { DesignSystemPackage } from "./validation";
import { applyDesignSystemPackage } from "./apply";

const designPackage: DesignSystemPackage = {
  manifest: {
    schemaVersion: "open-builder-design-system/v1",
    id: "stripe",
    name: "Stripe",
    files: { design: "DESIGN.md", tokens: "tokens.css" },
  },
  manifestText: "{}",
  design: "# Stripe reference",
  tokens: ":root { --accent: #533afd; }",
  digest: "a".repeat(64),
  reference: {
    id: "stripe",
    name: "Stripe",
    source: "builtin",
    version: "test-commit",
    digest: "a".repeat(64),
  },
};

describe("applyDesignSystemPackage", () => {
  it("builds canonical contract changes without mutating the input", () => {
    const files = {
      "src/App.tsx": "export default () => null",
      "DESIGN.md": "old design",
      "TOKENS.css": "old tokens",
    };
    const result = applyDesignSystemPackage(files, designPackage);

    expect(files["DESIGN.md"]).toBe("old design");
    expect(files["TOKENS.css"]).toBe("old tokens");
    expect(result.files["DESIGN.md"]).toBe("# Stripe reference");
    expect(result.files["TOKENS.css"]).toContain("--accent: #533afd");
    expect(result.changes).toEqual([
      { path: "DESIGN.md", action: "modified" },
      { path: "TOKENS.css", action: "modified" },
    ]);
  });

  it("requires project initialization", () => {
    expect(() => applyDesignSystemPackage({}, designPackage)).toThrow(
      /initialized project files/,
    );
  });
});
