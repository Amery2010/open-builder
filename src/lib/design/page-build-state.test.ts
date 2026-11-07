import { describe, expect, it } from "vitest";
import { projectDesignSchema } from "./project-design";
import { derivePageBuildState } from "./page-build-state";

describe("page implementation evidence", () => {
  it("distinguishes a completion declaration, committed implementation, and pending work", () => {
    const design = projectDesignSchema.parse({
      schemaVersion: "open-builder-design-project/v2",
      revision: 1,
      pages: [{ id: "home", filePaths: ["App.tsx"] }],
      buildProgress: { completedPageIds: ["home"] },
      tasks: [{ id: "build-home", pageIds: ["home"], status: "done" }],
    });
    const files = { "App.tsx": "page implementation" };
    expect(
      derivePageBuildState(design, design.pages[0], files).buildStatus,
    ).toBe("recorded");
    design.journal = [
      {
        operationId: "write-app",
        requestId: "request",
        changedPaths: ["App.tsx"],
        recordedAt: "2026-11-07T08:00:00Z",
      },
    ];
    expect(
      derivePageBuildState(design, design.pages[0], files).buildStatus,
    ).toBe("complete");
    design.tasks![0].status = "pending";
    expect(derivePageBuildState(design, design.pages[0], files)).toEqual({
      buildProgress: 0,
      buildStatus: "in-progress",
    });
  });
});
