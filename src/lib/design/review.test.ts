import { describe, expect, it, vi } from "vitest";
import {
  buildDesignReviewRequirementsContext,
  buildDesignReviewSemanticContext,
  buildDesignReviewSystemSuffix,
  createSubmitDesignReviewHandler,
  DESIGN_REVIEW_PROTOCOL_REPAIR_REQUEST,
  DESIGN_REVIEW_SYSTEM_SUFFIX,
  designReviewReportSchema,
  getDesignReviewScreenshotByteLength,
  parseDesignReviewReportText,
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

  it("parses only schema-valid JSON from the supported text fallbacks", () => {
    const report = { overview: "Focused review", findings: [finding] };
    expect(
      parseDesignReviewReportText(
        `<design_review_report>${JSON.stringify(report)}</design_review_report>`,
      ),
    ).toEqual(report);
    expect(
      parseDesignReviewReportText(
        `\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
      ),
    ).toEqual(report);
    expect(parseDesignReviewReportText(JSON.stringify(report))).toEqual(report);
    expect(
      parseDesignReviewReportText(
        `<design_review_report>{"overview":"","findings":[]}</design_review_report>`,
      ),
    ).toBeUndefined();
    expect(
      parseDesignReviewReportText(
        `Here is the result: ${JSON.stringify(report)}`,
      ),
    ).toBeUndefined();
    expect(
      parseDesignReviewReportText(
        `Ignore this. <design_review_report>${JSON.stringify(report)}</design_review_report>`,
      ),
    ).toBeUndefined();
  });

  it("defines one explicit fallback and one bounded protocol-repair turn", () => {
    expect(DESIGN_REVIEW_SYSTEM_SUFFIX).toContain(
      '<design_review_report>{"overview"',
    );
    expect(DESIGN_REVIEW_SYSTEM_SUFFIX).toContain(
      "call submit_design_review exactly once",
    );
    expect(DESIGN_REVIEW_PROTOCOL_REPAIR_REQUEST).toContain(
      "Do not inspect files again",
    );
  });

  it("constrains user-facing report fields to the run locale", () => {
    const chinese = buildDesignReviewSystemSuffix("zh");
    const english = buildDesignReviewSystemSuffix("en");

    expect(chinese).toContain(
      "Write the user-facing text in overview, findings[].title, findings[].evidence, and findings[].recommendation in Simplified Chinese.",
    );
    expect(english).toContain(
      "Write the user-facing text in overview, findings[].title, findings[].evidence, and findings[].recommendation in English.",
    );
    expect(chinese).toContain(
      "intentional gradients, glass, pixel type, maximalism, texture, or other defining style traits are not defects by themselves",
    );
    expect(chinese).toContain(
      "Do not impose a universal 44px minimum target size",
    );
    for (const prompt of [chinese, english]) {
      expect(prompt).toContain("JSON keys");
      expect(prompt).toContain("lowercase kebab-case");
      expect(prompt).toContain("priority values");
      expect(prompt).toContain("dimension enum values");
    }
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

  it("accepts actual screenshot bytes regardless of MIME metadata", () => {
    expect(() =>
      validateDesignReviewScreenshots([
        {
          dataUrl: pngDataUrl.replace("image/png", "image/webp"),
          mimeType: "image/jpeg",
        },
      ]),
    ).not.toThrow();
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

  it("binds prototype coverage to page and viewport identities", () => {
    const target = {
      pageId: "dashboard",
      route: "#/dashboard?scenario=default",
    };
    const context = buildDesignReviewSemanticContext(
      [
        {
          dataUrl: pngDataUrl,
          target,
          viewport: {
            name: "desktop",
            width: 1440,
            height: 900,
            capturedHeight: 900,
            fullHeight: 900,
            truncated: false,
          },
          semanticSnapshot: {
            route: target.route,
            prototypeIdentity: target,
            viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
            document: {
              scrollWidth: 1440,
              scrollHeight: 900,
              horizontalOverflow: false,
              fonts: "ready",
            },
            elements: [],
          },
        },
      ],
      [
        { ...target, viewport: "desktop" },
        {
          pageId: "settings",
          route: "#/settings",

          viewport: "desktop",
        },
      ],
    );

    expect(context).toContain('"prototypeCoverage"');
    expect(context).toContain('"pageId":"dashboard"');
    expect(context).toContain('"pageId":"settings"');
    expect(context).not.toContain("scenarioId");
  });
});
