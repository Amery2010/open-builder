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
    vi.clearAllMocks();
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

    secondLoad.useSettingsStore.setState((state) => ({
      localCliObservationCache: {
        ...state.localCliObservationCache,
        host: { status: "supported", checkedAt: 1 },
      },
    }));
    secondLoad.useSettingsStore.getState().recordLocalCliProbe({
      provider: "codex",
      availability: "ready",
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
    secondLoad.useSettingsStore.getState().resetAll();
    expect(
      secondLoad.useSettingsStore.getState().localCliObservationCache,
    ).toEqual({ schemaVersion: 1, host: null, providers: {} });
    await vi.waitFor(() => {
      expect(records.get("open-builder-settings")).not.toContain(
        "sk-local-persistence-test",
      );
    });
  });

  it("treats a selected Local CLI as configured independently of host observations", async () => {
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

    // Selecting a valid local CLI is a configured runtime. The host check is
    // display state and does not gate the chat send path.
    expect(useSettingsStore.getState().isAIConfigured()).toBe(true);
    await expect(
      useSettingsStore.getState().ensureLocalCliHostObservation(true),
    ).resolves.toMatchObject({ status: "error" });
    expect(
      useSettingsStore.getState().localCliObservationCache.host?.status,
    ).toBe("error");
    expect(useSettingsStore.getState().isAIConfigured()).toBe(true);

    await expect(
      useSettingsStore.getState().ensureLocalCliHostObservation(true),
    ).resolves.toMatchObject({ status: "supported" });
    useSettingsStore.getState().recordLocalCliProbe({
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
    expect(useSettingsStore.getState().isAIConfigured()).toBe(true);

    await expect(
      useSettingsStore.getState().ensureLocalCliHostObservation(true),
    ).resolves.toMatchObject({ status: "unsupported" });
    expect(useSettingsStore.getState().isAIConfigured()).toBe(true);
    expect(localAgentSupportMocks.reset).toHaveBeenCalledTimes(3);
  });

  it("keeps API runtime configuration validation unchanged", async () => {
    const { storage } = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const { useSettingsStore } = await import("./index");

    useSettingsStore.getState().setAI({
      ...useSettingsStore.getState().ai,
      runtime: "api",
      apiKey: "",
      apiBaseUrl: "https://api.example.com/v1",
      model: "example-model",
    });
    expect(useSettingsStore.getState().isAIConfigured()).toBe(false);

    useSettingsStore.getState().setAI({
      ...useSettingsStore.getState().ai,
      apiKey: "sk-test",
    });
    expect(useSettingsStore.getState().isAIConfigured()).toBe(true);
  });

  it("persists sanitized provider observations while treating verification as display state", async () => {
    const { storage } = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const { useSettingsStore } = await import("./index");
    useSettingsStore.getState().setAI({
      ...useSettingsStore.getState().ai,
      runtime: "localCli",
      localAgent: {
        ...useSettingsStore.getState().ai.localAgent,
        provider: "claude",
      },
    });
    expect(useSettingsStore.getState().isAIConfigured()).toBe(true);
    useSettingsStore.getState().recordLocalCliProbe({
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
    expect(
      useSettingsStore.getState().localCliObservationCache.providers.claude
        ?.status,
    ).toBe("verificationRequired");
    expect(useSettingsStore.getState().isAIConfigured()).toBe(true);
    expect(storage.getItem("open-builder-settings")).toContain(
      "verificationRequired",
    );
  });

  it("reuses a persisted host observation without invoking Tauri again", async () => {
    const { records, storage } = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    localAgentSupportMocks.query.mockResolvedValueOnce(true);

    const { useSettingsStore } = await import("./index");
    await expect(
      useSettingsStore.getState().ensureLocalCliHostObservation(),
    ).resolves.toMatchObject({ status: "supported" });
    expect(localAgentSupportMocks.query).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const secondLoad = await import("./index");
    await secondLoad.useSettingsStore.persist.rehydrate();
    await expect(
      secondLoad.useSettingsStore.getState().ensureLocalCliHostObservation(),
    ).resolves.toMatchObject({ status: "supported" });
    expect(localAgentSupportMocks.query).toHaveBeenCalledTimes(1);
    expect(records.get("open-builder-settings")).toContain(
      "localCliObservationCache",
    );
  });

  it("sanitizes an invalid same-version cache during hydration", async () => {
    const { storage } = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(
      "open-builder-settings",
      JSON.stringify({
        state: {
          localCliObservationCache: {
            schemaVersion: 2,
            host: { status: "supported", checkedAt: 1 },
            providers: {},
          },
        },
        version: 22,
      }),
    );

    const { useSettingsStore } = await import("./index");
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().localCliObservationCache).toEqual({
      schemaVersion: 1,
      host: null,
      providers: {},
    });
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
