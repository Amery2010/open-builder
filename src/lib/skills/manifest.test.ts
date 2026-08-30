import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSkillMd } from "./parser";
import type { SkillManifest } from "./types";
import { resolvePublicSkillUrl } from "./manifest";
import { FORCED_SKILLS_MAX_BYTES } from "./registry";

const publicRoot = new URL("../../../public/skills/", import.meta.url);
const EXPECTED_IDS = [
  "debug-web-app",
  "build-tailwind-ui",
  "build-accessible-ui",
  "write-safe-typescript",
  "art-direct-web",
  "design-product-ui",
  "review-code",
  "simplify-code",
] as const;

function readPublic(path: string): string {
  return readFileSync(new URL(path, publicRoot), "utf8");
}

function readManifest(): SkillManifest {
  return JSON.parse(readPublic("manifest.json")) as SkillManifest;
}

describe("public skills manifest", () => {
  it("matches every shipped SKILL.md and declared file", () => {
    const manifest = readManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(new Set(manifest.skills.map((skill) => skill.id)).size).toBe(
      manifest.skills.length,
    );

    for (const skill of manifest.skills) {
      expect(() => readPublic(skill.entry)).not.toThrow();
      expect(skill.files).toEqual([skill.entry]);
      for (const file of skill.files) {
        expect(() => readPublic(file)).not.toThrow();
      }
      const parsed = parseSkillMd(readPublic(skill.entry)).frontmatter;
      expect(parsed.name).toBe(skill.name);
      expect(parsed.description).toBe(skill.description);
      expect(parsed.version).toBe(skill.version);
      expect(parsed["allowed-tools"] ?? []).toEqual(skill.allowedTools ?? []);
      expect(parsed.tags ?? []).toEqual(skill.tags ?? []);
    }
  });

  it("resolves public assets under nested Vite base paths", () => {
    expect(
      resolvePublicSkillUrl(
        "review-code/SKILL.md",
        "/open-builder/",
        "https://example.com/open-builder/index.html",
      ),
    ).toBe("https://example.com/open-builder/skills/review-code/SKILL.md");
  });

  it("ships exactly the eight renamed version-2 built-ins", () => {
    const manifest = readManifest();
    expect(manifest.skills.map((skill) => skill.id)).toEqual(EXPECTED_IDS);
    for (const skill of manifest.skills) {
      expect(skill.name).toBe(skill.id);
      expect(skill.version).toBe("2.0.0");
      expect(skill.description.length).toBeGreaterThan(80);
      expect(skill.files).not.toEqual(
        expect.arrayContaining([
          `${skill.id}/SOURCE.md`,
          `${skill.id}/LICENSE.txt`,
        ]),
      );
    }
  });

  it("keeps all detailed built-in bodies within the forced-prompt limit", () => {
    const manifest = readManifest();
    const bodies = manifest.skills.map(
      (skill) => parseSkillMd(readPublic(skill.entry)).body,
    );

    for (const body of bodies) {
      expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2_000);
    }
    expect(
      new TextEncoder().encode(bodies.join("")).byteLength,
    ).toBeLessThanOrEqual(FORCED_SKILLS_MAX_BYTES);
  });

  it("keeps routing and authorization boundaries in the rewritten manuals", () => {
    const body = (id: (typeof EXPECTED_IDS)[number]) =>
      parseSkillMd(readPublic(`${id}/SKILL.md`)).body;

    expect(body("art-direct-web")).toContain("`design-product-ui`");
    expect(body("design-product-ui")).toContain("`art-direct-web`");
    expect(body("art-direct-web")).toContain("`create`");
    expect(body("art-direct-web")).toContain("selected-but-unapplied");
    expect(body("design-product-ui")).toContain("run-local Design contract");
    expect(body("design-product-ui")).toContain("`design_system` error");
    expect(body("review-code")).toContain("default deliverable is findings");
    expect(body("simplify-code")).toContain(
      "without altering observable behavior",
    );
    expect(body("debug-web-app")).toContain("one falsifiable hypothesis");
    expect(body("build-accessible-ui")).toContain("radio buttons");
    expect(body("write-safe-typescript")).toContain("runtime data");
    expect(body("build-tailwind-ui")).toContain("Tailwind major version");
  });
});
