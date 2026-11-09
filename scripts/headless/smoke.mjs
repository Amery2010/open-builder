import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = new URL("../../", import.meta.url);
const cliPackage = JSON.parse(
  await readFile(new URL("packages/cli/package.json", root), "utf8"),
);
const spawn = createRequire(new URL("packages/cli/package.json", root))(
  "cross-spawn",
);
const tarball = fileURLToPath(
  new URL(
    `artifacts/headless/open-builder-cli-${cliPackage.version}.tgz`,
    root,
  ),
);
const temporary = await mkdtemp(path.join(tmpdir(), "open-builder-installed-"));
const evidence = {
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  packageVersion: cliPackage.version,
  steps: [],
  visualVerification: "not-run",
};
let client;

function command(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(
              `Smoke command failed (${code}): ${executable}\n${stdout}\n${stderr}`,
            ),
          ),
    );
  });
}

try {
  await writeFile(
    path.join(temporary, "package.json"),
    '{"private":true,"name":"builder-install-smoke"}\n',
  );
  await command(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    temporary,
  );
  evidence.steps.push("install-tarball-outside-repository");
  const entry = path.join(
    temporary,
    "node_modules",
    "@open-builder",
    "cli",
    "dist",
    "main.js",
  );
  const executable = path.join(
    temporary,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "open-builder.cmd" : "open-builder",
  );
  const cli = (...args) => command(executable, args, temporary);
  assert.equal((await cli("--version")).trim(), cliPackage.version);
  assert.match(await cli("--help"), /open-builder verify/);
  const workspace = path.join(temporary, "workspace with spaces");
  await mkdir(workspace);
  const react = path.join(workspace, "react 应用");
  assert.equal(
    JSON.parse(
      await cli(
        "init",
        react,
        "--template",
        "react-ts",
        "--design",
        "notion",
        "--json",
      ),
    ).ok,
    true,
  );
  await writeFile(
    path.join(react, "src", "App.tsx"),
    `import { useState } from 'react';
export default function App() { const [count, setCount] = useState(0); return <main><h1>Verified application</h1><button type="button" onClick={() => setCount(count + 1)}>Count: {count}</button></main>; }
`,
  );
  await writeFile(path.join(react, "user-notes.txt"), "Preserve my work.\n");
  await command(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    react,
  );
  for (const task of ["typecheck", "build"]) {
    const result = JSON.parse(
      await cli("verify", react, "--task", task, "--json"),
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.status, "passed");
    evidence.steps.push(`installed-cli-react-${task}`);
  }
  const check = JSON.parse(await cli("check", react, "--json"));
  assert.equal(check.ok, true);
  assert.equal(check.data.design.staticWiringDetected, true);
  assert.match(
    await readFile(path.join(react, "dist", "index.html"), "utf8"),
    /script/,
  );
  assert.equal(
    await readFile(path.join(react, "user-notes.txt"), "utf8"),
    "Preserve my work.\n",
  );
  evidence.steps.push("installed-cli-source-check-and-user-file-preservation");

  client = new Client({ name: "installed-builder-smoke", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        entry,
        "mcp",
        "--stdio",
        "--root",
        workspace,
        "--allow-project-scripts",
      ],
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry) => entry[1] !== undefined),
      ),
      stderr: "inherit",
    }),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 6);
  const mcpList = await client.callTool({
    name: "builder_list_templates",
    arguments: {},
  });
  assert.deepEqual(
    mcpList.structuredContent,
    JSON.parse(await cli("templates", "list", "--json")),
  );
  const initialized = await client.callTool({
    name: "builder_init_project",
    arguments: { path: "static", template: "static", design: "linear" },
  });
  assert.equal(initialized.structuredContent.ok, true);
  const checked = await client.callTool({
    name: "builder_check_project",
    arguments: { path: "static" },
  });
  assert.equal(checked.structuredContent.ok, true);
  const verified = await client.callTool({
    name: "builder_verify_project",
    arguments: { path: "react 应用", task: "build" },
  });
  assert.equal(verified.structuredContent.ok, true);
  evidence.steps.push(
    "installed-mcp-discovery-init-check-real-react-build-parity",
  );
  await client.close();
  client = undefined;
  const output = new URL(
    `artifacts/headless/smoke-${process.platform}.json`,
    root,
  );
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
