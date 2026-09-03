import { describe, expect, it } from "vitest";
import {
  redactSensitiveText,
  sanitizeToolExecutionOutputForHistory,
  sanitizeToolResultForHistory,
  serializeToolArgumentsForHistory,
} from "./message-security";

describe("message security", () => {
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

  it("persists preview evidence metadata without images or element text", () => {
    const sentinel = "private-preview-element-text";
    const generation = "a".repeat(64);
    const imageDigest = "b".repeat(64);
    const structuredContent = {
      kind: "preview_evidence_v1",
      status: "complete",
      generation,
      evidence: [
        {
          view: "mobile",
          image: { mimeType: "image/webp", bytes: 30, digest: imageDigest },
          viewport: {
            name: "mobile",
            width: 375,
            height: 667,
            capturedHeight: 667,
            fullHeight: 667,
            truncated: false,
          },
          semantic: {
            route: "/pricing",
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
            mimeType: "image/webp",
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
      evidence: [{ view: "mobile", image: { digest: imageDigest } }],
    });
    expect(output?.content).toEqual([
      expect.objectContaining({ type: "placeholder" }),
    ]);
    expect(output?.modelOutput).toEqual({
      type: "text",
      value: output?.text,
    });
  });

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
