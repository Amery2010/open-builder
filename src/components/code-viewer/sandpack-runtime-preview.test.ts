import { SANDBOX_TEMPLATES } from "@codesandbox/sandpack-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "vite";
import readline from "node:readline";
import { syncBuiltinESMExports } from "node:module";
import { projectSandpackRuntime } from "./sandpack-runtime-preview";

describe("Sandpack Vite terminal compatibility", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(
    Object.entries(SANDBOX_TEMPLATES).filter(([name]) =>
      name.startsWith("vite"),
    ),
  )(
    "disables terminal clearing in the %s preview without editing the source project",
    (_name, template) => {
      const file = (
        template.files as Record<string, string | { code: string }>
      )["/package.json"];
      const source = typeof file === "string" ? file : file.code;
      const files = { "package.json": source };
      const projection = projectSandpackRuntime(files);
      expect(JSON.parse(projection.files["package.json"]).scripts.dev).toBe(
        "vite --clearScreen false",
      );
      expect(files["package.json"]).toBe(source);
      expect(
        projection.restore("package.json", projection.files["package.json"]),
      ).toBe(source);
    },
  );

  it.each([
    { scripts: { dev: "vite --clearScreen false" } },
    { name: "static-fixture" },
  ])(
    "normalizes package formatting without persisting generated maps for %j",
    (pkg) => {
      const source = JSON.stringify(pkg, null, 4) + "\n";
      const files = { "package.json": source };
      const result = projectSandpackRuntime(files);
      const projected = result.files["package.json"];
      expect(projected).toBe(
        JSON.stringify(
          { ...pkg, dependencies: {}, devDependencies: {} },
          null,
          2,
        ),
      );
      expect(result.restore("package.json", projected)).toBe(source);
      expect(projectSandpackRuntime(result.files).files).toBe(result.files);
      const edited = { ...JSON.parse(projected), description: "A real edit" };
      expect(
        JSON.parse(result.restore("package.json", JSON.stringify(edited))!),
      ).toEqual({ ...pkg, description: "A real edit" });
      expect(projectSandpackRuntime(files, false).files).toBe(files);
    },
  );

  it("prevents the actual Vite logger from reaching the missing Nodebox API", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const ci = process.env.CI;
    const warn = vi.fn();
    const clear = readline.clearScreenDown;
    const cursor = readline.cursorTo;
    const message =
      '"clearScreenDown" is not yet implemented. Please file an issue on GitHub if you rely on this feature.';
    try {
      readline.clearScreenDown = () => {
        warn(message);
        return true;
      };
      readline.cursorTo = () => true;
      syncBuiltinESMExports();
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      delete process.env.CI;
      vi.spyOn(console, "log").mockImplementation(() => {});
      createLogger().clearScreen("info");
      expect(warn).toHaveBeenCalledWith(message);
      warn.mockClear();
      const files = projectSandpackRuntime({
        "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      }).files;
      const command = JSON.parse(files["package.json"]).scripts.dev;
      const logger = createLogger("info", {
        allowClearScreen: !command.includes("--clearScreen false"),
      });
      logger.clearScreen("info");
      logger.info("hmr update /src/App.tsx", { timestamp: true, clear: true });
      logger.info("page reload index.html", { timestamp: true, clear: true });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      readline.clearScreenDown = clear;
      readline.cursorTo = cursor;
      syncBuiltinESMExports();
      if (descriptor)
        Object.defineProperty(process.stdout, "isTTY", descriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (ci === undefined) delete process.env.CI;
      else process.env.CI = ci;
    }
  });

  it.each([
    [
      "vite --host 0.0.0.0 --port 5173",
      "vite --clearScreen false --host 0.0.0.0 --port 5173",
    ],
    ["vite --clearScreen true", "vite --clearScreen false"],
    ["vite --clearScreen=true", "vite --clearScreen false"],
    [
      "NODE_ENV=development vite",
      "NODE_ENV=development vite --clearScreen false",
    ],
    ["pnpm exec vite", "pnpm exec vite --clearScreen false"],
    ["tsc && vite", "tsc && vite --clearScreen false"],
    [
      'echo "vite && ready" && vite',
      'echo "vite && ready" && vite --clearScreen false',
    ],
    ["echo vite", "echo vite"],
    ["node server.js", "node server.js"],
  ])(
    "projects %s without changing other shell arguments",
    (command, expected) => {
      const files = {
        "package.json": JSON.stringify({ scripts: { dev: command } }),
      };
      const result = projectSandpackRuntime(files);
      expect(JSON.parse(result.files["package.json"]).scripts.dev).toBe(
        expected,
      );
      expect(projectSandpackRuntime(result.files).files).toBe(result.files);
    },
  );

  it("restores projected scripts while retaining real package edits", () => {
    const files = {
      "package.json": JSON.stringify({
        scripts: { dev: "vite" },
        dependencies: { vite: "4.2.0" },
      }),
    };
    const result = projectSandpackRuntime(files);
    const changed = JSON.parse(result.files["package.json"]);
    changed.dependencies.react = "18.3.1";
    expect(
      JSON.parse(result.restore("package.json", JSON.stringify(changed))!),
    ).toEqual({
      scripts: { dev: "vite" },
      dependencies: { vite: "4.2.0", react: "18.3.1" },
    });
    expect(projectSandpackRuntime(files, false).files).toBe(files);
    expect(
      projectSandpackRuntime({ "package.json": "invalid" }).files[
        "package.json"
      ],
    ).toBe("invalid");
  });

  it.each([
    ["vite", "vite --clearScreen false --host", "vite --host"],
    ["vite", "vite dev --clearScreen false --host", "vite dev --host"],
    [
      "vite --clearScreen true",
      "vite --clearScreen false --host",
      "vite --clearScreen true --host",
    ],
    [
      "vite",
      "vite --clearScreen true --host",
      "vite --clearScreen true --host",
    ],
  ])(
    "restores generated arguments in edited %s scripts",
    (original, edited, expected) => {
      const result = projectSandpackRuntime({
        "package.json": JSON.stringify({ scripts: { dev: original } }),
      });
      const content = JSON.stringify({ scripts: { dev: edited } });
      expect(
        JSON.parse(result.restore("package.json", content)!).scripts.dev,
      ).toBe(expected);
    },
  );

  it("also adapts a Vite template's default package without persisting synthetic files", () => {
    const files = { "src/App.tsx": "export default () => null" };
    const result = projectSandpackRuntime(files, true, "vite-react-ts");
    expect(JSON.parse(result.files["package.json"]).scripts.dev).toBe(
      "vite --clearScreen false",
    );
    expect(files).not.toHaveProperty("package.json");
    expect(
      result.restore("package.json", result.files["package.json"]),
    ).toBeUndefined();
    expect(
      result.restore(
        "package.json",
        JSON.stringify(JSON.parse(result.files["package.json"])),
      ),
    ).toBeUndefined();
    const edited = JSON.parse(result.files["package.json"]);
    edited.name = "my-project";
    expect(
      JSON.parse(result.restore("package.json", JSON.stringify(edited))!),
    ).toMatchObject({ name: "my-project", scripts: { dev: "vite" } });
  });
});
