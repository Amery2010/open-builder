import { describe, expect, it } from "vitest";
import { DEFAULT_OPENAI_MODEL } from "../../lib/ai/provider-config";
import { migrateSettings, SETTINGS_VERSION } from "./migrations";

describe("migrateSettings", () => {
  it("fills only empty OpenAI-family model settings", () => {
    const compatible = migrateSettings(
      { ai: { apiType: "openai-compatible", model: "" } },
      16,
    ) as Record<string, any>;
    const openai = migrateSettings(
      { ai: { apiType: "openai", model: "   " } },
      16,
    ) as Record<string, any>;
    const custom = migrateSettings(
      { ai: { apiType: "openai-compatible", model: "local-model" } },
      16,
    ) as Record<string, any>;
    const anthropic = migrateSettings(
      { ai: { apiType: "anthropic", model: "" } },
      16,
    ) as Record<string, any>;

    expect(compatible.ai.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(openai.ai.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(custom.ai.model).toBe("local-model");
    expect(anthropic.ai.model).toBe("");
  });

  it("preserves plaintext API keys from older persisted settings", () => {
    const migrated = migrateSettings(
      {
        ai: {
          apiType: "openai-compatible",
          apiKey: "sk-test",
          apiBaseUrl: "https://api.example.com",
          model: "test-model",
        },
        system: {},
      },
      8,
    ) as { ai: { apiKey: string } };

    expect(migrated.ai.apiKey).toBe("sk-test");
  });

  it("adds missing system defaults for older persisted settings", () => {
    const migrated = migrateSettings({ ai: {} }, 4) as {
      system: {
        reverseProxy: boolean;
        planModeEnabled: boolean;
        autoQaEnabled: boolean;
        developerSkillScriptsEnabled: boolean;
        customSystemPrompt: string;
      };
    };

    expect(migrated.system.reverseProxy).toBe(false);
    expect(migrated.system.planModeEnabled).toBe(false);
    expect(migrated.system.autoQaEnabled).toBe(false);
    expect(migrated.system.developerSkillScriptsEnabled).toBe(false);
    expect(migrated.system.customSystemPrompt).toBe("");
  });

  it("adds custom prompts without overwriting an existing value", () => {
    expect(SETTINGS_VERSION).toBe(20);
    const missing = migrateSettings({ system: {} }, 17) as Record<string, any>;
    const existing = migrateSettings(
      { system: { customSystemPrompt: "Keep changes surgical." } },
      17,
    ) as Record<string, any>;

    expect(missing.system.customSystemPrompt).toBe("");
    expect(existing.system.customSystemPrompt).toBe("Keep changes surgical.");
  });

  it("adds the Exa key without changing existing search engine choices", () => {
    const engines = ["disabled", "tavily", "firecrawl", "builtin"] as const;

    for (const engine of engines) {
      const migrated = migrateSettings(
        { webSearch: { engine, firecrawlApiKey: "existing-key" } },
        18,
      ) as Record<string, any>;

      expect(migrated.webSearch).toMatchObject({
        engine,
        firecrawlApiKey: "existing-key",
        exaApiKey: "",
      });
    }
  });

  it("removes legacy server settings without changing local providers", () => {
    const migrated = migrateSettings(
      {
        ai: { model: "local-model" },
        webSearch: {
          engine: "server",
          backendProvider: "remote-search",
          tavilyApiKey: "local-search-key",
        },
        assetSearch: {
          engine: "server",
          backendProvider: "remote-assets",
          pixabayApiKey: "local-asset-key",
        },
        serverService: { selectedModel: "remote-model" },
        serverServiceCache: { models: ["remote-model"] },
        modelCache: { apiKey: "legacy-cache-key" },
      },
      11,
    ) as Record<string, any>;

    expect(migrated.ai.model).toBe("local-model");
    expect(migrated.webSearch).toMatchObject({
      engine: "disabled",
      tavilyApiKey: "local-search-key",
    });
    expect(migrated.assetSearch).toMatchObject({
      engine: "disabled",
      pixabayApiKey: "local-asset-key",
    });
    expect(migrated.webSearch).not.toHaveProperty("backendProvider");
    expect(migrated.assetSearch).not.toHaveProperty("backendProvider");
    expect(migrated).not.toHaveProperty("serverService");
    expect(migrated).not.toHaveProperty("serverServiceCache");
    expect(migrated).not.toHaveProperty("modelCache");
  });

  it("removes custom search endpoints while preserving provider settings", () => {
    const migrated = migrateSettings(
      {
        webSearch: {
          engine: "tavily",
          tavilyApiKey: "local-search-key",
          tavilyApiUrl: "https://search.example.com",
          firecrawlApiKey: "local-reader-key",
          firecrawlApiUrl: "https://reader.example.com",
        },
        assetSearch: {
          engine: "pixabay",
          pixabayApiKey: "local-asset-key",
          pixabayApiUrl: "https://images.example.com",
          unsplashApiKey: "local-photo-key",
          unsplashApiUrl: "https://photos.example.com",
        },
      },
      13,
    ) as Record<string, any>;

    expect(migrated.webSearch).toMatchObject({
      engine: "tavily",
      tavilyApiKey: "local-search-key",
      firecrawlApiKey: "local-reader-key",
    });
    expect(migrated.assetSearch).toMatchObject({
      engine: "pixabay",
      pixabayApiKey: "local-asset-key",
      unsplashApiKey: "local-photo-key",
    });
    expect(migrated.webSearch).not.toHaveProperty("tavilyApiUrl");
    expect(migrated.webSearch).not.toHaveProperty("firecrawlApiUrl");
    expect(migrated.assetSearch).not.toHaveProperty("pixabayApiUrl");
    expect(migrated.assetSearch).not.toHaveProperty("unsplashApiUrl");
  });

  it("adds local CLI defaults without changing existing API configuration", () => {
    const migrated = migrateSettings(
      {
        ai: {
          apiType: "anthropic",
          apiKey: "existing-key",
          apiBaseUrl: "https://api.anthropic.com",
          model: "existing-model",
        },
      },
      15,
    ) as Record<string, any>;

    expect(migrated.ai).toMatchObject({
      runtime: "api",
      apiType: "anthropic",
      apiKey: "existing-key",
      apiBaseUrl: "https://api.anthropic.com",
      model: "existing-model",
      localAgent: {
        provider: "codex",
        preferences: {
          codex: { model: "", effort: "" },
          claude: { model: "", effort: "" },
          pi: { model: "", effort: "" },
        },
      },
    });
  });

  it("preserves valid provider-specific local CLI preferences", () => {
    const migrated = migrateSettings(
      {
        ai: {
          runtime: "localCli",
          localAgent: {
            provider: "claude",
            codex: { model: "codex-model", effort: "high" },
            claude: { model: "claude-model", effort: "medium" },
          },
        },
      },
      15,
    ) as Record<string, any>;

    expect(migrated.ai).toMatchObject({
      runtime: "localCli",
      localAgent: {
        provider: "claude",
        preferences: {
          codex: { model: "codex-model", effort: "high" },
          claude: { model: "claude-model", effort: "medium" },
          pi: { model: "", effort: "" },
        },
      },
    });
  });

  it("migrates every v19 Codex and Claude preference into the provider record", () => {
    const migrated = migrateSettings(
      {
        ai: {
          runtime: "localCli",
          localAgent: {
            provider: "claude",
            codex: { model: "gpt-5.6-sol", effort: "high" },
            claude: { model: "claude-opus-4-1", effort: "max" },
          },
        },
      },
      19,
    ) as Record<string, any>;

    expect(migrated.ai.localAgent).toEqual({
      provider: "claude",
      preferences: {
        codex: { model: "gpt-5.6-sol", effort: "high" },
        claude: { model: "claude-opus-4-1", effort: "max" },
        pi: { model: "", effort: "" },
      },
    });
    expect(migrated.ai.localAgent).not.toHaveProperty("codex");
    expect(migrated.ai.localAgent).not.toHaveProperty("claude");
  });
});
