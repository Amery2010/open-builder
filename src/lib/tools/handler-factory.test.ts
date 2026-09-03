import { describe, expect, it, vi } from "vitest";
import { buildToolHandlers } from "./handler-factory";

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
});
