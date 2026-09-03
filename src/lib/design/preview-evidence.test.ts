import { afterEach, describe, expect, it } from "vitest";
import type { PreviewView } from "../../types";
import {
  capturePreviewEvidence,
  isPreviewEvidenceSummary,
  PREVIEW_EVIDENCE_KIND,
} from "./preview-evidence";
import { registerPreviewRuntime } from "./preview-runtime";
import type { DesignBridgeCaptureResult } from "./preview-bridge";

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

function capture(view: PreviewView): DesignBridgeCaptureResult {
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
      route: "/pricing",
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
    expect(
      isPreviewEvidenceSummary({
        ...base,
        evidence: [
          {
            ...base.evidence[0],
            viewport: { ...base.evidence[0].viewport, width: 390 },
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
  });
});
