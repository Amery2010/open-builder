import { describe, expect, it } from "vitest";
import {
  createProjectHealthCheckHandler,
  PROJECT_HEALTH_LIMITS,
  runProjectHealthCheck,
} from "./project-health";

describe("runProjectHealthCheck", () => {
  it("reports a healthy Vite React project with no runtime issues", () => {
    const report = runProjectHealthCheck(
      {
        "package.json": JSON.stringify({
          scripts: { dev: "vite" },
          dependencies: { "@vitejs/plugin-react": "latest" },
        }),
        "index.html":
          '<html><head><title>App</title><meta name="viewport" content="width=device-width"></head><body><div id="root"></div></body></html>',
        "src/main.tsx": "import './App';\n",
        "src/App.tsx": "export function App() { return null; }\n",
      },
      [],
    );

    expect(report.ok).toBe(true);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
    expect(report.summary.dependencies).toBe(1);
  });

  it("classifies invalid package json and runtime errors", () => {
    const report = runProjectHealthCheck(
      {
        "package.json": "{ invalid",
        "index.html": "<html><head></head><body></body></html>",
      },
      [{ method: "error", data: ["ReferenceError: missing"] }],
    );

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          category: "dependencies",
          path: "package.json",
        }),
        expect.objectContaining({
          severity: "error",
          category: "runtime",
        }),
        expect.objectContaining({
          severity: "warning",
          category: "html",
        }),
      ]),
    );
  });

  it("can omit console logs for manual checks", () => {
    const report = runProjectHealthCheck(
      {
        "index.html":
          '<html><head><title>App</title><meta name="viewport" content="width=device-width"></head></html>',
      },
      [{ method: "error", data: ["boom"] }],
      { includeConsole: false },
    );

    expect(report.issues.some((issue) => issue.category === "runtime")).toBe(
      false,
    );
  });

  it("detects basic accessibility and responsive layout issues", () => {
    const report = runProjectHealthCheck(
      {
        "index.html":
          '<html><head><title>App</title><meta name="viewport" content="width=device-width"></head></html>',
        "src/App.tsx": [
          "export function App() {",
          '  return <main><img src="/hero.png" /><button><Icon /></button></main>;',
          "}",
        ].join("\n"),
        "src/styles.css": ".shell { width: 1440px; }",
      },
      [],
    );

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "accessibility",
          message: "Image element is missing alt text.",
          path: "src/App.tsx",
        }),
        expect.objectContaining({
          category: "accessibility",
          message:
            "Icon-only or empty button is missing aria-label, aria-labelledby, or title.",
          path: "src/App.tsx",
        }),
        expect.objectContaining({
          category: "responsive",
          path: "src/styles.css",
        }),
      ]),
    );
  });

  it("merges Design-system adherence findings under its own category", () => {
    const report = runProjectHealthCheck(
      {
        "DESIGN.md": "# Legacy contract",
        "index.html":
          '<html><head><title>App</title><meta name="viewport" content="width=device-width"></head></html>',
      },
      [],
      { design: { beforeFiles: {} } },
    );

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "design_system",
          severity: "warning",
        }),
      ]),
    );
  });

  it("truncates large health reports while keeping full issue counts", () => {
    const report = runProjectHealthCheck(
      {
        "index.html":
          '<html><head><title>App</title><meta name="viewport" content="width=device-width"></head></html>',
      },
      Array.from({ length: PROJECT_HEALTH_LIMITS.maxIssues + 10 }, (_, i) => ({
        method: "error",
        data: [`boom ${i}`],
      })),
    );

    expect(report.truncated).toBe(true);
    expect(report.issues).toHaveLength(PROJECT_HEALTH_LIMITS.maxIssues);
    expect(report.summary.totalIssues).toBeGreaterThan(report.issues.length);
  });

  it("safely serializes unusual console values", () => {
    const circular: Record<string, unknown> = { label: "bad" };
    circular.self = circular;

    const report = runProjectHealthCheck(
      {
        "index.html":
          '<html><head><title>App</title><meta name="viewport" content="width=device-width"></head></html>',
      },
      [{ method: "error", data: [circular] }],
    );

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          category: "runtime",
          message: expect.stringContaining("[error]"),
        }),
      ]),
    );
  });
});

describe("createProjectHealthCheckHandler", () => {
  it("serializes health reports as tool output", () => {
    const handler = createProjectHealthCheckHandler({
      getFiles: () => ({ "package.json": "{ invalid" }),
      getConsoleLogs: () => [{ method: "warn", data: ["slow"] }],
    });

    const output = JSON.parse(handler("project_health_check", {}));

    expect(output.ok).toBe(false);
    expect(output.summary.errors).toBeGreaterThan(0);
    expect(output.summary.warnings).toBeGreaterThan(0);
  });

  it("omits live console state in isolated Auto QA runs", () => {
    const handler = createProjectHealthCheckHandler({
      getFiles: () => ({
        "index.html":
          '<html><head><title>App</title><meta name="viewport" content="width=device-width"></head></html>',
      }),
      getConsoleLogs: () => [
        { method: "error", data: ["Authorization: Bearer secret-sentinel"] },
      ],
    });

    const output = handler("project_health_check", { include_console: true }, {
      run: { mode: "auto_qa" },
    } as unknown as NonNullable<Parameters<typeof handler>[2]>);

    expect(output).not.toContain("secret-sentinel");
    expect(JSON.parse(output).issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "runtime" }),
      ]),
    );
  });
});
