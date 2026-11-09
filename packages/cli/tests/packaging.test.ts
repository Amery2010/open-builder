import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repository = new URL("../../../", import.meta.url);
const execute = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "builder-package-")),
  );
  for (const relative of [
    ".gitattributes",
    "LICENSE",
    "scripts/package-workflow-skill.mjs",
    "skills/open-builder-workflow",
    "public/skills",
  ]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(new URL(relative, repository), target, { recursive: true });
  }
  await symlink(
    fileURLToPath(new URL("node_modules", repository)),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runScript(relative: string): Promise<void> {
  await execute(process.execPath, [path.join(root, relative)], {
    cwd: root,
    timeout: 15_000,
  });
}

describe("portable packaging", () => {
  it("packages CRLF Skill metadata and retains reference source hashes", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "public/skills/manifest.json"), "utf8"),
    );
    const sources = [
      "skills/open-builder-workflow/SKILL.md",
      ...manifest.skills.map(
        (entry: { entry: string }) => `public/skills/${entry.entry}`,
      ),
    ];
    for (const relative of sources) {
      const filename = path.join(root, relative);
      const content = await readFile(filename, "utf8");
      await writeFile(filename, content.replace(/\r?\n/g, "\r\n"));
    }
    await runScript("scripts/package-workflow-skill.mjs");
    const archive = await JSZip.loadAsync(
      await readFile(
        path.join(root, "artifacts/skills/open-builder-workflow-0.1.0.zip"),
      ),
    );
    const generated = JSON.parse(
      await archive.file("open-builder-workflow/sources.json")!.async("string"),
    );
    expect(generated).toHaveLength(manifest.skills.length);
    for (const entry of generated) {
      const source = await readFile(path.join(root, entry.source));
      expect(entry.sha256).toBe(
        createHash("sha256").update(source).digest("hex"),
      );
      const reference = await archive
        .file(`open-builder-workflow/references/${entry.id}.md`)!
        .async("string");
      expect(reference).not.toMatch(/^---\r?\n/);
      expect(reference.trim()).not.toBe("");
    }
  });

  it("builds pinned design resources after a checkout with CRLF conversion enabled", async () => {
    await mkdir(path.join(root, "scripts/headless"), { recursive: true });
    await cp(
      new URL("scripts/headless/build.mjs", repository),
      path.join(root, "scripts/headless/build.mjs"),
    );
    await cp(
      new URL("packages/cli/src", repository),
      path.join(root, "packages/cli/src"),
      { recursive: true },
    );
    await cp(
      new URL("packages/cli/package.json", repository),
      path.join(root, "packages/cli/package.json"),
    );
    await mkdir(path.join(root, "public/design-systems"), { recursive: true });
    await cp(
      new URL("public/design-systems/catalog.json", repository),
      path.join(root, "public/design-systems/catalog.json"),
    );
    for (const id of ["linear", "stripe", "notion"]) {
      await cp(
        new URL(`public/design-systems/${id}`, repository),
        path.join(root, "public/design-systems", id),
        { recursive: true },
      );
    }
    // Exercise Git's actual checkout conversion in an isolated index; no commit is needed.
    await writeFile(
      path.join(root, "conversion-control.txt"),
      "checkout control\n",
    );
    await execute("git", ["init", "--quiet"], { cwd: root });
    const conversion = [
      "-c",
      "core.autocrlf=true",
      "-c",
      "core.safecrlf=false",
    ];
    await execute(
      "git",
      [
        ...conversion,
        "add",
        "--",
        ".gitattributes",
        "public",
        "skills",
        "conversion-control.txt",
      ],
      { cwd: root },
    );
    for (const relative of ["public", "skills", "conversion-control.txt"]) {
      await rm(path.join(root, relative), { recursive: true, force: true });
    }
    await execute(
      "git",
      [...conversion, "checkout-index", "--all", "--force"],
      { cwd: root },
    );
    expect(
      await readFile(path.join(root, "conversion-control.txt"), "utf8"),
    ).toContain("\r\n");
    for (const relative of [
      "public/design-systems/linear/manifest.json",
      "public/design-systems/linear/DESIGN.md",
      "public/design-systems/linear/tokens.css",
      "public/skills/design-product-ui/SKILL.md",
      "skills/open-builder-workflow/SKILL.md",
    ]) {
      expect(await readFile(path.join(root, relative), "utf8")).not.toContain(
        "\r\n",
      );
    }
    await runScript("scripts/headless/build.mjs");
    await runScript("scripts/package-workflow-skill.mjs");
    const catalog = JSON.parse(
      await readFile(
        path.join(root, "packages/cli/assets/design-systems/catalog.json"),
        "utf8",
      ),
    );
    expect(catalog.map((entry: { id: string }) => entry.id).sort()).toEqual([
      "linear",
      "notion",
      "stripe",
    ]);
  });
});
