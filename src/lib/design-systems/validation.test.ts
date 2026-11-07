import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_DESIGN_SYSTEMS } from "./catalog";
import { loadBundledDesignSystem } from "./bundled";
import { applyDesignSystemPackage } from "./apply";
import {
  DESIGN_SYSTEM_LIMITS,
  validateDesignSystemPackage,
} from "./validation";

const publicRoot = fileURLToPath(
  new URL("../../../public/design-systems/", import.meta.url),
);
const fetchLocalText = (relativePath: string) =>
  readFile(path.join(publicRoot, relativePath), "utf8");

function validTokens(overrides = ""): string {
  return `:root {
  --bg: #fff;
  --surface: #fff;
  --fg: #111;
  --muted: #666;
  --border: #ddd;
  --accent: #6541f5;
  --accent-on: #fff;
  --font-display: system-ui;
  --font-body: system-ui;
  --radius-md: 8px;
  --section-y-desktop: 96px;
  --container-max: 1200px;
  --motion-base: 180ms;
  ${overrides}
}`;
}

function validFiles(tokens = validTokens()) {
  return [
    {
      path: "manifest.json",
      content: JSON.stringify({
        schemaVersion: "open-builder-design-system/v1",
        id: "sample",
        name: "Sample",
        files: { design: "DESIGN.md", tokens: "tokens.css" },
      }),
    },
    { path: "DESIGN.md", content: "# Sample" },
    { path: "tokens.css", content: tokens },
  ];
}

function declaredTokenNames(css: string): string[] {
  return Array.from(css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), (match) =>
    match[1].toLowerCase(),
  );
}

describe("Design system validation", () => {
  it("validates all 36 pinned bundled packages and their digests", async () => {
    expect(BUNDLED_DESIGN_SYSTEMS).toHaveLength(36);
    expect(new Set(BUNDLED_DESIGN_SYSTEMS.map((entry) => entry.id)).size).toBe(
      36,
    );
    const runtimeCatalog = JSON.parse(await fetchLocalText("catalog.json"));
    expect(runtimeCatalog.map((entry: { id: string }) => entry.id)).toEqual(
      BUNDLED_DESIGN_SYSTEMS.map((entry) => entry.id),
    );
    for (const entry of BUNDLED_DESIGN_SYSTEMS) {
      expect((await readdir(path.join(publicRoot, entry.id))).sort()).toEqual([
        "DESIGN.md",
        "manifest.json",
        "tokens.css",
      ]);
      const pkg = await loadBundledDesignSystem(entry.id, fetchLocalText);
      expect(Object.keys(JSON.parse(pkg.manifestText))).toEqual([
        "schemaVersion",
        "id",
        "name",
        "category",
        "description",
        "files",
      ]);
      expect(pkg.reference).toMatchObject({
        id: entry.id,
        name: entry.name,
        source: "builtin",
      });
      expect(pkg.digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("loads each curated source as a local package and applies its verified reference", async () => {
    const additions = BUNDLED_DESIGN_SYSTEMS.slice(12);
    expect(additions).toHaveLength(24);
    for (const entry of additions) {
      const pkg = await loadBundledDesignSystem(entry.id, fetchLocalText);
      expect(entry.id).not.toMatch(/^designmd-/);
      expect(pkg.manifest).not.toHaveProperty("source");
      expect(pkg.manifest).not.toHaveProperty("notice");
      expect(entry.tags.some((tag) => /[\u4e00-\u9fff]/.test(tag))).toBe(true);
      expect(pkg.design).toContain("reduced motion");
      const files = { "src/App.tsx": "export default () => null" };
      const applied = applyDesignSystemPackage(files, pkg);
      expect(applied.files["DESIGN.md"]).toBe(pkg.design);
      expect(applied.files["tokens.css"]).toContain(pkg.tokens);
      expect(applied.files["tokens.css"]).toContain(
        `sha256 ${pkg.reference.digest}`,
      );
      expect(files).toEqual({ "src/App.tsx": "export default () => null" });
    }
  });

  it("keeps bundled references concise and on one semantic token contract", async () => {
    let expectedTokenNames: string[] | undefined;
    for (const entry of BUNDLED_DESIGN_SYSTEMS) {
      const pkg = await loadBundledDesignSystem(entry.id, fetchLocalText);
      expect(pkg.design.length).toBeLessThanOrEqual(24_000);
      expect(pkg.tokens.length).toBeLessThanOrEqual(16_000);
      expect(pkg.tokens).not.toContain("/*");
      expect(pkg.design).toContain("tokens.css");
      expect(pkg.design).not.toMatch(
        /Agent Prompt Guide|Example Component Prompts|components\.html|design-systems\/_schema|apps\/daemon|```/,
      );

      const tokenNames = declaredTokenNames(pkg.tokens);
      expect(tokenNames).toHaveLength(56);
      if (expectedTokenNames) {
        expect(tokenNames).toEqual(expectedTokenNames);
      } else {
        expectedTokenNames = tokenNames;
      }

      const referencedTokenNames = Array.from(
        pkg.design.matchAll(/`(--[a-z0-9-]+)`/g),
        (match) => match[1].toLowerCase(),
      );
      expect(
        referencedTokenNames.filter((name) => !tokenNames.includes(name)),
      ).toEqual([]);
    }
  });

  it("rejects unsafe paths, scripts, and external CSS", async () => {
    await expect(
      validateDesignSystemPackage(
        [...validFiles(), { path: "../escape.js", content: "alert(1)" }],
        { source: "imported", version: "1" },
      ),
    ).rejects.toThrow(/unsafe/i);

    await expect(
      validateDesignSystemPackage(
        [...validFiles(), { path: "installer.sh", content: "echo no" }],
        { source: "imported", version: "1" },
      ),
    ).rejects.toThrow(/scripts or binary/i);

    await expect(
      validateDesignSystemPackage(
        validFiles(validTokens("--asset: url(https://example.test/x);")),
        { source: "imported", version: "1" },
      ),
    ).rejects.toThrow(/external css/i);
  });

  it("enforces required tokens and file limits", async () => {
    await expect(
      validateDesignSystemPackage(
        validFiles(validTokens().replace("--motion-base: 180ms;", "")),
        { source: "imported", version: "1" },
      ),
    ).rejects.toThrow(/--motion-base/);

    const oversized = validFiles();
    oversized[1].content = "x".repeat(DESIGN_SYSTEM_LIMITS.maxDesignBytes + 1);
    await expect(
      validateDesignSystemPackage(oversized, {
        source: "imported",
        version: "1",
      }),
    ).rejects.toThrow(/DESIGN\.md exceeds/i);
  });
});
