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
  const affected = affectedPageIds ? new Set(affectedPageIds) : undefined;
  const pages = design.pages.filter(
    (page) => !affected || affected.has(page.id),
  );
  const pageTargets: PrototypePreviewTarget[] = [];
  const skipped: PrototypeReviewSkippedTarget[] = [];
  for (const page of pages) {
    const result = resolvePrototypeRoute(design, page.id);
    if (result.status === "ready") pageTargets.push(result.target);
    else skipped.push({ ...result, pageId: page.id });
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
  add(pageTargets, "desktop");
  add(pageTargets, "tablet");
  add(pageTargets, "mobile");
  return { targets: targets.slice(0, MAX_DESIGN_REVIEW_SCREENSHOTS), skipped };
}

/** Compatibility adapter for callers that only consume executable targets. */
export function buildPrototypeReviewCapturePlan(
  design: ProjectDesign,
  affectedPageIds?: readonly string[],
): PrototypeReviewCapturePlanItem[] {
  return buildPrototypeReviewCaptureReport(design, affectedPageIds).targets;
}
