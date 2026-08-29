import { describe, expect, it, vi } from "vitest";
import type { DirEntry, SkillFs } from "./fs";
import {
  FORCED_SKILLS_MAX_BYTES,
  SkillRegistry,
  type SkillsStoreApi,
} from "./registry";
import type { SkillEntry, SkillManifest } from "./types";
import { createTextSkill } from "./text-creator";

class MemorySkillFs implements SkillFs {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`File not found: ${path}`);
    return value;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    const parts = path.split("/");
    parts.pop();
    for (let index = 1; index <= parts.length; index++) {
      this.dirs.add(parts.slice(0, index).join("/"));
    }
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const prefix = path ? `${path}/` : "";
    const entries = new Map<string, DirEntry>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const [name, ...rest] = filePath.slice(prefix.length).split("/");
      entries.set(name, {
        name,
        isFile: rest.length === 0,
        isDirectory: rest.length > 0,
      });
    }
    return Array.from(entries.values());
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string): Promise<void> {
    for (const key of Array.from(this.files.keys())) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
    for (const key of Array.from(this.dirs.keys())) {
      if (key === path || key.startsWith(`${path}/`)) this.dirs.delete(key);
    }
  }

  async exists(path: string): Promise<boolean> {
    return (
      this.files.has(path) ||
      this.dirs.has(path) ||
      Array.from(this.files.keys()).some((key) => key.startsWith(`${path}/`))
    );
  }
}

function createStore(initial: SkillEntry[] = []): SkillsStoreApi {
  const entries = new Map(initial.map((entry) => [entry.id, entry]));
  return {
    getSkill: (id) => entries.get(id),
    listAll: () => Array.from(entries.values()),
    registerSkill: (entry) => entries.set(entry.id, entry),
    unregisterSkill: (id) => void entries.delete(id),
    setSkillAutoEnabled: (id, autoEnabled) => {
      const entry = entries.get(id);
      if (entry) entries.set(id, { ...entry, autoEnabled });
    },
  };
}

function skillMd(version: string, body = "Follow this skill."): string {
  return [
    "---",
    "name: demo",
    "description: Demo skill",
    `version: ${version}`,
    "tags: [test]",
    "---",
    "",
    body,
  ].join("\n");
}

function manifest(version: string): SkillManifest {
  return {
    schemaVersion: 1,
    skills: [
      {
        id: "demo",
        name: "demo",
        description: "Demo skill",
        version,
        tags: ["test"],
        entry: "demo/SKILL.md",
        files: ["demo/SKILL.md", "demo/scripts/run.js"],
      },
    ],
  };
}

function fetchManifest(version: string, skillResponse = skillMd(version)) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("manifest.json")) {
      return new Response(JSON.stringify(manifest(version)), { status: 200 });
    }
    if (url.endsWith("demo/SKILL.md")) {
      return new Response(skillResponse, { status: 200 });
    }
    if (url.endsWith("demo/scripts/run.js")) {
      return new Response("console.log('desktop')", { status: 200 });
    }
    return new Response("missing", { status: 404 });
  });
}

describe("SkillRegistry public catalog", () => {
  it("creates validated text skills without overwriting a name collision", async () => {
    const fs = new MemorySkillFs();
    const store = createStore();
    const registry = new SkillRegistry(fs, store, { platform: "web" });

    const first = await createTextSkill(registry, {
      name: "Review Skill",
      description: "Review code",
      instructions: "Inspect the changed files.",
      tags: ["review", "review"],
    });
    const second = await createTextSkill(registry, {
      name: "Review Skill",
      description: "Review code again",
      instructions: "Inspect the changed files again.",
    });

    expect(first.entry.id).toBe("Review-Skill");
    expect(second.entry.id).toBe("Review-Skill-2");
    expect(first.entry.tags).toEqual(["review"]);
    expect(fs.files.get("Review-Skill/SKILL.md")).toContain(
      "Inspect the changed files.",
    );
  });

  it("downloads text only on web and removes legacy package resources", async () => {
    const fs = new MemorySkillFs();
    await fs.writeFile("legacy/SKILL.md", skillMd("1.0.0"));
    await fs.writeFile("legacy/references/api.md", "legacy reference");
    await fs.writeFile("legacy/scripts/run.js", "legacy script");
    await fs.writeFile("orphan/SKILL.md", skillMd("1.0.0"));
    await fs.writeFile("orphan/assets/icon.txt", "legacy asset");
    await fs.writeFile("code-review/SKILL.md", skillMd("1.0.0"));
    const store = createStore([
      {
        id: "legacy",
        name: "legacy",
        description: "Legacy",
        version: "1.0.0",
        autoEnabled: true,
        source: "imported",
        installedAt: 1,
      },
    ]);
    const fetcher = fetchManifest("1.0.0");
    const registry = new SkillRegistry(fs, store, {
      platform: "web",
      fetcher,
    });

    await registry.initialize();

    expect(registry.getAutoEnabled().map((skill) => skill.id)).toEqual([
      "legacy",
      "demo",
    ]);
    expect(fs.files.has("demo/SKILL.md")).toBe(true);
    expect(fs.files.has("demo/scripts/run.js")).toBe(false);
    expect(fs.files.has("legacy/references/api.md")).toBe(false);
    expect(fs.files.has("legacy/scripts/run.js")).toBe(false);
    expect(fs.files.has("orphan/SKILL.md")).toBe(true);
    expect(fs.files.has("orphan/assets/icon.txt")).toBe(false);
    expect(fs.files.has("code-review/SKILL.md")).toBe(false);
  });

  it("downloads the complete built-in package on desktop", async () => {
    const fs = new MemorySkillFs();
    const store = createStore();
    const registry = new SkillRegistry(fs, store, {
      platform: "desktop",
      fetcher: fetchManifest("1.0.0"),
    });

    await registry.initialize();

    expect(fs.files.has("demo/SKILL.md")).toBe(true);
    expect(fs.files.get("demo/scripts/run.js")).toBe("console.log('desktop')");
    expect(store.getSkill("demo")?.autoEnabled).toBe(true);
  });

  it("keeps an enabled cached version until the skill is disabled and re-enabled", async () => {
    const fs = new MemorySkillFs();
    await fs.writeFile("demo/SKILL.md", skillMd("1.0.0", "Old body"));
    const store = createStore([
      {
        id: "demo",
        name: "demo",
        description: "Demo skill",
        version: "1.0.0",
        tags: ["test"],
        autoEnabled: true,
        source: "builtin",
        installedAt: 1,
        cachedVersion: "1.0.0",
      },
    ]);
    const fetcher = fetchManifest("2.0.0", skillMd("2.0.0", "New body"));
    const registry = new SkillRegistry(fs, store, {
      platform: "web",
      fetcher,
    });

    await registry.initialize();
    expect(await registry.readSkillContent("demo")).toContain("Old body");
    expect(store.getSkill("demo")?.availableVersion).toBe("2.0.0");
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("SKILL.md")),
    ).toHaveLength(0);

    await registry.setAutoEnabled("demo", false);
    await registry.setAutoEnabled("demo", true);

    expect(await registry.readSkillContent("demo")).toContain("New body");
    expect(store.getSkill("demo")?.cachedVersion).toBe("2.0.0");
  });

  it("uses the management toggle only for metadata discovery, not manual forcing", async () => {
    const fs = new MemorySkillFs();
    const store = createStore();
    const registry = new SkillRegistry(fs, store, {
      platform: "web",
      fetcher: fetchManifest("1.0.0"),
    });
    await registry.initialize();

    await registry.setAutoEnabled("demo", false);

    expect(registry.getAutoEnabled()).toEqual([]);
    await expect(registry.prepareForcedSkills(["demo"])).resolves.toMatchObject(
      [{ entry: { id: "demo", autoEnabled: false } }],
    );
  });

  it("resolves legacy forced built-in ids without rewriting imported ids", async () => {
    const fs = new MemorySkillFs();
    const store = createStore();
    const registry = new SkillRegistry(fs, store, { platform: "web" });
    await fs.writeFile(
      "review-code/SKILL.md",
      skillMd("2.0.0", "Review guidance"),
    );
    await registry.registerSkillFromDir("review-code", "builtin");

    await expect(
      registry.prepareForcedSkills(["code-review"]),
    ).resolves.toMatchObject([{ entry: { id: "review-code" } }]);

    await fs.writeFile(
      "code-review/SKILL.md",
      skillMd("1.0.0", "Imported guidance"),
    );
    await registry.registerSkillFromDir("code-review", "imported");
    await expect(
      registry.prepareForcedSkills(["code-review"]),
    ).resolves.toMatchObject([{ entry: { id: "code-review" } }]);
  });

  it("omits a built-in skill whose first download fails", async () => {
    const fs = new MemorySkillFs();
    const store = createStore();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) {
        return new Response(JSON.stringify(manifest("1.0.0")), {
          status: 200,
        });
      }
      return new Response("failed", { status: 503, statusText: "Unavailable" });
    });
    const registry = new SkillRegistry(fs, store, {
      platform: "web",
      fetcher,
    });

    await registry.initialize();

    expect(registry.getAutoEnabled()).toEqual([]);
    expect(registry.getIssues().demo).toMatch(/503/);
  });

  it("recursively lists references and enforces the forced prompt budget", async () => {
    const fs = new MemorySkillFs();
    const store = createStore();
    const registry = new SkillRegistry(fs, store, { platform: "desktop" });
    await fs.writeFile(
      "custom/SKILL.md",
      skillMd("1.0.0", "x".repeat(FORCED_SKILLS_MAX_BYTES + 1)),
    );
    await fs.writeFile("custom/references/api/auth.md", "Nested reference");
    await fs.writeFile("custom/scripts/reports/run.js", "Nested script");
    await registry.registerSkillFromDir("custom", "imported");

    expect(await registry.listReferences("custom")).toEqual(["api/auth.md"]);
    expect(await registry.listScripts("custom")).toEqual(["reports/run.js"]);
    await expect(registry.prepareForcedSkills(["custom"])).rejects.toThrow(
      /128 KiB prompt limit/,
    );
  });

  it("rejects an invalid text skill before writing it", async () => {
    const fs = new MemorySkillFs();
    const registry = new SkillRegistry(fs, createStore(), {
      platform: "web",
    });

    await expect(
      createTextSkill(registry, {
        name: "Empty",
        description: "Missing instructions",
        instructions: "   ",
      }),
    ).rejects.toThrow();
    expect(fs.files.size).toBe(0);
  });
});
