import type { ProjectDesign } from "./project-design";
import { deriveCoverageTargets } from "./project-design";
import { DESIGN_REVIEW_VIEWPORTS } from "./preview-capture";
import type { DesignReviewViewport } from "./preview-capture";
import type { PrototypePreviewTarget } from "./preview-runtime";
import { MAX_DESIGN_REVIEW_SCREENSHOTS } from "./review";

export interface PrototypeReviewCapturePlanItem {
  target: PrototypePreviewTarget;
  viewport: DesignReviewViewport;
}

function target(
  pageId: string,
  route: string,
  scenarioId: string,
): PrototypePreviewTarget {
  return { pageId, route: `#${route}?scenario=${scenarioId}`, scenarioId };
}

/** Build a stable, priority-ordered plan. Missing overflow remains unreviewed. */
export function buildPrototypeReviewCapturePlan(
  design: ProjectDesign,
  affectedPageIds?: readonly string[],
): PrototypeReviewCapturePlanItem[] {
  const viewports = new Map(
    DESIGN_REVIEW_VIEWPORTS.map((viewport) => [viewport.name, viewport]),
  );
  const scenarios = new Map(
    design.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const affected = affectedPageIds?.length
    ? new Set(affectedPageIds)
    : undefined;
  const pages = design.pages.filter(
    (page) => !affected || affected.has(page.id),
  );
  const defaultTargets = pages.map((page) =>
    target(page.id, page.route, page.defaultScenario),
  );
  const criticalTargets = deriveCoverageTargets(design)
    .filter((candidate) => {
      const kind = scenarios.get(candidate.scenarioId)?.kind;
      return (
        candidate.scenarioId !==
          pages.find((page) => page.id === candidate.pageId)?.defaultScenario &&
        (!affected || affected.has(candidate.pageId)) &&
        [
          "empty",
          "loading",
          "validation",
          "success",
          "error",
          "failure",
        ].includes(kind ?? "")
      );
    })
    .map((candidate) =>
      target(candidate.pageId, candidate.route, candidate.scenarioId),
    );
  const plan: PrototypeReviewCapturePlanItem[] = [];
  const add = (
    targets: readonly PrototypePreviewTarget[],
    viewportName: "desktop" | "tablet" | "mobile",
  ) => {
    const viewport = viewports.get(viewportName);
    if (!viewport) return;
    for (const candidate of targets) plan.push({ target: candidate, viewport });
  };
  add(defaultTargets, "desktop");
  add(criticalTargets, "desktop");
  add(defaultTargets, "tablet");
  add(defaultTargets, "mobile");
  return plan.slice(0, MAX_DESIGN_REVIEW_SCREENSHOTS);
}
