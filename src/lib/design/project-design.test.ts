import { describe, expect, it } from "vitest";
import type { ProjectFiles } from "../../types";
import {
  PROJECT_DESIGN_PATH,
  PROJECT_DESIGN_SCHEMA_VERSION,
  applyProjectDesignUpdate,
  applyProjectDesignToolUpdate,
  applyProjectDesignToolRequest,
  appendProjectDesignJournal,
  getProjectDesignDiagnostics,
  getProjectDesignStructureFingerprint,
  resolveProjectDesignPreview,
  deriveCoverageTargets,
  deriveImpactPages,
  derivePageTree,
  getIncompleteBuildProgress,
  isProjectDesignRevisionStale,
  parseProjectDesign,
  projectDesignSchema,
  projectDesignUpdateSchema,
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
  it("merges progress patches without clearing omitted completion records", () => {
    const original = projectDesignSchema.parse(design());
    original.buildProgress.checkpoints = [
      {
        phase: "foundation",
        status: "completed",
        pageIds: ["home"],
        flowIds: [],
        artifactPaths: ["src/App.tsx"],
        validation: { status: "passed", summary: "Foundation checked" },
        recordedAt: "2026-09-05T12:00:00.000Z",
      },
    ];
    const files = filesWith(original);
    const patch = projectDesignUpdateSchema.parse({
      buildProgress: { percent: 60 },
    });
    expect(patch).toEqual({ buildProgress: { percent: 60 } });
    const result = applyProjectDesignToolUpdate(files, patch, 7);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.design).toEqual({
      ...original,
      revision: 8,
      buildProgress: { ...original.buildProgress, percent: 60 },
    });
    expect(files).toEqual(filesWith(original));
    const cleared = applyProjectDesignToolUpdate(
      result.files,
      {
        buildProgress: { completedPageIds: [], checkpoints: [] },
      },
      8,
    );
    expect(cleared).toMatchObject({
      ok: true,
      design: {
        revision: 9,
        buildProgress: { percent: 60, completedPageIds: [], checkpoints: [] },
      },
    });
  });

  it("keeps unresolved references as draft diagnostics without inventing flows", () => {
    const original = projectDesignSchema.parse(design());
    const pages = original.pages.map((page) => ({
      ...page,
      flowIds: [...page.flowIds, "wantlist"],
    }));
    const result = applyProjectDesignToolUpdate(
      filesWith(original),
      { pages },
      7,
    );
    expect(result).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([expect.stringContaining("wantlist")]),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.design.flows).toEqual(original.flows);
    expect(result.design.pages[0].flowIds).toContain("wantlist");
    expect(resolveProjectDesignPreview(result.design, "settings").status).toBe(
      "ready",
    );
  });

  it("defaults creation metadata and rejects summary-only writes", () => {
    const {
      schemaVersion: _schemaVersion,
      revision: _revision,
      buildProgress: _progress,
      ...document
    } = design();
    const result = applyProjectDesignToolUpdate({}, document);
    expect(result).toMatchObject({
      ok: true,
      design: {
        schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION,
        revision: 1,
        buildProgress: { status: "not-started", percent: 0 },
      },
    });
    for (const files of [{}, filesWith(design())]) {
      expect(
        applyProjectDesignToolUpdate(files, {
          revision: 8,
          pageCount: 2,
          flowCount: 1,
          scenarioCount: 2,
        }),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining("summary"),
      });
    }
    expect(
      applyProjectDesignToolUpdate({}, { productGoal: "Only a goal" }).ok,
    ).toBe(true);
  });

  it("checks explicit revision guards and generates string successors", () => {
    const files = filesWith(design());
    for (const expectedRevision of [6]) {
      expect(
        applyProjectDesignToolUpdate(
          files,
          { productGoal: "Updated goal" },
          expectedRevision,
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining("stale"),
      });
    }
    expect(
      applyProjectDesignToolUpdate(
        files,
        { productGoal: "Updated goal", revision: 7 },
        7,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("must advance"),
    });
    const stringFiles = filesWith(design({ revision: "outline-r1" }));
    expect(
      applyProjectDesignToolUpdate(
        stringFiles,
        { productGoal: "Updated goal" },
        "outline-r1",
      ),
    ).toMatchObject({
      ok: true,
      design: { revision: expect.any(String) },
    });
    expect(
      applyProjectDesignToolUpdate(
        stringFiles,
        { productGoal: "Updated goal", revision: "outline-r2" },
        "outline-r1",
      ),
    ).toMatchObject({
      ok: true,
      design: { revision: "outline-r2" },
    });
  });

  it("rejects unsafe file paths and cyclic identities but preserves incomplete semantics", () => {
    const original = projectDesignSchema.parse(design());
    for (const patch of [
      { pages: original.pages.map((page) => ({ ...page, parentId: page.id })) },
      {
        pages: original.pages.map((page) => ({
          ...page,
          filePaths: ["../outside.tsx"],
        })),
      },
    ])
      expect(
        applyProjectDesignToolUpdate(filesWith(original), patch, 7).ok,
      ).toBe(false);
    for (const patch of [
      { flows: [] },
      { buildProgress: { completedFlowIds: ["wantlist"] } },
      {
        pages: original.pages.map((page) => ({
          ...page,
          defaultScenario: "missing",
        })),
      },
      {
        pages: original.pages.map((page) => ({ ...page, layoutId: "missing" })),
      },
    ])
      expect(
        applyProjectDesignToolUpdate(filesWith(original), patch, 7).ok,
      ).toBe(true);
  });

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

  it("rejects unsafe structures while allowing unresolved route and content drafts", () => {
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
    ).toBe(true);
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
    ).toMatchObject({ status: "ready" });
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
    ).toMatchObject({ status: "ready" });
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
      phaseIds: [],
    });
  });

  it("preserves legacy checkpoints without imposing four mandatory phases", () => {
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
    ).toMatchObject({ status: "ready" });

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

  it("merges entity patches by id and only removes explicitly listed entities", () => {
    const original = projectDesignSchema.parse(design());
    const result = applyProjectDesignToolRequest(filesWith(original), {
      patch: { pages: [{ id: "home", name: "Updated" }, { id: "draft" }] },
      remove: { pages: ["settings"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.design.pages.map((page) => page.id)).toEqual([
      "draft",
      "home",
    ]);
    expect(
      result.design.pages.find((page) => page.id === "home"),
    ).toMatchObject({ ...original.pages[0], name: "Updated" });
    expect(result.design.flows).toEqual(original.flows);
    expect(resolveProjectDesignPreview(result.design, "draft")).toMatchObject({
      status: "unavailable",
      reason: "missing-route",
    });
    expect(resolveProjectDesignPreview(result.design, "home").status).toBe(
      "ready",
    );
    expect(
      applyProjectDesignToolRequest(filesWith(original), {
        patch: { pages: [{ id: "home" }] },
        document: { pages: [] },
      }).ok,
    ).toBe(false);
    expect(
      applyProjectDesignToolRequest(filesWith(original), {
        patch: { pages: [{ id: "home" }] },
        remove: { pages: ["home"] },
      }).ok,
    ).toBe(false);
  });

  it("reads v1 without writing and migrates all history only on an actual update", () => {
    const checkpoint = {
      phase: "custom-import-step",
      status: "completed",
      pageIds: ["home"],
      flowIds: [],
      artifactPaths: ["src/App.tsx"],
      validation: { status: "not-run", summary: "Imported history" },
      recordedAt: "2026-09-05T12:00:00.000Z",
    };
    const legacy = design({
      schemaVersion: "open-builder-design-project/v1",
      revision: "legacy-r7",
      buildProgress: {
        status: "in-progress",
        percent: 40,
        completedPageIds: ["home"],
        completedFlowIds: [],
        checkpoints: [checkpoint],
      },
    });
    const files = filesWith(legacy);
    const before = files[PROJECT_DESIGN_PATH];
    expect(readProjectDesign(files)).toMatchObject({
      status: "ready",
      design: { revision: "legacy-r7" },
    });
    expect(files[PROJECT_DESIGN_PATH]).toBe(before);
    const updated = applyProjectDesignToolRequest(files, {
      patch: { pages: [{ id: "settings", previewPath: "/settings" }] },
    });
    if (!updated.ok) throw new Error(updated.error);
    expect(JSON.parse(updated.files[PROJECT_DESIGN_PATH])).toMatchObject({
      schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION,
      buildProgress: { checkpoints: [checkpoint], completedPageIds: ["home"] },
    });
    expect(updated.design.revision).not.toBe("legacy-r7");
    expect(files[PROJECT_DESIGN_PATH]).toBe(before);
  });

  it("writes recovery entries with the source transaction and deduplicates committed operations", () => {
    const before = filesWith(design());
    const proposed = { ...before, "src/App.tsx": "export default null" };
    const entry = {
      operationId: "write-1",
      requestId: "request-1",
      changedPaths: ["src/App.tsx"],
      recordedAt: "2026-09-05T12:00:00.000Z",
    };
    const committed = appendProjectDesignJournal(proposed, entry, before);
    expect(JSON.parse(committed[PROJECT_DESIGN_PATH])).toMatchObject({
      revision: 8,
      journal: [entry],
    });
    expect(appendProjectDesignJournal(committed, entry, before)).toBe(
      committed,
    );
    const alreadyAdvanced = {
      ...proposed,
      [PROJECT_DESIGN_PATH]: JSON.stringify(design({ revision: 9 })),
    };
    expect(
      JSON.parse(
        appendProjectDesignJournal(alreadyAdvanced, entry, before)[
          PROJECT_DESIGN_PATH
        ],
      ).revision,
    ).toBe(9);
    expect(appendProjectDesignJournal({ "src/App.tsx": "a" }, entry)).toEqual({
      "src/App.tsx": "a",
    });
  });

  it("accepts journal echoes but never lets a model replace Host recovery records", () => {
    const entry = {
      operationId: "host-write",
      requestId: "request-1",
      changedPaths: ["src/App.tsx"],
      recordedAt: "2026-09-05T12:00:00.000Z",
    };
    const files = appendProjectDesignJournal(filesWith(design()), entry);
    const current = readProjectDesign(files);
    if (current.status !== "ready") throw new Error("expected blueprint");
    const result = applyProjectDesignToolRequest(files, {
      document: {
        ...current.design,
        revision: 9,
        productGoal: "Updated",
        journal: [],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      design: { journal: [entry] },
      warnings: expect.arrayContaining([
        expect.stringContaining("Ignored supplied journal"),
      ]),
    });
    const created = applyProjectDesignToolRequest(
      {},
      { patch: { pages: [{ id: "draft" }], journal: [entry] } },
    );
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.design.journal).toBeUndefined();
  });

  it("separates structural freshness from progress and descriptive changes", () => {
    const original = projectDesignSchema.parse(design());
    const changed = projectDesignSchema.parse({
      ...original,
      revision: 8,
      productGoal: "Another explanation",
      buildProgress: { ...original.buildProgress, percent: 90 },
    });
    expect(getProjectDesignStructureFingerprint(changed)).toBe(
      getProjectDesignStructureFingerprint(original),
    );
    changed.pages[0].previewPath = "/new";
    expect(getProjectDesignStructureFingerprint(changed)).not.toBe(
      getProjectDesignStructureFingerprint(original),
    );
    expect(
      getProjectDesignDiagnostics(
        projectDesignSchema.parse({
          schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION,
          revision: 1,
          pages: [{ id: "draft" }],
        }),
      ),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ pageId: "draft" })]),
    );
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
