import { describe, expect, it, vi } from "vitest";
import { buildToolHandlers } from "./handler-factory";
import type { ProjectFiles } from "../../types";

vi.mock("../skills/fs", () => ({ isSkillsAvailable: () => false }));
vi.mock("../skills/instance", () => ({ getSkillRegistry: vi.fn() }));

describe("buildToolHandlers Design diagnostics", () => {
  it("registers all diagnostics through one shared Host adapter", async () => {
    const designDiagnostics = vi.fn((name: string) =>
      JSON.stringify({ kind: name, ok: true }),
    );
    const built = await buildToolHandlers({
      features: {
        builtinSearch: false,
        webSearch: false,
        assetSearch: false,
      },
      effectiveWebSearchSettings: {
        engine: "disabled",
        tavilyApiKey: "",
        firecrawlApiKey: "",
        exaApiKey: "",
      },
      effectiveAssetSearchSettings: {
        engine: "disabled",
        pixabayApiKey: "",
        unsplashApiKey: "",
      },
      apiConfig: {
        apiType: "openai-compatible",
        apiBaseUrl: "",
        apiKey: "",
        model: "",
      },
      getConsoleLogs: () => [],
      memoryDeps: { getAll: () => [], processBatch: () => "ok" },
      developerSkillScriptsEnabled: false,
      designDiagnostics,
    });

    expect(Object.keys(built.customToolSet)).toEqual(
      expect.arrayContaining([
        "inspect_design_consistency",
        "measure_preview_layout",
        "audit_accessibility_tree",
        "compare_preview_states",
        "trace_design_provenance",
      ]),
    );
    await expect(
      built.combinedToolHandler("measure_preview_layout", {
        viewports: ["mobile"],
      }),
    ).resolves.toContain("measure_preview_layout");
    expect(designDiagnostics).toHaveBeenCalledWith(
      "measure_preview_layout",
      { viewports: ["mobile"] },
      undefined,
    );
  });

  it("validates and writes project design through the shared Host adapter", async () => {
    let files: ProjectFiles = { "package.json": "{}" };
    const onProjectDesignUpdated = vi.fn();
    const built = await buildToolHandlers({
      features: {
        builtinSearch: false,
        webSearch: false,
        assetSearch: false,
      },
      effectiveWebSearchSettings: {
        engine: "disabled",
        tavilyApiKey: "",
        firecrawlApiKey: "",
        exaApiKey: "",
      },
      effectiveAssetSearchSettings: {
        engine: "disabled",
        pixabayApiKey: "",
        unsplashApiKey: "",
      },
      apiConfig: {
        apiType: "openai-compatible",
        apiBaseUrl: "",
        apiKey: "",
        model: "",
      },
      getConsoleLogs: () => [],
      memoryDeps: { getAll: () => [], processBatch: () => "ok" },
      developerSkillScriptsEnabled: false,
      filesBridge: {
        getFiles: () => files,
        onFilesChanged: (next) => {
          files = next;
        },
      },
      onProjectDesignUpdated,
    });
    const document = {
      schemaVersion: "open-builder-design-project/v1",
      productGoal: "Manage customer work",
      audience: "Operations teams",
      revision: 1,
      pages: [
        {
          id: "dashboard",
          name: "Dashboard",
          responsibility: "Summarize active work",
          route: "/dashboard",
          kind: "dashboard",
          defaultScenario: "default",
          parentId: null,
          layoutId: "app-shell",
          filePaths: ["src/pages/Dashboard.tsx"],
          sharedUiRefs: ["primary-nav"],
          flowIds: ["manage-work"],
          scenarioIds: ["default"],
        },
      ],
      layouts: [
        {
          id: "app-shell",
          name: "Application shell",
          kind: "app-shell",
          filePaths: ["src/App.tsx"],
          pageIds: ["dashboard"],
          sharedUiRefs: ["primary-nav"],
        },
      ],
      sharedUiRefs: [
        {
          id: "primary-nav",
          name: "Primary navigation",
          kind: "navigation",
          filePaths: ["src/PrimaryNav.tsx"],
        },
      ],
      flows: [
        {
          id: "manage-work",
          name: "Manage work",
          pageIds: ["dashboard"],
          scenarioIds: ["default"],
        },
      ],
      scenarios: [{ id: "default", name: "Default", kind: "default" }],
      buildProgress: {
        status: "not-started",
        percent: 0,
        completedPageIds: [],
        completedFlowIds: [],
      },
    };

    const unsupported = await built.combinedToolHandler(
      "update_project_design",
      { document },
    );
    expect(unsupported).toMatchObject({ isError: true });
    expect((unsupported as { text: string }).text).toContain(
      "complete prototype starter",
    );

    files = {
      "package.json": JSON.stringify({
        openBuilder: { profile: "complete-prototype", schemaVersion: 1 },
      }),
    };
    const created = await built.combinedToolHandler("update_project_design", {
      document,
    });
    expect(created).toMatchObject({
      structuredContent: { ok: true, revision: 1 },
    });
    expect(files["design-project.json"]).toContain('"revision": 1');
    expect(onProjectDesignUpdated).toHaveBeenLastCalledWith(files);

    const stale = await built.combinedToolHandler("update_project_design", {
      document: { ...document, revision: 2 },
      expected_revision: 0,
    });
    expect(stale).toMatchObject({ isError: true });
    expect((stale as { text: string }).text).toContain("stale");

    const stringRevision = await built.combinedToolHandler(
      "update_project_design",
      {
        document: { ...document, revision: "outline-r2" },
        expected_revision: 1,
      },
    );
    expect(stringRevision).toMatchObject({
      structuredContent: { ok: true, revision: "outline-r2" },
    });

    const sameRevision = await built.combinedToolHandler(
      "update_project_design",
      {
        document: { ...document, revision: "outline-r2" },
        expected_revision: "outline-r2",
      },
    );
    expect(sameRevision).toMatchObject({ isError: true });
    expect((sameRevision as { text: string }).text).toContain("must advance");

    files = { ...files, "design-project.json": "{" };
    const repaired = await built.combinedToolHandler("update_project_design", {
      document: { ...document, revision: "outline-r3" },
    });
    expect(repaired).toMatchObject({
      structuredContent: { ok: true, revision: "outline-r3" },
    });
  });
});
