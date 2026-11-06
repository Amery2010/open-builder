import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewView } from "../../types";
import {
  capturePreviewEvidence,
  isPreviewEvidenceSummary,
  PREVIEW_EVIDENCE_KIND,
} from "./preview-evidence";
import { registerPreviewRuntime } from "./preview-runtime";
import type {
  DesignBridgeCaptureResult,
  PrototypePreviewTarget,
} from "./preview-bridge";

const compression = vi.hoisted(() => ({ run: vi.fn(), dataUrl: vi.fn() }));
vi.mock("browser-image-compression", () => ({
  default: Object.assign(compression.run, {
    getDataUrlFromFile: compression.dataUrl,
  }),
}));
beforeEach(() => {
  compression.run.mockReset().mockImplementation(async (file: File) => file);
  compression.dataUrl.mockReset();
});

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

function capture(
  view: PreviewView,
  target?: PrototypePreviewTarget,
): DesignBridgeCaptureResult {
  const width = view === "desktop" ? 1440 : view === "tablet" ? 768 : 375;
  const height = view === "desktop" ? 900 : view === "tablet" ? 1024 : 667;
  return {
    generation: "replaced-by-test",
    dataUrl: webpDataUrl(width, height),
    mimeType: "image/webp",
    viewport: {
      name: view,
      width,
      height,
      capturedHeight: height,
      fullHeight: height,
      truncated: false,
    },
    semanticSnapshot: {
      route: target?.route ?? "/pricing",
      ...(target ? { prototypeIdentity: target } : {}),
      viewport: { width, height, devicePixelRatio: 1 },
      document: {
        scrollWidth: width,
        scrollHeight: height,
        horizontalOverflow: view === "mobile",
        fonts: "ready",
      },
      elements: [
        {
          tagName: "main",
          text: "private semantic text",
          bounds: { x: 0, y: 0, width, height },
        },
      ],
    },
  };
}

const project = {
  files: { "index.html": "<!doctype html><body></body>" },
  template: "static",
  previewMode: "sandpack" as const,
};

describe("preview evidence tool output", () => {
  it("returns rich ordered evidence with a persistable metadata summary", async () => {
    let currentGeneration: string | undefined;
    unregisters.push(
      registerPreviewRuntime("conversation-a", {
        getGeneration: () => currentGeneration,
        prepare: async (generation) => {
          currentGeneration = generation;
        },
        capture: async (viewports, generation) => ({
          generation,
          captures: viewports.map((view) => ({
            ...capture(view),
            generation,
          })),
          errors: ["tablet: font timed out"],
        }),
      }),
    );

    const output = await capturePreviewEvidence({
      conversationId: "conversation-a",
      ...project,
      viewports: ["mobile", "desktop"],
    });
    expect(output.isError).toBeUndefined();
    expect(output.content?.map((part) => part.type)).toEqual([
      "text",
      "image",
      "image",
    ]);
    expect(output.modelOutput).toMatchObject({ type: "content" });
    expect(output.structuredContent).toMatchObject({
      kind: PREVIEW_EVIDENCE_KIND,
      status: "partial",
      evidence: [
        { view: "mobile", semantic: { elementCount: 1 } },
        { view: "desktop", semantic: { elementCount: 1 } },
      ],
    });
    expect(output.text).not.toContain("private semantic text");
    expect(output.text).not.toContain("data:image");
    expect(compression.run).toHaveBeenCalledTimes(2);
  });

  it("summarizes and sends the compressed bytes using their actual MIME", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const base64 = Buffer.from(bytes).toString("base64");
    compression.run.mockResolvedValue(
      new File([bytes], "compressed", { type: "image/webp" }),
    );
    compression.dataUrl.mockResolvedValue(`data:image/webp;base64,${base64}`);
    let generation: string | undefined;
    unregisters.push(
      registerPreviewRuntime("compressed", {
        getGeneration: () => generation,
        prepare: async (value) => {
          generation = value;
        },
        capture: async (_views, value) => ({
          generation: value,
          captures: [{ ...capture("desktop"), generation: value }],
          errors: [],
        }),
      }),
    );
    const output = await capturePreviewEvidence({
      conversationId: "compressed",
      ...project,
      viewports: ["desktop"],
    });
    expect(output.content?.[1]).toEqual({
      type: "image",
      data: base64,
      mimeType: "image/png",
    });
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    expect(output.structuredContent).toMatchObject({
      evidence: [
        { image: { mimeType: "image/png", bytes: bytes.length, digest } },
      ],
    });
  });

  it("returns explicit unavailable and validation errors", async () => {
    const unavailable = await capturePreviewEvidence({
      conversationId: "conversation-a",
      ...project,
      previewMode: "code-only",
      viewports: ["desktop"],
    });
    expect(unavailable).toMatchObject({ isError: true });
    expect(unavailable.structuredContent).toMatchObject({
      errorCode: "unavailable",
    });

    await expect(
      capturePreviewEvidence({
        conversationId: "conversation-a",
        ...project,
        viewports: ["mobile", "mobile"],
      }),
    ).rejects.toThrow("Duplicate preview viewport");
  });

  it("persists the requested page and scenario with every capture", async () => {
    const target: PrototypePreviewTarget = {
      pageId: "dashboard",
      route: "#/dashboard",
      scenarioId: "populated",
    };
    let currentGeneration: string | undefined;
    unregisters.push(
      registerPreviewRuntime("conversation-target", {
        getGeneration: () => currentGeneration,
        prepare: async (generation) => {
          currentGeneration = generation;
        },
        capture: async (viewports, generation, _signal, requestedTarget) => ({
          generation,
          target: requestedTarget,
          captures: viewports.map((view) => ({
            ...capture(view, requestedTarget),
            generation,
          })),
          errors: [],
        }),
      }),
    );

    const output = await capturePreviewEvidence({
      conversationId: "conversation-target",
      ...project,
      target,
      viewports: ["desktop"],
    });
    expect(output.structuredContent).toMatchObject({
      kind: PREVIEW_EVIDENCE_KIND,
      target,
      evidence: [
        {
          semantic: {
            route: target.route,
            prototypeIdentity: target,
          },
        },
      ],
    });
    expect(isPreviewEvidenceSummary(output.structuredContent)).toBe(true);
    expect(output.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"prototypeIdentity"'),
    });
  });

  it("returns a target identity error when an adapter reports another scenario", async () => {
    const target: PrototypePreviewTarget = {
      pageId: "dashboard",
      route: "#/dashboard",
      scenarioId: "populated",
    };
    const mismatched = { ...target, scenarioId: "empty" };
    let currentGeneration: string | undefined;
    unregisters.push(
      registerPreviewRuntime("conversation-mismatch", {
        getGeneration: () => currentGeneration,
        prepare: async (generation) => {
          currentGeneration = generation;
        },
        capture: async (viewports, generation) => ({
          generation,
          captures: viewports.map((view) => capture(view, mismatched)),
          errors: [],
        }),
      }),
    );
    const output = await capturePreviewEvidence({
      conversationId: "conversation-mismatch",
      ...project,
      target,
      viewports: ["desktop"],
    });
    expect(output).toMatchObject({
      isError: true,
      structuredContent: { errorCode: "target_identity_mismatch", target },
    });
  });

  it("rejects inconsistent persisted evidence metadata", () => {
    const base = {
      kind: PREVIEW_EVIDENCE_KIND,
      status: "complete",
      generation: "a".repeat(64),
      evidence: [
        {
          view: "mobile",
          image: {
            mimeType: "image/webp",
            bytes: 30,
            digest: "b".repeat(64),
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
            route: "/",
            horizontalOverflow: false,
            fonts: "ready",
            elementCount: 1,
          },
        },
      ],
      errors: [],
      placeholder: "run only",
    };
    expect(isPreviewEvidenceSummary(base)).toBe(true);
    for (const mimeType of ["image/png", "image/jpeg"]) {
      expect(
        isPreviewEvidenceSummary({
          ...base,
          evidence: [
            {
              ...base.evidence[0],
              image: { ...base.evidence[0].image, mimeType },
            },
          ],
        }),
      ).toBe(true);
    }
    expect(
      isPreviewEvidenceSummary({
        ...base,
        evidence: [
          {
            ...base.evidence[0],
            viewport: {
              ...base.evidence[0].viewport,
              width: 390,
              height: 844,
              capturedHeight: 844,
              fullHeight: 844,
            },
          },
        ],
      }),
    ).toBe(true);
    expect(
      isPreviewEvidenceSummary({
        ...base,
        evidence: [
          {
            ...base.evidence[0],
            viewport: { ...base.evidence[0].viewport, width: 1440 },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isPreviewEvidenceSummary({
        ...base,
        evidence: [
          {
            ...base.evidence[0],
            viewport: {
              ...base.evidence[0].viewport,
              fullHeight: 900,
              truncated: false,
            },
          },
        ],
      }),
    ).toBe(false);
    expect(isPreviewEvidenceSummary({ ...base, status: "partial" })).toBe(
      false,
    );
    expect(
      isPreviewEvidenceSummary({
        ...base,
        target: {
          pageId: "home",
          route: "#/home",
          scenarioId: "default",
        },
      }),
    ).toBe(false);
    expect(
      isPreviewEvidenceSummary({
        ...base,
        evidence: [
          {
            ...base.evidence[0],
            semantic: {
              ...base.evidence[0].semantic,
              prototypeIdentity: {
                pageId: "home",
                route: "#/home",
                scenarioId: "default",
              },
              route: "#/home",
            },
          },
        ],
      }),
    ).toBe(true);
  });
});
