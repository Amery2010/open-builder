import { afterEach, describe, expect, it, vi } from "vitest";
import { buildToolHandlers } from "./handler-factory";
import type { ProjectFiles } from "../../types";
import { createSkillActiveContext } from "../skills/active-context";
import type { ToolExecutionContext } from "../ai/generator-types";
import { TOOL_FETCH_TIMEOUT_MS } from "./network-guard";
import { DESIGN_HOST_TOOLS, HOST_TOOL_CATALOG } from "../ai/tools-schema";

vi.mock("../skills/fs", () => ({ isSkillsAvailable: () => false }));
vi.mock("../skills/instance", () => ({ getSkillRegistry: vi.fn() }));

describe("buildToolHandlers Design diagnostics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ["search_npm_packages", { query: "cancel factory npm" }],
    ["get_npm_package_detail", { packageName: "cancel-factory-package" }],
    ["web_search", { query: "cancel factory web" }],
    ["web_reader", { urls: ["https://page.example.test"] }],
    ["image_search", { query: "cancel factory image" }],
  ])(
    "cancels the real %s HTTP handler without issuing another attempt",
    async (name, args) => {
      const built = await buildToolHandlers({
        features: { builtinSearch: false, webSearch: true, assetSearch: true },
        effectiveWebSearchSettings: {
          engine: "firecrawl",
          tavilyApiKey: "",
          firecrawlApiKey: "",
          exaApiKey: "",
        },
        effectiveAssetSearchSettings: {
          engine: "pixabay",
          pixabayApiKey: "test",
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
      });
      vi.useFakeTimers();
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const controller = new AbortController();
      const context: ToolExecutionContext = {
        signal: controller.signal,
        toolCallId: "cancelled-http",
        run: {
          runId: "http-test",
          conversationId: "conversation",
          mode: "chat",
          platform: "web",
          runtime: "api",
          allowedMcpAliases: new Set(),
          activeSkillIds: new Set(),
          approvedSkillScriptHashes: new Set(),
          policyVersion: "test",
        },
        skillContext: createSkillActiveContext(),
      };
      const request = built.combinedToolHandler(name as string, args, context);
      expect(fetchMock).toHaveBeenCalledOnce();
      controller.abort();
      await Promise.all([
        expect(request).rejects.toMatchObject({ name: "AbortError" }),
        vi.advanceTimersByTimeAsync(TOOL_FETCH_TIMEOUT_MS * 3),
      ]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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
      schemaVersion: "open-builder-design-project/v3",
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

          parentId: null,
          layoutId: "app-shell",
          filePaths: ["src/pages/Dashboard.tsx"],
          sharedUiRefs: ["primary-nav"],
          flowIds: ["manage-work"],
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
        },
      ],

      buildProgress: {
        status: "not-started",
        percent: 0,
        completedPageIds: [],
        completedFlowIds: [],
      },
    };

    const plainProject = await built.combinedToolHandler(
      "update_project_design",
      { document },
    );
    expect(plainProject).toMatchObject({
      structuredContent: { ok: true, revision: 1 },
    });
    onProjectDesignUpdated.mockClear();

    files = {
      "package.json": JSON.stringify({
        openBuilder: { profile: "complete-prototype", schemaVersion: 1 },
      }),
    };
    const unchangedFiles = files;
    const unsafePage = {
      ...document,
      pages: document.pages.map((page) => ({
        ...page,
        filePaths: ["../outside.tsx"],
      })),
    };
    const rejected = await built.combinedToolHandler("update_project_design", {
      document: unsafePage,
    });
    expect(rejected).toMatchObject({ isError: true });
    expect((rejected as { text: string }).text).toContain("path");
    expect(files).toBe(unchangedFiles);
    expect(onProjectDesignUpdated).not.toHaveBeenCalled();
    const created = await built.combinedToolHandler("update_project_design", {
      document,
    });
    expect(created).toMatchObject({
      structuredContent: { ok: true, revision: 1 },
    });
    expect(files["design-project.json"]).toContain('"revision": 1');
    expect(onProjectDesignUpdated).toHaveBeenLastCalledWith(files);

    const createdFiles = files;
    const hostRun = HOST_TOOL_CATALOG.openRun({
      tools: { update_project_design: DESIGN_HOST_TOOLS.update_project_design },
      profile: "design",
      context: {
        runId: "blueprint-patch",
        mode: "chat",
        platform: "web",
        runtime: "api",
        allowedMcpAliases: new Set(),
        activeSkillIds: new Set(),
        approvedSkillScriptHashes: new Set(),
        policyVersion: "test",
      },
      hostDispatcher: ({ name, input }) =>
        built.combinedToolHandler(name, input),
    });
    const dispatch = (input: unknown) =>
      hostRun.dispatch({ name: "update_project_design", input });
    const partial = await dispatch({
      expected_revision: 1,
      patch: {
        buildProgress: { percent: 10 },
        pages: [{ id: "dashboard", name: "Updated dashboard" }],
      },
    });
    expect(partial).toMatchObject({
      structuredContent: { ok: true, revision: 2, pages: 1 },
    });
    expect(JSON.parse(files["design-project.json"])).toMatchObject({
      productGoal: document.productGoal,
      buildProgress: { status: "not-started", percent: 10 },
    });
    files = createdFiles;

    const recovered = await dispatch({
      expected_revision: 1,
      document: {
        revision: 2,
        pages: document.pages.map((page) => ({
          ...page,
          flowIds: [...page.flowIds, "wantlist"],
        })),
      },
    });
    expect(recovered).toMatchObject({
      structuredContent: {
        ok: true,
        flows: 1,
        warnings: expect.arrayContaining([expect.stringContaining("wantlist")]),
      },
    });
    files = createdFiles;

    const previousNotifications = onProjectDesignUpdated.mock.calls.length;
    const summary = await dispatch({
      expected_revision: 1,
      document: { revision: 2, pageCount: 1, flowCount: 1 },
    });
    expect(summary).toMatchObject({ isError: true });
    expect((summary as { text: string }).text).toContain("summary");
    expect(files).toBe(createdFiles);
    expect(onProjectDesignUpdated).toHaveBeenCalledTimes(previousNotifications);

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
