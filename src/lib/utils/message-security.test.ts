import { describe, expect, it } from "vitest";
import {
  redactSensitiveText,
  sanitizeToolExecutionOutputForHistory,
  sanitizeToolResultForHistory,
  serializeToolArgumentsForHistory,
} from "./message-security";

describe("message security", () => {
  it("retains validated long-page geometry and excludes untrusted capture fields", () => {
    const structuredContent = {
      kind: "preview_evidence_v1",
      status: "complete",
      generation: "a".repeat(64),
      errors: [],
      evidence: [
        {
          view: "desktop",
          image: {
            mimeType: "image/png",
            bytes: 100,
            digest: "b".repeat(64),
            width: 576,
            height: 4000,
          },
          viewport: {
            name: "desktop",
            width: 1440,
            height: 900,
            capturedHeight: 10000,
            fullHeight: 10000,
            truncated: false,
          },
          capture: {
            scope: "full-page",
            region: {
              x: 0,
              y: 0,
              width: 1440,
              height: 10000,
              dataUrl: "private-image",
            },
            scale: 0.4,
            dataUrl: "private-image",
          },
          semantic: {
            route: "/",
            horizontalOverflow: false,
            fonts: "ready",
            elementCount: 0,
          },
        },
      ],
    };
    const output = sanitizeToolExecutionOutputForHistory(
      "capture_preview_evidence",
      {},
      { text: JSON.stringify(structuredContent), structuredContent },
    );
    expect(output?.structuredContent).toMatchObject({
      evidence: [
        {
          capture: {
            scope: "full-page",
            region: { height: 10000 },
            scale: 0.4,
          },
          image: { width: 576, height: 4000 },
          viewport: { capturedHeight: 10000 },
        },
      ],
    });
    expect(JSON.stringify(output)).not.toContain("private-image");
    structuredContent.evidence[0].capture.region.width = 1200;
    structuredContent.evidence[0].image.width = 480;
    const cropped = sanitizeToolExecutionOutputForHistory(
      "capture_preview_evidence",
      {},
      { text: JSON.stringify(structuredContent), structuredContent },
    );
    expect(cropped?.structuredContent).toMatchObject({ evidence: [] });
    structuredContent.evidence[0].capture.region.width = 1440;
    structuredContent.evidence[0].image.width = 576;
    structuredContent.evidence[0].image.height = 3999;
    const malformed = sanitizeToolExecutionOutputForHistory(
      "capture_preview_evidence",
      {},
      { text: JSON.stringify(structuredContent), structuredContent },
    );
    expect(malformed?.structuredContent).toMatchObject({ evidence: [] });
  });
  it("redacts common credential forms without retaining their values", () => {
    const sentinel = "sentinel-secret-value";
    const text = redactSensitiveText(
      `Authorization: Bearer ${sentinel}\nhttps://example.com?q=1&token=${sentinel}\nAPI_TOKEN=${sentinel}`,
    );

    expect(text).not.toContain(sentinel);
    expect(text).toContain("[REDACTED]");
  });

  it("persists manage_env operations without values", () => {
    const sentinel = "sentinel-secret-value";
    const serialized = serializeToolArgumentsForHistory("manage_env", {
      operations: [
        { target: "env", action: "set", key: "TOKEN", value: sentinel },
      ],
    });

    expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain("[REDACTED]");
  });

  it("persists only a bounded project blueprint argument summary", () => {
    const serialized = serializeToolArgumentsForHistory(
      "update_project_design",
      {
        expected_revision: 3,
        document: {
          schemaVersion: "open-builder-design-project/v1",
          revision: 4,
          productGoal: "A very detailed product goal that should not persist",
          pages: [{ id: "dashboard" }],
          flows: [{ id: "onboarding" }],
          scenarios: [{ id: "default" }, { id: "empty" }],
        },
      },
    );

    expect(serialized).not.toContain("very detailed product goal");
    expect(JSON.parse(serialized)).toEqual({
      expected_revision: 3,
      document: {
        schemaVersion: "open-builder-design-project/v1",
        revision: 4,
        pageCount: 1,
        flowCount: 1,
      },
    });
  });

  it("does not report omitted blueprint patch collections as empty", () => {
    const serialized = serializeToolArgumentsForHistory(
      "update_project_design",
      {
        expected_revision: 3,
        document: { revision: 4, buildProgress: { percent: 20 } },
      },
    );
    expect(JSON.parse(serialized)).toEqual({
      expected_revision: 3,
      document: { revision: 4 },
    });
  });

  it("summarizes incremental blueprint patches without retaining private product details", () => {
    const result = serializeToolArgumentsForHistory("update_project_design", {
      patch: {
        productGoal: "Private product details",
        pages: [{ id: "home" }],
      },
    });
    expect(JSON.parse(result)).toEqual({ patch: { pageCount: 1 } });
    expect(result).not.toContain("Private product details");
  });

  it("omits legacy reads of protected project files", () => {
    const sentinel = "sentinel-secret-value";
    const result = sanitizeToolResultForHistory(
      "read_files",
      JSON.stringify({ paths: [".env"] }),
      `TOKEN=${sentinel}`,
    );

    expect(result).not.toContain(sentinel);
    expect(result).toContain("Protected tool result omitted");
  });

  it("redacts ask-user answers in text, structured content, and model output", () => {
    const sentinel = "ask-user-secret-sentinel";
    const output = sanitizeToolExecutionOutputForHistory(
      "ask_user_question",
      {},
      {
        text: `Q1 [Token] Value?\n→ API_TOKEN=${sentinel}`,
        structuredContent: {
          kind: "ask_user_answers_v1",
          selections: [[`API_TOKEN=${sentinel}`]],
        },
        modelOutput: {
          type: "text",
          value: `API_TOKEN=${sentinel}`,
        },
      },
    );

    expect(JSON.stringify(output)).not.toContain(sentinel);
    expect(output?.text).toContain("[REDACTED]");
    expect(output?.structuredContent).toEqual({
      kind: "ask_user_answers_v1",
      selections: [["API_TOKEN=[REDACTED]"]],
    });
    expect(output?.modelOutput).toEqual({
      type: "text",
      value: output?.text,
    });
  });

  it.each(["image/webp", "image/png", "image/jpeg"])(
    "persists %s preview evidence metadata without images or element text",
    (mimeType) => {
      const sentinel = "private-preview-element-text";
      const route = "#/pricing?scenario=default&filter=" + "a".repeat(500);
      const generation = "a".repeat(64);
      const imageDigest = "b".repeat(64);
      const structuredContent = {
        kind: "preview_evidence_v1",
        status: "complete",
        generation,
        target: {
          pageId: "pricing",
          route,
        },
        evidence: [
          {
            view: "mobile",
            image: { mimeType, bytes: 30, digest: imageDigest },
            viewport: {
              name: "mobile",
              width: 390,
              height: 844,
              capturedHeight: 844,
              fullHeight: 844,
              truncated: false,
            },
            semantic: {
              route,
              prototypeIdentity: {
                pageId: "pricing",
                route,
              },
              horizontalOverflow: false,
              fonts: "ready",
              elementCount: 12,
            },
          },
        ],
        errors: [],
        placeholder: "untrusted placeholder",
      };
      const output = sanitizeToolExecutionOutputForHistory(
        "capture_preview_evidence",
        {},
        {
          text: JSON.stringify(structuredContent),
          structuredContent,
          content: [
            { type: "text", text: sentinel },
            {
              type: "image",
              data: "base64-image-sentinel",
              mimeType,
            },
          ],
          modelOutput: {
            type: "content",
            value: [{ type: "text", text: sentinel }],
          },
        },
      );

      expect(JSON.stringify(output)).not.toContain(sentinel);
      expect(JSON.stringify(output)).not.toContain("base64-image-sentinel");
      expect(output?.structuredContent).toMatchObject({
        kind: "preview_evidence_v1",
        generation,
        target: { pageId: "pricing", route },
        evidence: [
          {
            view: "mobile",
            image: { mimeType, digest: imageDigest },
            viewport: { width: 390, height: 844 },
            semantic: {
              route,
              prototypeIdentity: { pageId: "pricing", route },
            },
          },
        ],
      });
      expect(output?.content).toEqual([
        expect.objectContaining({ type: "placeholder" }),
      ]);
      expect(output?.modelOutput).toEqual({
        type: "text",
        value: output?.text,
      });
    },
  );

  it("bounds generic summary-only output and drops rich blocks", () => {
    const output = sanitizeToolExecutionOutputForHistory(
      "update_design_tokens",
      {},
      {
        text: "x".repeat(8_000),
        retention: "summary-only",
        structuredContent: { private: "full result" },
        content: [{ type: "text", text: "full result" }],
      },
    );

    expect(output?.text.length).toBeLessThan(4_200);
    expect(output?.text).toContain("[summary truncated]");
    expect(output?.structuredContent).toBeUndefined();
    expect(output?.content).toBeUndefined();
    expect(output?.modelOutput).toEqual({
      type: "text",
      value: output?.text,
    });
  });
});

describe("preview sequence retention", () => {
  it("keeps timing and errors while stripping pixels and arbitrary embedded state", () => {
    const output = sanitizeToolExecutionOutputForHistory(
      "capture_preview_sequence",
      {},
      {
        text: "raw",
        structuredContent: {
          kind: "preview_sequence_v1",
          generation: "a".repeat(64),
          status: "partial",
          frames: [
            {
              scheduledAtMs: 0,
              startedAtMs: 12,
              durationMs: 23,
              error: "Frame failed",
              dataUrl: "secret pixels",
              dom: "private form state",
            },
          ],
          errors: ["Stopped"],
          arbitrary: "private state",
        },
        content: [{ type: "image", mimeType: "image/png", data: "pixels" }],
        modelOutput: {
          type: "content",
          value: [
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "data", data: "pixels" },
            },
          ],
        },
      },
    );
    expect(output?.structuredContent).toMatchObject({
      frames: [
        {
          scheduledAtMs: 0,
          startedAtMs: 12,
          durationMs: 23,
          error: "Frame failed",
        },
      ],
      errors: ["Stopped"],
    });
    expect(JSON.stringify(output)).not.toMatch(/pixels|private|dataUrl/);
    expect(output?.modelOutput?.type).toBe("text");
  });
});
