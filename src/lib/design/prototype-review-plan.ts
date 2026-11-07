import type { ProjectDesign } from "./project-design";
import { DESIGN_REVIEW_VIEWPORTS } from "./preview-capture";
import type { DesignReviewViewport } from "./preview-capture";
import type { PrototypePreviewTarget } from "./preview-runtime";
import {
  resolvePrototypeRoute,
  type PrototypeRouteResolution,
} from "./prototype-route";
import { MAX_DESIGN_REVIEW_SCREENSHOTS } from "./review";

export interface PrototypeReviewCapturePlanItem {
  target: PrototypePreviewTarget;
  viewport: DesignReviewViewport;
}
export type PrototypeReviewSkippedTarget = Extract<
  PrototypeRouteResolution,
  { status: "unavailable" }
> & { pageId: string };
export interface PrototypeReviewCaptureReport {
  targets: PrototypeReviewCapturePlanItem[];
  skipped: PrototypeReviewSkippedTarget[];
}

/** Missing information skips only that target, without claiming a successful check. */
export function buildPrototypeReviewCaptureReport(
  design: ProjectDesign,
  affectedPageIds?: readonly string[],
): PrototypeReviewCaptureReport {
  const scenarios = new Map(
    design.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const affected = affectedPageIds ? new Set(affectedPageIds) : undefined;
  const pages = design.pages.filter(
    (page) => !affected || affected.has(page.id),
  );
  const defaults: PrototypePreviewTarget[] = [];
  const critical: PrototypePreviewTarget[] = [];
  const skipped: PrototypeReviewSkippedTarget[] = [];
  const resolve = (
    pageId: string,
    scenarioId: string | undefined,
    targets: PrototypePreviewTarget[],
  ) => {
    const result = resolvePrototypeRoute(design, pageId, scenarioId);
    if (result.status === "ready") targets.push(result.target);
    else skipped.push({ ...result, pageId, scenarioId });
  };
  for (const page of pages) {
    resolve(page.id, page.defaultScenario, defaults);
    for (const scenarioId of page.scenarioIds) {
      if (scenarioId === (page.defaultScenario ?? "default")) continue;
      const scenario = scenarios.get(scenarioId);
      if (
        !scenario ||
        [
          "empty",
          "loading",
          "validation",
          "success",
          "error",
          "failure",
        ].includes(scenario.kind ?? "")
      ) {
        resolve(page.id, scenarioId, critical);
      }
    }
  }
  const targets: PrototypeReviewCapturePlanItem[] = [];
  const add = (
    items: readonly PrototypePreviewTarget[],
    name: "desktop" | "tablet" | "mobile",
  ) => {
    const viewport = DESIGN_REVIEW_VIEWPORTS.find(
      (value) => value.name === name,
    );
    if (viewport)
      for (const target of items) targets.push({ target, viewport });
  };
  add(defaults, "desktop");
  add(critical, "desktop");
  add(defaults, "tablet");
  add(defaults, "mobile");
  return { targets: targets.slice(0, MAX_DESIGN_REVIEW_SCREENSHOTS), skipped };
}

/** Compatibility adapter for callers that only consume executable targets. */
export function buildPrototypeReviewCapturePlan(
  design: ProjectDesign,
  affectedPageIds?: readonly string[],
): PrototypeReviewCapturePlanItem[] {
  return buildPrototypeReviewCaptureReport(design, affectedPageIds).targets;
}
