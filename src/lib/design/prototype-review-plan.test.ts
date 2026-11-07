import { describe, expect, it } from "vitest";
import { parseProjectDesign } from "./project-design";
import {
  buildPrototypeReviewCapturePlan,
  buildPrototypeReviewCaptureReport,
} from "./prototype-review-plan";

const blueprint = {
  schemaVersion: "open-builder-design-project/v1",
  productGoal: "Manage work",
  audience: "Teams",
  revision: 1,
  pages: [
    {
      id: "dashboard",
      name: "Dashboard",
      responsibility: "Summarize work",
      route: "/dashboard",
      kind: "dashboard",
      defaultScenario: "default",
      filePaths: ["src/Dashboard.tsx"],
      sharedUiRefs: [],
      flowIds: [],
      scenarioIds: ["default", "error"],
    },
    {
      id: "settings",
      name: "Settings",
      responsibility: "Manage preferences",
      route: "/settings",
      kind: "settings",
      defaultScenario: "default",
      filePaths: ["src/Settings.tsx"],
      sharedUiRefs: [],
      flowIds: [],
      scenarioIds: ["default"],
    },
  ],
  layouts: [],
  sharedUiRefs: [],
  flows: [],
  scenarios: [
    { id: "default", name: "Default", kind: "default" },
    { id: "error", name: "Failure", kind: "error" },
  ],
  buildProgress: {
    status: "in-progress",
    percent: 50,
    completedPageIds: ["dashboard"],
    completedFlowIds: [],
    checkpoints: [],
  },
};

describe("prototype review plan", () => {
  it("reports incomplete targets while capturing independent draft pages", () => {
    const parsed = parseProjectDesign({
      schemaVersion: "open-builder-design-project/v2",
      revision: 1,
      pages: [
        { id: "draft" },
        { id: "dynamic", route: "/items/:id" },
        { id: "ready", route: "/home" },
      ],
    });
    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") return;
    const report = buildPrototypeReviewCaptureReport(parsed.design);
    expect(report.targets).toHaveLength(3);
    expect(
      report.targets.every(
        (item) =>
          item.target.pageId === "ready" &&
          item.target.scenarioId === "default",
      ),
    ).toBe(true);
    expect(report.skipped).toMatchObject([
      { pageId: "draft", reason: "missing-route" },
      { pageId: "dynamic", reason: "missing-example" },
    ]);
    expect(buildPrototypeReviewCaptureReport(parsed.design, [])).toEqual({
      targets: [],
      skipped: [],
    });
  });

  it("prioritizes every affected default and critical state before responsive repeats", () => {
    const parsed = parseProjectDesign(blueprint);
    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") return;

    const plan = buildPrototypeReviewCapturePlan(parsed.design, ["dashboard"]);
    expect(plan.slice(0, 2)).toMatchObject([
      { target: { pageId: "dashboard", scenarioId: "default" } },
      { target: { pageId: "dashboard", scenarioId: "error" } },
    ]);
    expect(plan.every((item) => item.target.pageId === "dashboard")).toBe(true);
    expect(plan.map((item) => item.viewport.name)).toEqual([
      "desktop",
      "desktop",
      "tablet",
      "mobile",
    ]);
  });
});
