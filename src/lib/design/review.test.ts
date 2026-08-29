import { describe, expect, it, vi } from "vitest";
import {
  buildDesignReviewRequirementsContext,
  buildDesignReviewSemanticContext,
  createSubmitDesignReviewHandler,
  designReviewReportSchema,
  getDesignReviewScreenshotByteLength,
  validateDesignReviewScreenshots,
} from "./review";

const finding = {
  id: "contrast-primary-action",
  priority: "P1" as const,
  dimension: "accessibility" as const,
  title: "Primary action lacks contrast",
  evidence: "The mobile screenshot shows low-contrast text on the accent.",
  recommendation: "Use --accent-on for the button label.",
};

describe("structured Design Review", () => {
  const pngDataUrl = `data:image/png;base64,${btoa(
    String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10),
  )}`;

  it("accepts only the fixed dimensions and at most eight findings", () => {
    expect(
      designReviewReportSchema.safeParse({
        overview: "Focused review",
        findings: [finding],
      }).success,
    ).toBe(true);
    expect(
      designReviewReportSchema.safeParse({
        overview: "Too many",
        findings: Array.from({ length: 9 }, (_, index) => ({
          ...finding,
          id: `finding-${index}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      designReviewReportSchema.safeParse({
        overview: "Wrong dimension",
        findings: [{ ...finding, dimension: "performance" }],
      }).success,
    ).toBe(false);
    expect(
      designReviewReportSchema.safeParse({
        overview: "Duplicate ids",
        findings: [finding, { ...finding }],
      }).success,
    ).toBe(false);
  });

  it("records a valid report without exposing a write path", async () => {
    const onSubmit = vi.fn();
    const handler = createSubmitDesignReviewHandler(onSubmit);
    const result = JSON.parse(
      await handler("submit_design_review", {
        overview: "Focused review",
        findings: [finding],
      }),
    );
    expect(result).toEqual({
      ok: true,
      findingCount: 1,
      note: "Structured Design review recorded. Do not modify project files.",
    });
    expect(onSubmit).toHaveBeenCalledWith({
      overview: "Focused review",
      findings: [finding],
    });
  });

  it("bounds and validates screenshot data before model submission", () => {
    expect(() =>
      validateDesignReviewScreenshots([
        {
          dataUrl: pngDataUrl,
        },
      ]),
    ).not.toThrow();
    expect(() =>
      validateDesignReviewScreenshots([
        { dataUrl: "data:text/html;base64,PHNjcmlwdD4=" },
      ]),
    ).toThrow(/invalid screenshot payload/i);
  });

  it("calculates PNG, JPEG, and WebP attachment bytes after the data URL comma", () => {
    const encoded = btoa("1234567890");
    expect(
      ["png", "jpeg", "webp"].map((format) =>
        getDesignReviewScreenshotByteLength(
          `data:image/${format};base64,${encoded}`,
        ),
      ),
    ).toEqual([10, 10, 10]);
  });

  it("builds bounded text-only requirement context without attachment parts", () => {
    const context = buildDesignReviewRequirementsContext([
      {
        role: "user",
        content: [
          { type: "text", text: "Build a calm <editorial> page." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,secret" },
          },
        ],
      },
      {
        role: "user",
        content: "Automatic QA internals",
        metadata: { origin: "auto_qa" },
      },
    ]);
    expect(context).toContain("Build a calm \\u003ceditorial\\u003e page.");
    expect(context).not.toContain("base64");
    expect(context).not.toContain("Automatic QA internals");
  });

  it("reports captured and missing automatic viewport coverage as untrusted context", () => {
    const context = buildDesignReviewSemanticContext([
      {
        dataUrl: pngDataUrl,
        viewport: {
          name: "desktop",
          width: 1440,
          height: 860,
          capturedHeight: 1200,
          fullHeight: 1200,
          truncated: false,
        },
        semanticSnapshot: {
          route: "/",
          viewport: { width: 1440, height: 860, devicePixelRatio: 1 },
          document: {
            scrollWidth: 1440,
            scrollHeight: 1200,
            horizontalOverflow: false,
            fonts: "ready",
          },
          elements: [],
        },
      },
    ]);

    expect(context).toContain("untrusted_preview_semantics");
    expect(context).toContain('"captured":["desktop"]');
    expect(context).toContain('"missing":["tablet","mobile"]');
  });
});
