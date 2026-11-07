import { describe, expect, it } from "vitest";
import {
  deriveImpactPages,
  parseProjectDesign,
  resolveProjectDesignPreviewRoute,
} from "../project-design";
import { buildPrototypeReviewCapturePlan } from "../prototype-review-plan";
import { SAAS_PROTOTYPE_BLUEPRINT_FIXTURE } from "./saas-prototype";

describe("complete SaaS prototype fixture", () => {
  it("covers the agreed pages, shared navigation impact, and responsive coverage", () => {
    const parsed = parseProjectDesign(SAAS_PROTOTYPE_BLUEPRINT_FIXTURE);
    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") return;

    expect(parsed.design.pages.map((page) => page.id)).toEqual(
      expect.arrayContaining([
        "login",
        "overview",
        "requests",
        "request-detail",
        "request-editor",
        "settings",
      ]),
    );
    expect(deriveImpactPages(parsed.design, ["primary-navigation"])).toEqual([
      "overview",
      "request-detail",
      "request-editor",
      "requests",
      "settings",
    ]);
    expect(
      resolveProjectDesignPreviewRoute(
        parsed.design,
        "#/requests?scenario=empty&filter=open",
      ),
    ).toMatchObject({ pageId: "requests" });

    const reviewPlan = buildPrototypeReviewCapturePlan(parsed.design);
    for (const page of parsed.design.pages) {
      expect(reviewPlan).toContainEqual(
        expect.objectContaining({
          target: expect.objectContaining({
            pageId: page.id,
          }),
          viewport: expect.objectContaining({ name: "desktop" }),
        }),
      );
    }
    expect(
      new Set(
        reviewPlan.map(
          ({ target, viewport }) => `${target.pageId}:${viewport.name}`,
        ),
      ).size,
    ).toBe(reviewPlan.length);
  });
});
