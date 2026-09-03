import { afterEach, describe, expect, it } from "vitest";
import type {
  ConversationDesignState,
  PreviewView,
  ProjectFiles,
} from "../../types";
import type { Message } from "../ai/generator-types";
import {
  executeDesignDiagnostic,
  type DesignDiagnosticContext,
} from "./diagnostics";
import type {
  DesignBridgeCaptureResult,
  DesignPreviewSemanticElement,
} from "./preview-bridge";
import { registerPreviewRuntime } from "./preview-runtime";
import type { PreviewEvidenceSummary } from "./preview-evidence";
import type { DesignContract } from "./run-contract";

const digest = "a".repeat(64);
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
const contract: DesignContract = {
  surface_mode: "operate",
  change_mode: "extend",
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
const tokenCss = `/* package sha256 ${digest} */
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
const files: ProjectFiles = {
  "DESIGN.md": `<!-- package sha256 ${digest} -->\n# Graphite`,
  "tokens.css": tokenCss,
  "index.html":
    '<html lang="en"><head><title>App</title></head><body><main id="root"></main></body></html>',
  "src/main.tsx": "import '../tokens.css'; import './app.css';",
  "src/app.css":
    ".shell { color: var(--fg); background: var(--bg); border-radius: var(--radius-md); }",
};

const unregisters: Array<() => void> = [];
afterEach(() => {
  while (unregisters.length) unregisters.pop()?.();
});

function webpDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(30);
  const write = (offset: number, value: string) => {
    for (const [index, character] of Array.from(value).entries()) {
      bytes[offset + index] = character.charCodeAt(0);
    }
  };
  write(0, "RIFF");
  write(8, "WEBP");
  write(12, "VP8X");
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return `data:image/webp;base64,${btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
  )}`;
}

function dimensions(view: PreviewView) {
  return view === "desktop"
    ? { width: 1440, height: 900 }
    : view === "tablet"
      ? { width: 768, height: 1024 }
      : { width: 375, height: 667 };
}

function capture(
  view: PreviewView,
  generation: string,
  elements: DesignPreviewSemanticElement[] = [],
): DesignBridgeCaptureResult {
  const { width, height } = dimensions(view);
  return {
    generation,
    dataUrl: webpDataUrl(width, height),
    mimeType: "image/webp",
    viewport: {
      name: view,
      width,
      height,
      capturedHeight: height,
      fullHeight: height + (view === "mobile" ? 200 : 0),
      truncated: view === "mobile",
    },
    semanticSnapshot: {
      route: "/dashboard",
      title: "Dashboard",
      viewport: { width, height, devicePixelRatio: 1 },
      document: {
        scrollWidth: view === "mobile" ? width + 20 : width,
        scrollHeight: height + 200,
        horizontalOverflow: view === "mobile",
        fonts: "ready",
        language: "en",
      },
      designTokens: {
        computed: {
          "--bg": view === "mobile" ? "#000000" : "#ffffff",
        },
        inline: {},
      },
      elements,
    },
  };
}

function context(overrides: Partial<DesignDiagnosticContext> = {}) {
  return {
    conversationId: "conversation-a",
    files,
    beforeFiles: files,
    template: "static",
    previewMode: "sandpack" as const,
    designState,
    contract,
    ...overrides,
  };
}

function registerRuntime(elements: DesignPreviewSemanticElement[] = []) {
  let currentGeneration: string | undefined;
  unregisters.push(
    registerPreviewRuntime("conversation-a", {
      getGeneration: () => currentGeneration,
      prepare: async (generation) => {
        currentGeneration = generation;
      },
      capture: async (viewports, generation) => ({
        generation,
        captures: viewports.map((view) => capture(view, generation, elements)),
        errors: [],
      }),
    }),
  );
}

describe("Design diagnostics", () => {
  it("traces current Design-system and Token usage provenance", async () => {
    const result = await executeDesignDiagnostic(
      "trace_design_provenance",
      {},
      context({ files: { ...files, ".env": "SECRET=var(--fg)" } }),
    );

    expect(result.structuredContent).toMatchObject({
      kind: "design_provenance_v1",
      designSystem: {
        applied: { id: "graphite", digest },
        files: {
          designDigestMarkerMatches: true,
          tokenDigestMarkerMatches: true,
        },
      },
      tokenContract: { status: "ready", path: "tokens.css" },
      acceptedRunContract: {
        surfaceMode: "operate",
        changeMode: "extend",
      },
    });
    const tokens = (
      result.structuredContent as {
        tokens: Array<{
          token: string;
          usage: { sites: Array<{ path: string }> };
        }>;
      }
    ).tokens;
    expect(tokens.find((token) => token.token === "--fg")?.usage.sites).toEqual(
      expect.arrayContaining([{ path: "src/app.css", occurrences: 1 }]),
    );
    expect(JSON.stringify(tokens)).not.toContain(".env");
  });

  it("combines static adherence with runtime Token and style evidence", async () => {
    registerRuntime([
      {
        tagName: "button",
        role: "button",
        name: "Save",
        bounds: { x: 10, y: 10, width: 100, height: 44 },
        styles: { color: "rgb(0, 0, 0)", fontSize: "16px" },
        accessibility: {
          interactive: true,
          focusable: true,
          disabled: false,
          tabIndex: 0,
          nameSource: "text",
        },
      },
    ]);

    const result = await executeDesignDiagnostic(
      "inspect_design_consistency",
      { viewports: ["mobile"] },
      context(),
    );

    expect(result.structuredContent).toMatchObject({
      kind: "design_consistency_v1",
      status: "complete",
      runtime: {
        coverage: "complete",
        capturedViewports: ["mobile"],
        componentVariants: [expect.objectContaining({ family: "button" })],
      },
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "runtime_token_mismatch" }),
      ]),
    });
  });

  it("reports bounded layout and accessibility evidence without raw text", async () => {
    registerRuntime([
      {
        tagName: "main",
        bounds: { x: 0, y: 0, width: 375, height: 700 },
      },
      {
        tagName: "h1",
        name: "Private heading text",
        bounds: { x: 0, y: 10, width: 300, height: 40 },
      },
      {
        tagName: "h3",
        name: "Private skipped heading",
        bounds: { x: 0, y: 60, width: 300, height: 30 },
      },
      {
        tagName: "button",
        bounds: { x: 360, y: 100, width: 20, height: 20 },
        accessibility: {
          interactive: true,
          focusable: false,
          disabled: false,
          tabIndex: -1,
          nameSource: "none",
        },
      },
      {
        tagName: "img",
        bounds: { x: 0, y: 150, width: 80, height: 80 },
        accessibility: {
          interactive: false,
          focusable: false,
          disabled: false,
          tabIndex: -1,
          nameSource: "none",
          imageAlt: "missing",
        },
      },
    ]);

    const layout = await executeDesignDiagnostic(
      "measure_preview_layout",
      { viewports: ["mobile"] },
      context(),
    );
    expect(layout.structuredContent).toMatchObject({
      kind: "preview_layout_measurement_v1",
      status: "complete",
      reports: [
        {
          view: "mobile",
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "document_horizontal_overflow" }),
            expect.objectContaining({
              code: "sampled_element_outside_viewport",
            }),
            expect.objectContaining({ code: "sampled_control_target_small" }),
          ]),
        },
      ],
    });

    const accessibility = await executeDesignDiagnostic(
      "audit_accessibility_tree",
      { viewports: ["mobile"] },
      context(),
    );
    expect(accessibility.structuredContent).toMatchObject({
      kind: "preview_accessibility_audit_v1",
      conformance: "not_assessed",
      reports: [
        {
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "heading_level_skipped" }),
            expect.objectContaining({ code: "interactive_name_missing" }),
            expect.objectContaining({ code: "keyboard_unreachable" }),
            expect.objectContaining({ code: "image_alt_missing" }),
          ]),
        },
      ],
    });
    expect(accessibility.text).not.toContain("Private heading text");
    expect(accessibility.text).not.toContain("data:image");
  });

  it("compares current evidence with a persisted Conversation baseline", async () => {
    registerRuntime();
    const baseline: PreviewEvidenceSummary = {
      kind: "preview_evidence_v1",
      status: "complete",
      generation: "b".repeat(64),
      evidence: [
        {
          view: "mobile",
          image: {
            mimeType: "image/webp",
            bytes: 30,
            digest: "c".repeat(64),
          },
          viewport: {
            name: "mobile",
            width: 375,
            height: 667,
            capturedHeight: 667,
            fullHeight: 667,
            truncated: false,
          },
          semantic: {
            route: "/before",
            horizontalOverflow: false,
            fonts: "ready",
            elementCount: 0,
          },
        },
      ],
      errors: [],
      placeholder: "run only",
    };
    const history: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "baseline-call",
            type: "function",
            function: {
              name: "capture_preview_evidence",
              arguments: '{"viewports":["mobile"]}',
            },
          },
        ],
      },
      {
        role: "tool",
        content: JSON.stringify(baseline),
        tool_call_id: "baseline-call",
        toolOutput: {
          text: JSON.stringify(baseline),
          structuredContent: baseline,
        },
      },
    ];

    const result = await executeDesignDiagnostic(
      "compare_preview_states",
      { viewports: ["mobile"] },
      context({ history }),
    );

    expect(result.structuredContent).toMatchObject({
      kind: "preview_comparison_v1",
      status: "changed",
      baselineGeneration: baseline.generation,
      comparisons: [
        {
          view: "mobile",
          status: "changed",
          changes: {
            imageDigestChanged: true,
            horizontalOverflowChanged: true,
          },
        },
      ],
    });
    expect(result.text).not.toContain("data:image");
  });

  it("keeps static consistency available while runtime diagnostics fail closed", async () => {
    const codeOnly = context({ previewMode: "code-only" });
    const consistency = await executeDesignDiagnostic(
      "inspect_design_consistency",
      {},
      codeOnly,
    );
    expect(consistency.isError).toBeUndefined();
    expect(consistency.structuredContent).toMatchObject({
      runtime: { coverage: "not_requested" },
    });

    const layout = await executeDesignDiagnostic(
      "measure_preview_layout",
      { viewports: ["desktop"] },
      codeOnly,
    );
    expect(layout).toMatchObject({ isError: true });
    expect(layout.structuredContent).toMatchObject({
      status: "error",
      errorCode: "unavailable",
    });
  });
});
