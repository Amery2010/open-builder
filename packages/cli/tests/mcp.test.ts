import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const temporary: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function connect(verify = false) {
  const root = await mkdtemp(path.join(tmpdir(), "builder-mcp-"));
  temporary.push(root);
  const client = new Client({ name: "builder-tests", version: "1.0.0" });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../dist/main.js", import.meta.url)),
      "mcp",
      "--stdio",
      "--root",
      root,
      ...(verify ? ["--allow-project-scripts"] : []),
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, root };
}

describe("stdio MCP", () => {
  it("discovers five tools by default and matches CLI structured results", async () => {
    const { client } = await connect();
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(5);
    expect(
      tools.tools.some((tool) => tool.name === "builder_verify_project"),
    ).toBe(false);
    const mcp = await client.callTool({
      name: "builder_list_templates",
      arguments: {},
    });
    let stdout = "";
    await runCli(["templates", "list", "--json"], {
      out: (text) => {
        stdout += text;
      },
      err: () => {},
    });
    expect(mcp.structuredContent).toEqual(JSON.parse(stdout));
  });

  it("creates, checks and rejects unsafe paths without touching outside files", async () => {
    const { client, root } = await connect();
    const created = await client.callTool({
      name: "builder_init_project",
      arguments: { path: "demo", template: "static", design: "linear" },
    });
    expect(created.isError).toBe(false);
    const checked = await client.callTool({
      name: "builder_check_project",
      arguments: { path: "demo" },
    });
    expect(checked.structuredContent).toMatchObject({
      ok: true,
      data: { design: { tokensValid: true, staticWiringDetected: true } },
    });
    const escaped = await client.callTool({
      name: "builder_init_project",
      arguments: { path: "../outside", template: "static" },
    });
    expect(escaped.isError).toBe(true);
    expect(escaped.structuredContent).toMatchObject({ ok: false });
    const original = await readFile(
      path.join(root, "demo", "tokens.css"),
      "utf8",
    );
    const conflict = await client.callTool({
      name: "builder_apply_design_system",
      arguments: { path: "demo", id: "notion" },
    });
    expect(conflict.isError).toBe(true);
    expect(await readFile(path.join(root, "demo", "tokens.css"), "utf8")).toBe(
      original,
    );
  });

  it("enables script verification only from server startup configuration", async () => {
    const { client, root } = await connect(true);
    expect(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "builder_verify_project",
      ),
    ).toBe(true);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { build: 'node -e "console.log(42)"' } }),
    );
    const passed = await client.callTool({
      name: "builder_verify_project",
      arguments: { path: ".", task: "build" },
    });
    expect(passed.structuredContent).toMatchObject({
      operation: "verify",
      ok: true,
      data: { status: "passed", exitCode: 0 },
    });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { build: 'node -e "process.exit(7)"' } }),
    );
    const failed = await client.callTool({
      name: "builder_verify_project",
      arguments: { path: ".", task: "build" },
    });
    expect(failed.structuredContent).toMatchObject({
      ok: false,
      data: { status: "failed", exitCode: 7 },
    });
    const invalid = await client.callTool({
      name: "builder_verify_project",
      arguments: { path: ".", task: "dev", approved: true },
    });
    expect(invalid.isError).toBe(true);
  });

  it.each(["request cancellation", "client disconnect"])(
    "cleans up script descendants after %s",
    async (reason) => {
      const { client, root } = await connect(true);
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { build: "node build.cjs" } }),
      );
      await writeFile(
        path.join(root, "build.cjs"),
        "const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000)",
      );
      const controller = new AbortController();
      // Attach a rejection handler before cancellation or transport shutdown.
      const result = client
        .callTool(
          {
            name: "builder_verify_project",
            arguments: { path: ".", task: "build" },
          },
          { signal: controller.signal },
        )
        .catch(() => undefined);
      let childPid = 0;
      try {
        await expect
          .poll(
            async () => {
              try {
                childPid = Number(
                  await readFile(path.join(root, "child.pid"), "utf8"),
                );
              } catch {
                // The task has not written its startup marker yet.
              }
              return childPid;
            },
            { timeout: 12_000 },
          )
          .toBeGreaterThan(0);
        if (reason === "request cancellation") controller.abort();
        else await client.close();
        await result;
        await expect
          .poll(
            () => {
              try {
                process.kill(childPid, 0);
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 5_000 },
          )
          .toBe(false);
      } finally {
        await client.close();
        if (childPid > 0) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // Already cleaned up by the server.
          }
        }
      }
    },
  );
});
