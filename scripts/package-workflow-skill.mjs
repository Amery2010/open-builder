import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { load } from "js-yaml";

const root = new URL("../", import.meta.url);
const output = new URL("artifacts/skills/", root);
const skill = new URL("open-builder-workflow/", output);
await mkdir(output, { recursive: true });
await rm(skill, { recursive: true, force: true });
await cp(new URL("skills/open-builder-workflow/", root), skill, {
  recursive: true,
});
const manifest = JSON.parse(
  await readFile(new URL("public/skills/manifest.json", root), "utf8"),
);
const zip = new JSZip();
const sources = [];
for (const entry of manifest.skills) {
  const text = await readFile(
    new URL(`public/skills/${entry.entry}`, root),
    "utf8",
  );
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart();
  const name = `references/${entry.id}.md`;
  await writeFile(new URL(name, skill), body);
  sources.push({
    id: entry.id,
    version: entry.version,
    source: `public/skills/${entry.entry}`,
    sha256: createHash("sha256").update(text).digest("hex"),
  });
}
await writeFile(
  new URL("sources.json", skill),
  `${JSON.stringify(sources, null, 2)}\n`,
);
await cp(new URL("LICENSE", root), new URL("LICENSE", skill));
const entrypoint = await readFile(new URL("SKILL.md", skill), "utf8");
const metadata = load(
  entrypoint.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "",
);
if (metadata?.name !== "open-builder-workflow" || !metadata.description)
  throw new Error("Invalid workflow skill metadata.");

// Traverse the finished artifact, so missing references fail before distribution.
const { readdir } = await import("node:fs/promises");
async function addDirectory(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    const url = new URL(
      entry.name + (entry.isDirectory() ? "/" : ""),
      directory,
    );
    if (entry.isDirectory()) await addDirectory(url, `${path}/`);
    else {
      const bytes = await readFile(url);
      if (path.endsWith(".md")) {
        for (const match of bytes.toString("utf8").matchAll(/\]\(([^)]+)\)/g)) {
          const target = match[1];
          if (/^(?:https?:|#)/.test(target)) continue;
          const resolved = new URL(target.split("#")[0], url);
          if (!resolved.href.startsWith(skill.href))
            throw new Error(`Reference escapes skill: ${target}`);
          await readFile(resolved);
        }
      }
      zip.file(`open-builder-workflow/${path}`, bytes, {
        date: new Date("2020-01-01T00:00:00Z"),
      });
    }
  }
}
await addDirectory(skill);
const archive = new URL("open-builder-workflow-0.1.0.zip", output);
await writeFile(
  archive,
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
console.log(fileURLToPath(archive));
