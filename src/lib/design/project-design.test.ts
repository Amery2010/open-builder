import { describe, expect, it } from "vitest";
import type { ProjectFiles } from "../../types";
import {
  PROJECT_DESIGN_PATH,
  PROJECT_DESIGN_SCHEMA_VERSION,
  applyProjectDesignUpdate,
  deriveCoverageTargets,
  deriveImpactPages,
  derivePageTree,
  getIncompleteBuildProgress,
  isProjectDesignRevisionStale,
  parseProjectDesign,
  projectDesignSchema,
  readProjectDesign,
  resolveProjectDesignPreviewTarget,
  resolveProjectDesignPreviewRoute,
  serializeProjectDesign,
  upsertProjectDesign,
} from "./project-design";

function design(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION,
    productGoal: "Help a team publish a clear product story.",
    audience: "Small product teams",
    revision: 7,
    pages: [
      {
        id: "home",
        name: "Home",
        responsibility: "Explain the product and start the sign-up flow.",
        route: "/",
        kind: "landing",
        defaultScenario: "default",
        layoutId: "shell",
        sharedUiRefs: ["nav"],
        flowIds: ["signup"],
        scenarioIds: ["default", "empty"],
      },
      {
        id: "settings",
        name: "Settings",
        responsibility: "Let people manage their product preferences.",
        route: "/settings",
        kind: "settings",
        defaultScenario: "default",
        parentId: "home",
        layoutId: "shell",
        filePaths: ["src/pages/Settings.tsx"],
        sharedUiRefs: ["nav"],
        flowIds: [],
        scenarioIds: ["default"],
      },
    ],
    layouts: [
      {
        id: "shell",
        name: "Application shell",
        kind: "app-shell",
        filePaths: ["src/layouts/AppShell.tsx"],
        pageIds: ["home", "settings"],
        sharedUiRefs: ["nav"],
      },
    ],
    sharedUiRefs: [
      {
        id: "nav",
        name: "Primary navigation",
        kind: "navigation",
        filePaths: ["src/components/PrimaryNav.tsx"],
      },
    ],
    flows: [
      {
        id: "signup",
        name: "Sign up",
        pageIds: ["home"],
        scenarioIds: ["default"],
      },
    ],
    scenarios: [
      { id: "default", name: "Default", kind: "default" },
      { id: "empty", name: "Empty state", kind: "empty" },
    ],
    buildProgress: {
      status: "in-progress",
      percent: 40,
      completedPageIds: ["home"],
      completedFlowIds: [],
    },
    ...overrides,
  };
}

function filesWith(value: unknown): ProjectFiles {
  return { [PROJECT_DESIGN_PATH]: JSON.stringify(value) };
}

describe("project design deep module", () => {
  it("distinguishes missing, invalid, and ready root authority", () => {
    expect(readProjectDesign({})).toEqual({
      status: "missing",
      path: PROJECT_DESIGN_PATH,
    });
    expect(
      readProjectDesign(filesWith({ ...design(), extra: true })),
    ).toMatchObject({
      status: "invalid",
      path: PROJECT_DESIGN_PATH,
    });
    expect(readProjectDesign(filesWith(design()))).toMatchObject({
      status: "ready",
      path: PROJECT_DESIGN_PATH,
      design: { revision: 7, pages: expect.any(Array) },
    });
    expect(readProjectDesign({ "src/design-project.json": "{}" })).toEqual({
      status: "missing",
      path: PROJECT_DESIGN_PATH,
    });
  });

  it("rejects duplicate entities, references, routes, cycles, and executable scenario fields", () => {
    expect(
      projectDesignSchema.safeParse(
        design({
          scenarios: [
            {
              id: "default",
              name: "Default",
              kind: "default",
              script: "run()",
            },
            { id: "empty", name: "Empty", kind: "empty" },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      projectDesignSchema.safeParse(
        design({
          pages: [
            ...(design().pages as unknown[]),
            (design().pages as unknown[])[0],
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      projectDesignSchema.safeParse(
        design({
          pages: [
            (design().pages as unknown[])[0],
            {
              ...((design().pages as unknown[])[1] as Record<string, unknown>),
              route: "/",
            },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      projectDesignSchema.safeParse(
        design({
          pages: [
            (design().pages as unknown[])[0],
            {
              ...((design().pages as unknown[])[1] as Record<string, unknown>),
              parentId: "settings",
            },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      parseProjectDesign({
        ...design(),
        pages: [
          {
            ...((design().pages as unknown[])[0] as Record<string, unknown>),
            sharedUiRefs: ["nav", "nav"],
          },
          (design().pages as unknown[])[1],
        ],
      }),
    ).toMatchObject({ status: "invalid" });
    expect(
      parseProjectDesign({
        ...design(),
        pages: [
          {
            ...((design().pages as unknown[])[0] as Record<string, unknown>),
            route: "/reports%ZZ",
          },
          (design().pages as unknown[])[1],
        ],
      }),
    ).toMatchObject({ status: "invalid" });
    expect(
      parseProjectDesign({
        ...design(),
        pages: [
          {
            ...((design().pages as unknown[])[0] as Record<string, unknown>),
            filePaths: ["credentials.json"],
          },
          (design().pages as unknown[])[1],
        ],
      }),
    ).toMatchObject({ status: "invalid" });
    const pageWithoutResponsibility = {
      ...((design().pages as unknown[])[0] as Record<string, unknown>),
    };
    delete pageWithoutResponsibility.responsibility;
    expect(
      parseProjectDesign({
        ...design(),
        pages: [pageWithoutResponsibility, (design().pages as unknown[])[1]],
      }),
    ).toMatchObject({ status: "invalid" });
    expect(
      parseProjectDesign({
        ...design(),
        sharedUiRefs: [
          {
            id: "nav",
            name: "Primary navigation",
            kind: "navigation",
            filePaths: [
              "src/components/PrimaryNav.tsx",
              "src\\components\\PrimaryNav.tsx",
            ],
          },
        ],
      }),
    ).toMatchObject({ status: "invalid" });
    const windowsPathDesign = design();
    (
      (windowsPathDesign.sharedUiRefs as unknown[])[0] as Record<
        string,
        unknown
      >
    ).filePaths = ["src\\components\\PrimaryNav.tsx"];
    const normalized = parseProjectDesign(windowsPathDesign);
    expect(normalized).toMatchObject({ status: "ready" });
    if (normalized.status === "ready") {
      expect(normalized.design.sharedUiRefs[0].filePaths).toEqual([
        "src/components/PrimaryNav.tsx",
      ]);
    }
  });

  it("serializes canonically and upserts without mutating files", () => {
    const input = design({
      pages: [...(design().pages as unknown[])].reverse(),
      scenarios: [...(design().scenarios as unknown[])].reverse(),
    });
    const first = serializeProjectDesign(input);
    const second = serializeProjectDesign(JSON.parse(first) as unknown);
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.indexOf('"pages":')).toBeLessThan(
      first.indexOf('"scenarios":'),
    );
    expect(JSON.parse(first).sharedUiRefs[0].filePaths).toEqual([
      "src/components/PrimaryNav.tsx",
    ]);

    const files = { "src/App.tsx": "export default null" };
    const updated = upsertProjectDesign(files, input);
    expect(files).toEqual({ "src/App.tsx": "export default null" });
    expect(updated[PROJECT_DESIGN_PATH]).toBe(first);
  });

  it("uses one compare-and-swap update seam for UI and model callers", () => {
    const current = filesWith(design());
    expect(
      applyProjectDesignUpdate(current, { ...design(), revision: 8 }, 6),
    ).toMatchObject({ ok: false, error: expect.stringContaining("stale") });
    const updated = applyProjectDesignUpdate(
      current,
      { ...design(), revision: 8 },
      7,
    );
    expect(updated).toMatchObject({
      ok: true,
      action: "modified",
      design: { revision: 8 },
    });
    expect(
      applyProjectDesignUpdate(current, { ...design(), revision: 7 }, 7),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("must advance"),
    });
  });

  it("accepts declarative validation and submission-success scenarios", () => {
    const parsed = parseProjectDesign({
      ...design(),
      scenarios: [
        ...(design().scenarios as unknown[]),
        { id: "validation", name: "Validation errors", kind: "validation" },
        { id: "success", name: "Submission complete", kind: "success" },
      ],
    });

    expect(parsed).toMatchObject({ status: "ready" });
  });

  it("derives a stable page tree, impact pages, coverage targets, and incomplete progress", () => {
    const parsed = parseProjectDesign(design());
    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") return;

    const tree = derivePageTree(parsed.design);
    expect(tree.map((node) => node.id)).toEqual(["home"]);
    expect(tree[0].children.map((node) => node.id)).toEqual(["settings"]);
    expect(deriveImpactPages(parsed.design, ["nav"])).toEqual([
      "home",
      "settings",
    ]);
    expect(
      resolveProjectDesignPreviewTarget(parsed.design, "settings", "default"),
    ).toEqual({
      pageId: "settings",
      route: "#/settings?scenario=default",
      scenarioId: "default",
    });
    expect(
      resolveProjectDesignPreviewTarget(parsed.design, "settings", "empty"),
    ).toBeNull();
    expect(
      resolveProjectDesignPreviewRoute(
        parsed.design,
        "#/settings?scenario=default",
      ),
    ).toMatchObject({ pageId: "settings", scenarioId: "default" });
    expect(
      resolveProjectDesignPreviewRoute(parsed.design, "#/settings"),
    ).toMatchObject({ pageId: "settings", scenarioId: "default" });
    expect(
      resolveProjectDesignPreviewRoute(
        parsed.design,
        "#/settings?status=active",
      ),
    ).toMatchObject({ pageId: "settings", scenarioId: "default" });
    expect(resolveProjectDesignPreviewRoute(parsed.design, "/")).toMatchObject({
      pageId: "home",
      scenarioId: "default",
    });
    expect(
      deriveImpactPages(parsed.design, ["src/components/PrimaryNav.tsx"]),
    ).toEqual(["home", "settings"]);
    expect(deriveImpactPages(parsed.design, ["signup"])).toEqual(["home"]);
    expect(deriveCoverageTargets(parsed.design)).toEqual([
      { id: "home:default", pageId: "home", route: "/", scenarioId: "default" },
      { id: "home:empty", pageId: "home", route: "/", scenarioId: "empty" },
      {
        id: "settings:default",
        pageId: "settings",
        route: "/settings",
        scenarioId: "default",
      },
    ]);
    expect(getIncompleteBuildProgress(parsed.design)).toEqual({
      status: "in-progress",
      percent: 40,
      pageIds: ["settings"],
      flowIds: ["signup"],
      phaseIds: ["foundation", "core_flow", "remaining_flows", "final_review"],
      nextPhase: "foundation",
    });
  });

  it("requires passed phase checkpoints before a build can be complete", () => {
    expect(
      parseProjectDesign({
        ...design(),
        buildProgress: {
          status: "complete",
          percent: 100,
          completedPageIds: ["home", "settings"],
          completedFlowIds: ["signup"],
          checkpoints: [],
        },
      }),
    ).toMatchObject({ status: "invalid" });

    const checkpoints = [
      "foundation",
      "core_flow",
      "remaining_flows",
      "final_review",
    ].map((phase) => ({
      phase,
      status: "completed",
      pageIds: phase === "foundation" ? [] : ["home", "settings"],
      flowIds: phase === "foundation" ? [] : ["signup"],
      artifactPaths: ["src/App.tsx"],
      validation: { status: "passed", summary: `${phase} verified` },
      recordedAt: "2026-09-05T12:00:00.000Z",
    }));
    const parsed = parseProjectDesign({
      ...design(),
      buildProgress: {
        status: "complete",
        percent: 100,
        completedPageIds: ["home", "settings"],
        completedFlowIds: ["signup"],
        checkpoints,
      },
    });
    expect(parsed).toMatchObject({ status: "ready" });
    if (parsed.status === "ready") {
      expect(getIncompleteBuildProgress(parsed.design)).toMatchObject({
        status: "complete",
        pageIds: [],
        flowIds: [],
        phaseIds: [],
      });
      expect(
        parseProjectDesign(serializeProjectDesign(parsed.design)),
      ).toMatchObject({
        status: "ready",
        design: {
          buildProgress: {
            status: "complete",
            checkpoints: expect.arrayContaining([
              expect.objectContaining({ phase: "final_review" }),
            ]),
          },
        },
      });
    }
  });

  it("uses equality for stale revision checks and rejects unsafe revisions", () => {
    expect(isProjectDesignRevisionStale(7, 7)).toBe(false);
    expect(isProjectDesignRevisionStale(7, 8)).toBe(true);
    expect(isProjectDesignRevisionStale(8, 7)).toBe(true);
    expect(() => isProjectDesignRevisionStale(-1, 0)).toThrow();
    expect(() =>
      isProjectDesignRevisionStale(0, Number.MAX_SAFE_INTEGER + 1),
    ).toThrow();
  });
});
