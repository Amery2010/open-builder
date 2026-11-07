import { describe, expect, it } from "vitest";
import { prepareDesignRun, designRunSkillIds } from "./design-run";
import {
  PROJECT_DESIGN_SCHEMA_VERSION,
  readProjectDesign,
} from "./project-design";
import type { ProjectFiles } from "../../types";

function files(extra: Record<string, unknown> = {}): ProjectFiles {
  return {
    "design-project.json": JSON.stringify({
      schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION,
      revision: 1,
      pages: [
        { id: "home", filePaths: ["src/Home.tsx"] },
        { id: "other", filePaths: ["src/Other.tsx"] },
      ],
      ...extra,
    }),
    "src/Home.tsx": "before",
    "src/Other.tsx": "before",
  };
}
const outcome = { aborted: false, maxIterationsReached: false };

describe("Host prepared Design run", () => {
  it("prepares unknown design context and skills without a model contract", () => {
    const run = prepareDesignRun({
      requestId: "one",
      goal: "Build",
      files: files(),
    });
    expect(run.context()).toMatchObject({
      target: "Build",
      audience: "",
      concept: "",
      surface_mode: "mixed",
    });
    expect(designRunSkillIds()).toEqual([
      "design-product-ui",
      "art-direct-web",
    ]);
    expect(run.authorize("update_project_design", {}, files())).toBeUndefined();
    expect(
      run.authorize("write_file", { path: "src/Home.tsx" }, files()),
    ).toBeUndefined();
  });

  it("keeps selected page scope across progress changes while allowing inspection", () => {
    const original = files();
    const run = prepareDesignRun({
      requestId: "one",
      goal: "Edit home",
      files: original,
      pageIds: ["home"],
    });
    const changed = files({ revision: 2, buildProgress: { percent: 60 } });
    run.context(changed);
    expect(
      run.authorize("write_file", { path: "src/Home.tsx" }, changed),
    ).toBeUndefined();
    expect(
      run.authorize("write_file", { path: "src/Other.tsx" }, changed),
    ).toContain("selected design scope");
    expect(
      run.authorize("read_files", { path: "src/Other.tsx" }, changed),
    ).toBeUndefined();
    expect(() =>
      run.prepareCommit(
        changed,
        { ...changed, "src/Other.tsx": "outside" },
        "bad",
      ),
    ).toThrow("selected design scope");
  });

  it("does not let blueprint edits widen a selected request or start unrelated tasks", () => {
    const original = files();
    const run = prepareDesignRun({
      requestId: "one",
      goal: "Edit home",
      files: original,
      pageIds: ["home"],
    });
    const widened = files({
      pages: [{ id: "home", filePaths: ["src/Home.tsx", "src/Other.tsx"] }],
      tasks: [{ id: "foreign", status: "pending", pageIds: ["missing"] }],
    });
    const prepared = run.prepareCommit(original, widened, "outline");
    expect(
      run.authorize("write_file", { path: "src/Other.tsx" }, prepared),
    ).toContain("selected design scope");
    expect(
      run.finishPass(
        original,
        { ...prepared, "src/Home.tsx": "changed" },
        outcome,
      ).status,
    ).toBe("needs-information");
  });

  it("preparing a rejected commit does not publish progress or task ownership", () => {
    const original = files();
    const run = prepareDesignRun({
      requestId: "one",
      goal: "Edit",
      files: original,
    });
    run.prepareCommit(
      original,
      { ...original, "src/Home.tsx": "uncommitted" },
      "discarded",
    );
    expect(run.affectedPaths()).toEqual([]);
    expect(run.finishPass(original, original, outcome).status).toBe("complete");
    expect(original["design-project.json"]).not.toContain("discarded");
  });

  it("records source and recovery data atomically and deduplicates replayed commits", () => {
    const original = files();
    const run = prepareDesignRun({
      requestId: "one",
      goal: "Edit",
      files: original,
    });
    const next = run.prepareCommit(
      original,
      { ...original, "src/Home.tsx": "after" },
      "write-1",
    );
    expect(original["src/Home.tsx"]).toBe("before");
    const blueprint = readProjectDesign(next);
    expect(blueprint).toMatchObject({
      status: "ready",
      design: {
        revision: 2,
        journal: [
          {
            operationId: "write-1",
            requestId: "one",
            changedPaths: ["src/Home.tsx"],
          },
        ],
      },
    });
    expect(run.prepareCommit(next, next, "write-1")).toBe(next);
    expect(readProjectDesign(original)).toMatchObject({
      status: "ready",
      design: { revision: 1 },
    });
  });

  it("does not manufacture work from an incomplete blueprint or old unrelated tasks", () => {
    const original = files({
      tasks: [
        {
          id: "old",
          requestId: "previous",
          status: "pending",
          filePaths: ["src/Other.tsx"],
        },
      ],
    });
    const run = prepareDesignRun({
      requestId: "one",
      goal: "Edit",
      files: original,
    });
    expect(
      run.finishPass(
        original,
        { ...original, "src/Home.tsx": "changed" },
        outcome,
      ).status,
    ).toBe("complete");
  });

  it("continues explicit current tasks only with actual source progress", () => {
    const original = files();
    const run = prepareDesignRun({
      requestId: "one",
      goal: "Edit",
      files: original,
    });
    const taskFiles = files({
      tasks: [
        {
          id: "home-task",
          requestId: "one",
          status: "pending",
          filePaths: ["src/Home.tsx"],
        },
      ],
    });
    expect(run.finishPass(original, taskFiles, outcome).status).toBe(
      "needs-information",
    );
    const changed = run.prepareCommit(
      original,
      { ...taskFiles, "src/Home.tsx": "changed" },
      "write",
    );
    expect(run.finishPass(original, changed, outcome)).toEqual({
      status: "continue",
      taskIds: ["home-task"],
    });
    expect(run.finishPass(changed, changed, outcome).status).toBe(
      "needs-information",
    );
    expect(
      run.finishPass(original, changed, { ...outcome, aborted: true }).status,
    ).toBe("cancelled");
    expect(
      run.finishPass(original, changed, {
        ...outcome,
        maxIterationsReached: true,
      }).status,
    ).toBe("paused");
  });
});
