import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function invoke(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("CLI contract", () => {
  it("supports help, version and machine-readable discovery", async () => {
    expect((await invoke(["--help"])).stdout).toContain("open-builder verify");
    expect((await invoke(["--version"])).stdout.trim()).toBe("0.1.0");
    const list = await invoke(["templates", "list", "--json"]);
    expect(list.code).toBe(0);
    expect(
      JSON.parse(list.stdout).data.map((item: { id: string }) => item.id),
    ).toEqual(["react-ts", "static"]);
    expect(list.stderr).toBe("");
  });

  it.each([
    ["init", "--json"],
    ["check", ".", "--template", "static", "--json"],
    ["templates", "list", "unexpected", "--json"],
    ["--unknown", "--json"],
    ["verify", ".", "--json"],
  ])(
    "rejects invalid invocation %j without partial output",
    async (...args) => {
      const result = await invoke(args);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).error.code).toBe("INVALID_ARGUMENTS");
    },
  );

  it("initializes and checks an independent styled static project", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "builder-cli-"));
    temporary.push(parent);
    const project = path.join(parent, "应用 with spaces");
    const created = await invoke([
      "init",
      project,
      "--template",
      "static",
      "--design",
      "notion",
      "--json",
    ]);
    expect(created.code).toBe(0);
    expect(await readFile(path.join(project, "styles.css"), "utf8")).toContain(
      '@import "./tokens.css"',
    );
    const checked = await invoke(["check", project, "--json"]);
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.stdout).data.design.tokensValid).toBe(true);
    const verification = await invoke([
      "verify",
      project,
      "--task",
      "build",
      "--json",
    ]);
    expect(verification.code).toBe(2);
    expect(JSON.parse(verification.stdout).error.code).toBe(
      "TASK_NOT_APPLICABLE",
    );
  });

  it("keeps malformed package source excerpts out of diagnostics", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "builder-privacy-"));
    temporary.push(parent);
    await writeFile(
      path.join(parent, "package.json"),
      '{"password":"private-fixture-value", bad}',
    );
    const checked = await invoke(["check", parent, "--json"]);
    expect(checked.code).toBe(1);
    expect(checked.stdout).not.toContain("private-fixture-value");
    expect(JSON.parse(checked.stdout).data.report.issues[0].category).toBe(
      "dependencies",
    );
  });
});
