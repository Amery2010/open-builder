import { afterEach, describe, expect, it, vi } from "vitest";

const localAgentSupportMocks = vi.hoisted(() => ({
  query: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../../lib/local-agent/tauri", () => ({
  queryLocalAgentSupport: localAgentSupportMocks.query,
  resetLocalAgentSupportCache: localAgentSupportMocks.reset,
}));

function createMemoryStorage() {
  const records = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return records.size;
    },
    clear: vi.fn(() => records.clear()),
    getItem: vi.fn((key: string) => records.get(key) ?? null),
    key: vi.fn((index: number) => [...records.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => records.delete(key)),
    setItem: vi.fn((key: string, value: string) => records.set(key, value)),
  };

  return { records, storage };
}

describe("settings persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("persists the AI API key across reload and clears the test value", async () => {
    const { records, storage } = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);

    const firstLoad = await import("./index");
    firstLoad.useSettingsStore.getState().setAI({
      ...firstLoad.useSettingsStore.getState().ai,
      apiType: "openai-compatible",
      apiKey: "sk-local-persistence-test",
      apiBaseUrl: "https://api.example.com/v1",
      model: "test-model",
    });

    await vi.waitFor(() => {
      expect(records.get("open-builder-settings")).toContain(
        "sk-local-persistence-test",
      );
    });

    vi.resetModules();
    const secondLoad = await import("./index");
    await secondLoad.useSettingsStore.persist.rehydrate();

    expect(secondLoad.useSettingsStore.getState().ai.apiKey).toBe(
      "sk-local-persistence-test",
    );

    secondLoad.useSettingsStore.getState().resetAll();
    await vi.waitFor(() => {
      expect(records.get("open-builder-settings")).not.toContain(
        "sk-local-persistence-test",
      );
    });
  });

  it("fails closed until desktop local-agent capability is confirmed", async () => {
    const { storage } = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    localAgentSupportMocks.query
      .mockRejectedValueOnce(new Error("capability unavailable"))
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const { useSettingsStore } = await import("./index");
    useSettingsStore.getState().setAI({
      ...useSettingsStore.getState().ai,
      runtime: "localCli",
    });

    expect(useSettingsStore.getState().isAIValid()).toBe(false);
    await expect(
      useSettingsStore.getState().refreshLocalAgentCapability(true),
    ).resolves.toBe("error");
    expect(useSettingsStore.getState().localAgentCapability).toBe("error");
    expect(useSettingsStore.getState().isAIValid()).toBe(false);

    await expect(
      useSettingsStore.getState().refreshLocalAgentCapability(true),
    ).resolves.toBe("supported");
    useSettingsStore.getState().setLocalAgentProbe({
      provider: "codex",
      availability: "ready",
      status: "ready",
      setupCommand: "codex login",
      models: [],
      efforts: [],
      preferenceDecision: { kind: "keep", unverified: false },
      capabilities: {
        sessions: true,
        reasoning: true,
        tools: true,
        nativeSearch: true,
      },
    });
    expect(useSettingsStore.getState().isAIValid()).toBe(true);

    await expect(
      useSettingsStore.getState().refreshLocalAgentCapability(true),
    ).resolves.toBe("unsupported");
    expect(useSettingsStore.getState().isAIValid()).toBe(false);
    expect(localAgentSupportMocks.reset).toHaveBeenCalledTimes(3);
  });

  it("uses volatile per-provider readiness and allows verification-required runs", async () => {
    const { storage } = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const { useSettingsStore } = await import("./index");
    useSettingsStore.setState({ localAgentCapability: "supported" });
    useSettingsStore.getState().setAI({
      ...useSettingsStore.getState().ai,
      runtime: "localCli",
      localAgent: {
        ...useSettingsStore.getState().ai.localAgent,
        provider: "claude",
      },
    });
    expect(useSettingsStore.getState().isAIValid()).toBe(false);
    useSettingsStore.getState().setLocalAgentProbe({
      provider: "claude",
      availability: "ready",
      status: "verificationRequired",
      setupCommand: "claude login",
      models: [],
      efforts: [],
      preferenceDecision: { kind: "keep", unverified: true },
      capabilities: {
        sessions: true,
        reasoning: true,
        tools: true,
        nativeSearch: true,
      },
    });
    expect(useSettingsStore.getState().localAgentReadiness.claude?.status).toBe(
      "verificationRequired",
    );
    expect(useSettingsStore.getState().isAIValid()).toBe(true);
    expect(storage.getItem("open-builder-settings")).not.toContain(
      "verificationRequired",
    );
  });

  it("defaults and resets to keyless Firecrawl while requiring a key for Exa", async () => {
    const { storage } = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);

    const { useSettingsStore } = await import("./index");
    expect(useSettingsStore.getState().webSearch.engine).toBe("firecrawl");
    expect(useSettingsStore.getState().isWebSearchConfigured()).toBe(true);

    useSettingsStore.getState().setWebSearch({
      engine: "exa",
      tavilyApiKey: "",
      firecrawlApiKey: "",
      exaApiKey: "",
    });
    expect(useSettingsStore.getState().isWebSearchConfigured()).toBe(false);

    useSettingsStore.getState().setWebSearch({
      ...useSettingsStore.getState().webSearch,
      exaApiKey: "exa-test-key",
    });
    expect(useSettingsStore.getState().isWebSearchConfigured()).toBe(true);

    useSettingsStore.getState().resetAll();
    expect(useSettingsStore.getState().webSearch.engine).toBe("firecrawl");
  });
});
