import { describe, expect, it, vi } from "vitest";
import type { DesignSystemPackage } from "./validation";
import {
  applyDesignSystemPackage,
  createApplyDesignSystemHandler,
} from "./apply";

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

describe("apply_design_system", () => {
  it("builds canonical contract changes without mutating the input", () => {
    const files = {
      "src/App.tsx": "export default () => null",
      "DESIGN.md": "old design",
      "TOKENS.css": "old tokens",
    };
    const result = applyDesignSystemPackage(files, designPackage);

    expect(files["DESIGN.md"]).toBe("old design");
    expect(files["TOKENS.css"]).toBe("old tokens");
    expect(result.files["DESIGN.md"]).toContain("# Stripe reference");
    expect(result.files["TOKENS.css"]).toContain("--accent: #533afd");
    expect(result.changes).toEqual([
      { path: "DESIGN.md", action: "modified" },
      { path: "TOKENS.css", action: "modified" },
    ]);
  });

  it("requires project initialization", async () => {
    const handler = createApplyDesignSystemHandler({
      getFiles: () => ({}),
      onFilesChanged: vi.fn(),
      loadPackage: async () => designPackage,
    });
    const result = JSON.parse(
      await handler("apply_design_system", { system_id: "stripe" }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("init_project");
  });

  it("writes only canonical contracts and returns compact metadata", async () => {
    const onFilesChanged = vi.fn();
    const onApplied = vi.fn();
    const handler = createApplyDesignSystemHandler({
      getFiles: () => ({ "src/App.tsx": "export default () => null" }),
      onFilesChanged,
      onApplied,
      loadPackage: async () => designPackage,
    });
    const resultText = await handler("apply_design_system", {
      system_id: "stripe",
    });
    const result = JSON.parse(resultText);

    expect(result).toMatchObject({
      ok: true,
      system: { id: "stripe", digest: "a".repeat(64) },
      files: ["DESIGN.md", "tokens.css"],
    });
    expect(resultText).not.toContain("# Stripe reference");
    expect(onFilesChanged).toHaveBeenCalledOnce();
    const [files, changes] = onFilesChanged.mock.calls[0];
    expect(files["src/App.tsx"]).toContain("export default");
    expect(files["DESIGN.md"]).toContain("Unofficial reference");
    expect(files["tokens.css"]).toContain("--accent: #533afd");
    expect(changes).toEqual([
      { path: "DESIGN.md", action: "created" },
      { path: "tokens.css", action: "created" },
    ]);
    expect(onApplied).toHaveBeenCalledWith(designPackage.reference);
  });

  it("cannot apply a system other than the user's current selection", async () => {
    const onFilesChanged = vi.fn();
    const handler = createApplyDesignSystemHandler({
      getFiles: () => ({ "src/App.tsx": "export default () => null" }),
      onFilesChanged,
      getSelectedSystemId: () => "linear",
      loadPackage: async () => designPackage,
    });
    const result = JSON.parse(
      await handler("apply_design_system", { system_id: "stripe" }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/currently selected/i);
    expect(onFilesChanged).not.toHaveBeenCalled();
  });
});
