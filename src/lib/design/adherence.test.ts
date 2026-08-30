import { describe, expect, it } from "vitest";
import type { ConversationDesignState, ProjectFiles } from "../../types";
import type { DesignContract } from "./run-contract";
import { runDesignSystemAdherenceCheck } from "./adherence";

const digest = "a".repeat(64);
const tokens = `/* package sha256 ${digest} */
:root {
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

const reference = {
  id: "graphite",
  name: "Graphite",
  source: "builtin" as const,
  version: "2.0.0",
  digest,
};

const designState: ConversationDesignState = {
  selectedSystem: reference,
  appliedSystem: reference,
};

function contract(
  change_mode: "create" | "extend" | "migrate",
): DesignContract {
  return {
    surface_mode: "operate",
    change_mode,
    target: "Application shell",
    audience: "Operators",
    primary_goal: "Complete the primary task",
    concept: "A precise operations bench",
    system_id: "graphite",
    translation: {
      foundations: "Semantic roles",
      composition: "Clear hierarchy",
      components: "Shared controls",
    },
    preserve: ["Routes and behavior"],
    acceptance: ["Runtime Token consumption"],
  };
}

function project(appCss: string, importTokens = true): ProjectFiles {
  return {
    "DESIGN.md": `<!-- package sha256 ${digest} -->\n# Graphite`,
    "tokens.css": tokens,
    "index.html":
      '<html><head><title>App</title><meta name="viewport" content="width=device-width"></head><body><div id="root"></div></body></html>',
    "src/main.tsx": `${importTokens ? "import '../tokens.css';\n" : ""}import './app.css';`,
    "src/app.css": appCss,
  };
}

const completeConsumption = `
body {
  color: var(--fg);
  background: var(--bg);
  font-family: var(--font-body);
}
.shell {
  border-radius: var(--radius-md);
  max-width: var(--container-max);
  padding-block: var(--section-y-desktop);
  transition: color var(--motion-base) ease;
}`;

describe("Design-system adherence", () => {
  it("reports missing runtime Token wiring and zero semantic consumption", () => {
    const report = runDesignSystemAdherenceCheck({
      files: project(".shell { display: grid; }", false),
      designState,
      contract: contract("create"),
      beforeFiles: {},
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "tokens_not_loaded" }),
        expect.objectContaining({
          code: "semantic_group_unused",
          message: expect.stringContaining("color"),
        }),
        expect.objectContaining({
          code: "semantic_group_unused",
          message: expect.stringContaining("typography"),
        }),
        expect.objectContaining({
          code: "semantic_group_unused",
          message: expect.stringContaining("shape"),
        }),
        expect.objectContaining({
          code: "semantic_group_unused",
          message: expect.stringContaining("layout"),
        }),
      ]),
    );
  });

  it("accepts complete create/migrate semantic consumption", () => {
    const files = project(completeConsumption);
    const report = runDesignSystemAdherenceCheck({
      files,
      beforeFiles: files,
      designState,
      contract: contract("migrate"),
    });

    expect(report.issues).toEqual([]);
    expect(report.tokenUsage).toMatchObject({
      color: expect.arrayContaining(["--bg", "--fg"]),
      typography: ["--font-body"],
      shape: ["--radius-md"],
      layout: expect.arrayContaining([
        "--section-y-desktop",
        "--container-max",
      ]),
    });
  });

  it("warns only for newly introduced literal drift in changed UI files", () => {
    const before = project(completeConsumption);
    before["src/legacy.css"] = ".old { color: #ff0000; }";
    const files = {
      ...before,
      "src/app.css": `${completeConsumption}\n.new { color: #123456; border-radius: 18px; }`,
    };
    const report = runDesignSystemAdherenceCheck({
      files,
      beforeFiles: before,
      changedPaths: ["src/app.css"],
      designState,
      contract: contract("extend"),
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "literal_drift",
          path: "src/app.css",
        }),
      ]),
    );
    expect(report.issues.some((issue) => issue.path === "src/legacy.css")).toBe(
      false,
    );
  });

  it("allows Tailwind semantic-variable forms and flags fixed visual classes", () => {
    const before = project(completeConsumption);
    const semantic = {
      ...before,
      "src/App.tsx":
        '<div className="bg-[var(--surface)] rounded-[var(--radius-md)] md:rounded-(--radius-md) duration-[var(--motion-base)]" />',
      "src/new.css":
        ".semantic { font-family: var(--font-body); border-radius: var(--radius-md); }",
    };
    const semanticReport = runDesignSystemAdherenceCheck({
      files: semantic,
      beforeFiles: before,
      changedPaths: ["src/App.tsx", "src/new.css"],
      designState,
      contract: contract("extend"),
    });
    expect(
      semanticReport.issues.some((issue) => issue.code === "tailwind_drift"),
    ).toBe(false);
    expect(
      semanticReport.issues.some((issue) => issue.code === "literal_drift"),
    ).toBe(false);

    const fixed = {
      ...before,
      "src/App.tsx":
        '<div className="bg-zinc-900 rounded-xl duration-300" style={{ fontFamily: "Comic Sans", borderRadius: 18 }} />',
    };
    expect(
      runDesignSystemAdherenceCheck({
        files: fixed,
        beforeFiles: before,
        changedPaths: ["src/App.tsx"],
        designState,
        contract: contract("extend"),
      }).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "tailwind_drift" }),
        expect.objectContaining({ code: "literal_drift" }),
      ]),
    );
  });

  it("validates sanitized runtime Token values per viewport", () => {
    const files = project(completeConsumption);
    const computed = Object.fromEntries(
      Object.entries({
        "--bg": "#ffffff",
        "--surface": "#f4f4f5",
        "--fg": "#18181b",
        "--muted": "#71717a",
        "--border": "#d4d4d8",
        "--accent": "#6d28d9",
        "--accent-on": "#ffffff",
        "--font-display": "ui-sans-serif",
        "--font-body": "ui-sans-serif",
        "--radius-md": "0.75rem",
        "--section-y-desktop": "6rem",
        "--container-max": "72rem",
        "--motion-base": "180ms",
      }),
    );
    const snapshot = {
      route: "/",
      viewport: { width: 375, height: 667, devicePixelRatio: 2 },
      document: {
        scrollWidth: 375,
        scrollHeight: 667,
        horizontalOverflow: false,
        fonts: "ready" as const,
      },
      designTokens: {
        computed: { ...computed },
        inline: {} as Record<string, string>,
      },
      elements: [],
    };
    expect(
      runDesignSystemAdherenceCheck({
        files,
        beforeFiles: files,
        designState,
        contract: contract("migrate"),
        runtimeSnapshots: [snapshot],
      }).issues,
    ).toEqual([]);

    delete snapshot.designTokens.computed["--bg"];
    snapshot.designTokens.inline["--accent"] = "#000000";
    expect(
      runDesignSystemAdherenceCheck({
        files,
        beforeFiles: files,
        designState,
        contract: contract("migrate"),
        runtimeSnapshots: [snapshot],
      }).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "runtime_token_missing" }),
        expect.objectContaining({ code: "runtime_root_override" }),
      ]),
    );
  });

  it("reports state and digest inconsistencies", () => {
    const files = project(completeConsumption);
    files["DESIGN.md"] = "# digest removed";
    const report = runDesignSystemAdherenceCheck({
      files,
      beforeFiles: files,
      designState: {
        ...designState,
        selectedSystem: { ...reference, id: "other" },
      },
      contract: contract("extend"),
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "state_mismatch" }),
        expect.objectContaining({ code: "digest_mismatch", path: "DESIGN.md" }),
      ]),
    );
  });

  it("rejects selected-but-unapplied package state in an initialized project", () => {
    const report = runDesignSystemAdherenceCheck({
      files: { "src/App.tsx": "export function App() { return null; }" },
      designState: { selectedSystem: reference },
      beforeFiles: {},
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "state_mismatch",
          message: expect.stringContaining("selected-but-unapplied"),
        }),
      ]),
    );
  });
});
