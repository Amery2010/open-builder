import { describe, expect, it, vi } from "vitest";
import {
  compileCustomDesignSystem,
  decideDesignSystem,
  listDesignSystemCandidates,
  type CustomDesignSystemDraft,
} from "./ai";
import { DesignSystemRegistry, MemoryDesignSystemStorage } from "./registry";
import type { DesignSystemPackage } from "./validation";

const validTokens = `:root {
  --bg: #ffffff;
  --surface: #f4f4f5;
  --fg: #18181b;
  --muted: #71717a;
  --border: #d4d4d8;
  --accent: #6d28d9;
  --accent-on: #ffffff;
  --font-display: ui-sans-serif;
  --font-body: ui-sans-serif;
  --radius-md: 0.75rem;
  --section-y-desktop: 6rem;
  --container-max: 72rem;
  --motion-base: 180ms;
}`;

const draft: CustomDesignSystemDraft = {
  name: "Quiet Workshop",
  visualDirection: "Calm, precise, tactile, and editorial.",
  foundations: "Warm neutrals, deep ink, compact radii, readable hierarchy.",
  composition:
    "Strong grid, quiet navigation, clear states, restrained motion.",
};

function compiledOutput(tokensCss = validTokens): string {
  return JSON.stringify({
    description: "A calm, precise product system.",
    designMarkdown: "# Quiet Workshop\n\nUse a disciplined editorial grid.",
    tokensCss,
  });
}

describe("design-system AI utilities", () => {
  it("accepts a candidate id and loads only that validated package", async () => {
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    const reference = {
      id: "apple",
      name: "Apple",
      source: "builtin" as const,
      version: "2.0.0",
      digest: "a".repeat(64),
    };
    const load = vi
      .spyOn(registry, "load")
      .mockResolvedValue({ reference } as DesignSystemPackage);

    const result = await decideDesignSystem(
      {
        brief: "A focused premium hardware launch.",
        attachmentNames: ["device.png"],
        projectPaths: ["src/App.tsx"],
        language: "en",
      },
      vi.fn(async () =>
        JSON.stringify({
          decision: "system",
          systemId: "apple",
          reason: "The request benefits from focused product storytelling.",
        }),
      ),
      registry,
    );

    expect(result.selectedSystem).toEqual(reference);
    expect(result.recommendation.systemId).toBe("apple");
    expect(load).toHaveBeenCalledWith("apple");
  });

  it("supports an explicit none decision without loading a package", async () => {
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    const load = vi.spyOn(registry, "load");
    const result = await decideDesignSystem(
      {
        brief: "Preserve the project's existing visual language.",
        attachmentNames: [],
        projectPaths: [],
        language: "en",
      },
      vi.fn(async () =>
        JSON.stringify({
          decision: "none",
          systemId: null,
          reason: "A curated system would be an unnecessary constraint.",
        }),
      ),
      registry,
    );

    expect(result.selectedSystem).toBeUndefined();
    expect(result.recommendation.systemId).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("repairs one malformed selection response and rejects unknown ids", async () => {
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    const repaired = vi
      .fn()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce(
        JSON.stringify({
          decision: "none",
          systemId: null,
          reason: "No close match.",
        }),
      );
    await expect(
      decideDesignSystem(
        {
          brief: "An unusual interface.",
          attachmentNames: [],
          projectPaths: [],
          language: "en",
        },
        repaired,
        registry,
      ),
    ).resolves.toMatchObject({ recommendation: { systemId: null } });
    expect(repaired).toHaveBeenCalledTimes(2);

    const invalid = vi.fn(async () =>
      JSON.stringify({
        decision: "system",
        systemId: "not-a-candidate",
        reason: "Invented.",
      }),
    );
    await expect(
      decideDesignSystem(
        {
          brief: "Anything.",
          attachmentNames: [],
          projectPaths: [],
          language: "en",
        },
        invalid,
        registry,
      ),
    ).rejects.toThrow("Unknown design-system candidate id");
    expect(invalid).toHaveBeenCalledTimes(2);
  });

  it("compiles, validates, and stages a custom package with an app-owned id", async () => {
    const generate = vi.fn(async () => compiledOutput());
    const staged = await compileCustomDesignSystem(draft, generate);

    expect(staged.package.reference).toMatchObject({
      id: "custom-quiet-workshop",
      name: "Quiet Workshop",
      source: "custom",
    });
    expect(staged.package.manifest.source).toEqual({ kind: "custom" });
    expect(staged.package.tokens).toContain("--motion-base");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("uses one directed repair for unsafe CSS and does not persist failures", async () => {
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        compiledOutput(`${validTokens}\nbody { color: red; }`),
      )
      .mockResolvedValueOnce(compiledOutput());

    await expect(
      compileCustomDesignSystem(draft, generate),
    ).resolves.toBeTruthy();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await registry.listImported()).toEqual([]);

    const alwaysUnsafe = vi.fn(async () =>
      compiledOutput(`${validTokens}\n@import url(https://example.com/x.css);`),
    );
    await expect(
      compileCustomDesignSystem(draft, alwaysUnsafe),
    ).rejects.toThrow();
    expect(alwaysUnsafe).toHaveBeenCalledTimes(2);
    expect(await registry.listImported()).toEqual([]);
  });

  it("handles duplicate names without overwriting and adds custom candidates", async () => {
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    const firstPackage = await compileCustomDesignSystem(draft, async () =>
      compiledOutput(),
    );
    const first = await registry.confirmImport(firstPackage.package);
    const second = await registry.confirmImport(firstPackage.package);

    expect(first.id).toBe("custom-quiet-workshop");
    expect(second.id).toBe("custom-quiet-workshop-2");
    expect(first.source).toBe("custom");
    expect(second.source).toBe("custom");
    const candidates = await listDesignSystemCandidates("en", registry);
    expect(
      candidates.filter((candidate) => candidate.source === "custom"),
    ).toHaveLength(2);
  });

  it("rejects rule input over 32,000 characters before calling the model", async () => {
    const generate = vi.fn(async () => compiledOutput());
    await expect(
      compileCustomDesignSystem(
        { ...draft, visualDirection: "x".repeat(32_001) },
        generate,
      ),
    ).rejects.toThrow("32,000");
    expect(generate).not.toHaveBeenCalled();
  });
});
