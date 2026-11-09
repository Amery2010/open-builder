import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const cli = new URL("packages/cli/", root);
const selected = new Set(["linear", "stripe", "notion"]);
const catalog = JSON.parse(
  await readFile(new URL("public/design-systems/catalog.json", root), "utf8"),
);
const assets = new URL("assets/design-systems/", cli);
await rm(new URL("dist/", cli), { recursive: true, force: true });
await rm(new URL("assets/", cli), { recursive: true, force: true });
await mkdir(assets, { recursive: true });
for (const entry of catalog.filter((item) => selected.has(item.id))) {
  const contents = [];
  await mkdir(new URL(`${entry.id}/`, assets));
  for (const name of ["manifest.json", "DESIGN.md", "tokens.css"]) {
    const source = new URL(`public/design-systems/${entry.id}/${name}`, root);
    contents.push(await readFile(source, "utf8"));
    await copyFile(source, new URL(`${entry.id}/${name}`, assets));
  }
  const digest = createHash("sha256").update(contents.join("\0")).digest("hex");
  if (digest !== entry.digest)
    throw new Error(`Design package digest mismatch: ${entry.id}`);
}
const entries = catalog.filter((entry) => selected.has(entry.id));
if (entries.length !== selected.size)
  throw new Error("Missing selected design systems.");
await writeFile(
  new URL("catalog.json", assets),
  `${JSON.stringify(entries, null, 2)}\n`,
);
await copyFile(new URL("LICENSE", root), new URL("LICENSE", cli));
await copyFile(
  new URL("src/node/windows-job.ps1", cli),
  new URL("assets/windows-job.ps1", cli),
);
await build({
  entryPoints: [fileURLToPath(new URL("src/main.ts", cli))],
  outfile: fileURLToPath(new URL("dist/main.js", cli)),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/server/*",
    "cross-spawn",
    "zod",
  ],
  sourcemap: true,
});
await chmod(new URL("dist/main.js", cli), 0o755);
console.error("Built Open Builder CLI and bundled design resources.");
