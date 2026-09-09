import { describe, expect, it, vi } from "vitest";
import {
  createEmptyLocalCliObservationCache,
  createLocalCliObservationCoordinator,
  isLocalCliObservationCache,
  markLocalCliPreferenceVerificationRequired,
  mergeLocalCliFailure,
  mergeLocalCliPreparedMetadata,
  sanitizeLocalCliObservationCache,
  sanitizeLocalCliProbe,
  type LocalCliObservationCache,
} from "./observations";
import type {
  LocalAgentPreference,
  LocalAgentProbe,
  LocalCliFailure,
  LocalCliPreparedMetadata,
} from "./types";
import type { LocalAgentProvider } from "./providers";

function probe(overrides: Partial<LocalAgentProbe> = {}): LocalAgentProbe {
  return {
    provider: "codex",
    availability: "ready",
    status: "ready",
    path: "/usr/local/bin/codex",
    pathSource: "path",
    version: "codex 1.2.3",
    installationFingerprint: "install-1",
    catalogAuthority: "authoritative",
    setupCommand: "codex login",
    models: [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT 5.6 Sol",
        isDefault: true,
        defaultEffort: "high",
        efforts: ["low", "high"],
      },
    ],
    efforts: ["low", "high"],
    preferenceDecision: { kind: "keep", unverified: false },
    capabilities: {
      sessions: true,
      reasoning: true,
      tools: true,
      nativeSearch: true,
    },
    ...overrides,
  };
}

function failure(
  code: LocalCliFailure["code"],
  provider: LocalCliFailure["provider"] = "codex",
): LocalCliFailure {
  return {
    code,
    phase: "prepare",
    provider,
    safeMessage: "A safe message",
    diagnosticId: "diagnostic-1",
    hadActivity: false,
    hadHostSideEffect: false,
    retryPolicy: "manual",
  };
}

describe("Local CLI observation cache", () => {
  it("keeps model names that merely mention credential words", () => {
    const observation = sanitizeLocalCliProbe(
      probe({
        models: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT 5.6 Sol token efficient",
            isDefault: true,
            defaultEffort: "high",
            efforts: ["low", "high"],
          },
        ],
      }),
      { model: "gpt-5.6-sol", effort: "high" },
      123,
    );

    expect(observation?.models[0]?.displayName).toBe(
      "GPT 5.6 Sol token efficient",
    );
  });

  it("persists only sanitized display metadata", () => {
    const observation = sanitizeLocalCliProbe(
      probe({
        message: "token=super-secret",
        setupCommand: "codex login --token super-secret",
      }),
      { model: "gpt-5.6-sol", effort: "high" },
      123,
    );

    expect(observation).toMatchObject({
      provider: "codex",
      path: "/usr/local/bin/codex",
      version: "codex 1.2.3",
      inspectedPreference: { model: "gpt-5.6-sol", effort: "high" },
      checkedAt: 123,
    });
    expect(observation).not.toHaveProperty("message");
    expect(JSON.stringify(observation)).not.toContain("super-secret");
    expect(observation?.setupCommand).toBe("codex login --token [redacted]");
  });

  it("keeps only well-formed missing credential variable names", () => {
    const observation = sanitizeLocalCliProbe(
      probe({
        availability: "needsSetup",
        status: "setupRequired",
        missingEnvironment: [
          "PROXY_TOKEN",
          "PROXY_TOKEN",
          "not a name",
          "x".repeat(80),
          "",
        ],
      }),
      { model: "", effort: "" },
    );
    expect(observation?.missingEnvironment).toEqual(["PROXY_TOKEN"]);
    expect(
      sanitizeLocalCliProbe(probe(), { model: "", effort: "" }),
    ).not.toHaveProperty("missingEnvironment");

    const empty = createEmptyLocalCliObservationCache();
    expect(
      sanitizeLocalCliObservationCache({
        ...empty,
        providers: {
          codex: { ...observation, missingEnvironment: ["not a name"] },
        },
      }),
    ).toEqual(empty);
  });

  it("keeps legacy capability caches explicitly unverified", () => {
    const observation = sanitizeLocalCliProbe(
      probe(),
      { model: "", effort: "" },
      123,
    );

    expect(observation?.capabilities).toMatchObject({
      imageGeneration: false,
      imageEditing: false,
      mediaCapabilitiesVerified: false,
    });

    const legacy = {
      schemaVersion: 1,
      host: null,
      providers: {
        codex: {
          ...observation!,
          capabilities: {
            sessions: true,
            reasoning: true,
            tools: true,
            nativeSearch: true,
          },
        },
      },
    };
    expect(isLocalCliObservationCache(legacy)).toBe(true);
    expect(
      sanitizeLocalCliObservationCache(legacy).providers.codex?.capabilities,
    ).toMatchObject({
      imageGeneration: false,
      imageEditing: false,
      mediaCapabilitiesVerified: false,
    });
  });

  it("bounds large catalogs while retaining the selected and default models", () => {
    const models = Array.from({ length: 140 }, (_, index) => ({
      id: `model-${index}`,
      displayName: `Model ${index}`,
      isDefault: index === 138,
      efforts: Array.from(
        { length: 20 },
        (_value, effort) => `effort-${effort}`,
      ),
    }));

    const observation = sanitizeLocalCliProbe(
      probe({ models, catalogAuthority: "authoritative" }),
      { model: "model-139", effort: "effort-19" },
      123,
    );

    expect(observation?.models).toHaveLength(128);
    expect(observation?.models[0]?.id).toBe("model-139");
    expect(observation?.models.some((model) => model.id === "model-138")).toBe(
      true,
    );
    expect(observation?.models[0]?.efforts).toHaveLength(16);
    expect(observation?.catalogAuthority).toBe("partial");
  });

  it("discards unknown and malformed cache schemas", () => {
    const empty = createEmptyLocalCliObservationCache();
    expect(isLocalCliObservationCache(empty)).toBe(true);
    expect(
      sanitizeLocalCliObservationCache({
        ...empty,
        schemaVersion: 2,
      }),
    ).toEqual(empty);
    expect(
      sanitizeLocalCliObservationCache({
        ...empty,
        providers: { codex: { status: "loading" } },
      }),
    ).toEqual(empty);
  });

  it("marks changed preferences without losing installation/catalog data", () => {
    const observation = sanitizeLocalCliProbe(
      probe(),
      { model: "", effort: "" },
      10,
    );
    const cache = {
      ...createEmptyLocalCliObservationCache(),
      providers: { codex: observation! },
    };
    const next = markLocalCliPreferenceVerificationRequired(cache, "codex");

    expect(next.providers.codex).toMatchObject({
      status: "verificationRequired",
      verificationRequired: true,
      path: "/usr/local/bin/codex",
      installationFingerprint: "install-1",
      models: [{ id: "gpt-5.6-sol" }],
      inspectedPreference: { model: "", effort: "" },
    });
  });

  it("merges successful prepared metadata and only durable failures", async () => {
    const observation = sanitizeLocalCliProbe(
      probe(),
      { model: "", effort: "" },
      10,
    );
    const cache = {
      ...createEmptyLocalCliObservationCache(),
      providers: { codex: observation! },
    };
    const metadata: LocalCliPreparedMetadata = {
      compatibilityKey: "compat-1",
      installationFingerprint: "install-2",
      cliVersion: "codex 2.0.0",
      actualModel: "gpt-5.6-sol",
      actualEffort: "high",
      resumed: false,
    };
    const ready = mergeLocalCliPreparedMetadata(cache, "codex", metadata, 20);
    expect(ready.providers.codex).toMatchObject({
      status: "ready",
      verificationRequired: false,
      installationFingerprint: "install-2",
      version: "codex 2.0.0",
      inspectedPreference: { model: "", effort: "" },
      checkedAt: 20,
    });
    expect(
      mergeLocalCliPreparedMetadata(cache, "codex", metadata, 21, {
        model: "configured-model",
        effort: "max",
      }).providers.codex?.inspectedPreference,
    ).toEqual({ model: "configured-model", effort: "max" });

    let preparedCache: LocalCliObservationCache = {
      ...ready,
      host: { status: "supported", checkedAt: 20 },
    };
    const inspectProvider = vi.fn(async () => probe());
    const coordinator = createLocalCliObservationCoordinator(
      {
        get: () => preparedCache,
        set: (next) => (preparedCache = next),
      },
      { queryHost: vi.fn(async () => true), inspectProvider },
    );
    await expect(
      coordinator.ensureProvider("codex", { model: "", effort: "" }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(inspectProvider).not.toHaveBeenCalled();

    expect(mergeLocalCliFailure(ready, failure("timeout"), 30)).toEqual(ready);
    expect(
      mergeLocalCliFailure(ready, failure("executableNotFound"), 40).providers
        .codex,
    ).toMatchObject({
      status: "unavailable",
      reasonCode: "notFound",
      checkedAt: 40,
    });
    expect(
      mergeLocalCliFailure(ready, failure("credentialRejected"), 50).providers
        .codex,
    ).toMatchObject({ status: "setupRequired", checkedAt: 50 });
    expect(
      mergeLocalCliFailure(ready, failure("modelRejected"), 60).providers.codex,
    ).toMatchObject({
      status: "verificationRequired",
      verificationRequired: true,
      checkedAt: 60,
    });
  });

  it("uses cached host/provider observations without invoking the backend", async () => {
    const cached = sanitizeLocalCliProbe(
      probe(),
      { model: "", effort: "" },
      10,
    )!;
    let cache: LocalCliObservationCache = {
      ...createEmptyLocalCliObservationCache(),
      host: { status: "supported" as const, checkedAt: 10 },
      providers: { codex: cached },
    };
    const queryHost = vi.fn(async () => true);
    const inspectProvider = vi.fn(async () => probe());
    const coordinator = createLocalCliObservationCoordinator(
      { get: () => cache, set: (next) => (cache = next) },
      { queryHost, inspectProvider },
    );

    await expect(coordinator.ensureHost()).resolves.toEqual(cache.host);
    await expect(
      coordinator.ensureProvider("codex", { model: "", effort: "" }),
    ).resolves.toEqual(cached);
    expect(queryHost).not.toHaveBeenCalled();
    expect(inspectProvider).not.toHaveBeenCalled();
  });

  it("marks a cached observation for verification when the selected preference changed", async () => {
    const cached = sanitizeLocalCliProbe(
      probe(),
      { model: "old-model", effort: "low" },
      10,
    )!;
    let cache: LocalCliObservationCache = {
      ...createEmptyLocalCliObservationCache(),
      host: { status: "supported", checkedAt: 10 },
      providers: { codex: cached },
    };
    const inspectProvider = vi.fn(async () => probe());
    const coordinator = createLocalCliObservationCoordinator(
      { get: () => cache, set: (next) => (cache = next) },
      { queryHost: vi.fn(async () => true), inspectProvider },
    );

    await expect(
      coordinator.ensureProvider("codex", {
        model: "new-model",
        effort: "high",
      }),
    ).resolves.toMatchObject({
      status: "verificationRequired",
      inspectedPreference: { model: "old-model", effort: "low" },
    });
    expect(inspectProvider).not.toHaveBeenCalled();
  });

  it("single-flights concurrent host and same-preference provider checks", async () => {
    let cache: LocalCliObservationCache = createEmptyLocalCliObservationCache();
    let resolveHost!: (value: boolean) => void;
    const queryHost = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveHost = resolve;
        }),
    );
    let resolveProbe!: (value: LocalAgentProbe) => void;
    const inspectProvider = vi.fn(
      () =>
        new Promise<LocalAgentProbe>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const coordinator = createLocalCliObservationCoordinator(
      { get: () => cache, set: (next) => (cache = next) },
      { queryHost, inspectProvider },
    );

    const preference = { model: "gpt-5.6-sol", effort: "high" };
    const first = coordinator.ensureProvider("codex", preference);
    const second = coordinator.ensureProvider("codex", preference);
    expect(queryHost).toHaveBeenCalledTimes(1);
    resolveHost(true);
    await vi.waitFor(() => expect(inspectProvider).toHaveBeenCalledTimes(1));
    resolveProbe(probe());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(inspectProvider).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh forced Host check and ignores the older in-flight result", async () => {
    let cache: LocalCliObservationCache = createEmptyLocalCliObservationCache();
    const resolvers: Array<(value: boolean) => void> = [];
    const queryHost = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const resetHostCache = vi.fn();
    const coordinator = createLocalCliObservationCoordinator(
      { get: () => cache, set: (next) => (cache = next) },
      {
        queryHost,
        resetHostCache,
        inspectProvider: vi.fn(async () => probe()),
      },
    );

    const stale = coordinator.ensureHost();
    const forced = coordinator.ensureHost(true);
    expect(queryHost).toHaveBeenCalledTimes(2);
    expect(resetHostCache).toHaveBeenCalledTimes(1);
    resolvers[1](true);
    await forced;
    resolvers[0](false);
    await stale;
    expect(cache.host?.status).toBe("supported");
  });

  it("rejects mismatched Provider results and preserves an in-flight inspect across transient failures", async () => {
    let cache: LocalCliObservationCache = {
      ...createEmptyLocalCliObservationCache(),
      host: { status: "supported", checkedAt: 1 },
    };
    let resolveProbe!: (value: LocalAgentProbe) => void;
    const inspectProvider = vi
      .fn<
        (
          provider: LocalAgentProvider,
          preference: LocalAgentPreference,
          forceRefresh: boolean,
        ) => Promise<LocalAgentProbe>
      >()
      .mockResolvedValueOnce(probe({ provider: "claude" }))
      .mockImplementationOnce(
        () =>
          new Promise<LocalAgentProbe>((resolve) => {
            resolveProbe = resolve;
          }),
      );
    const coordinator = createLocalCliObservationCoordinator(
      { get: () => cache, set: (next) => (cache = next) },
      { queryHost: vi.fn(async () => true), inspectProvider },
    );

    await coordinator.ensureProvider("codex", { model: "", effort: "" });
    expect(cache.providers.codex).toMatchObject({
      provider: "codex",
      status: "unavailable",
      reasonCode: "probeError",
    });
    expect(cache.providers.claude).toBeUndefined();

    coordinator.invalidateProvider("codex");
    const pending = coordinator.ensureProvider(
      "codex",
      { model: "", effort: "" },
      true,
    );
    coordinator.mergeFailure(failure("timeout"));
    await vi.waitFor(() => expect(inspectProvider).toHaveBeenCalledTimes(2));
    resolveProbe(probe({ version: "fresh" }));
    await pending;
    expect(cache.providers.codex).toMatchObject({
      status: "ready",
      version: "fresh",
    });
  });

  it("single-flights missing observations and ignores stale provider results", async () => {
    let cache: LocalCliObservationCache = createEmptyLocalCliObservationCache();
    const queryHost = vi.fn(async () => true);
    let resolveFirst!: (value: LocalAgentProbe) => void;
    let resolveSecond!: (value: LocalAgentProbe) => void;
    const first = new Promise<LocalAgentProbe>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<LocalAgentProbe>((resolve) => {
      resolveSecond = resolve;
    });
    const inspectProvider = vi
      .fn<
        (
          provider: LocalAgentProvider,
          preference: LocalAgentPreference,
          forceRefresh: boolean,
        ) => Promise<LocalAgentProbe>
      >()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const coordinator = createLocalCliObservationCoordinator(
      { get: () => cache, set: (next) => (cache = next) },
      { queryHost, inspectProvider },
    );

    const firstRequest = coordinator.ensureProvider(
      "codex",
      { model: "first", effort: "low" },
      true,
    );
    const secondRequest = coordinator.ensureProvider(
      "codex",
      { model: "second", effort: "high" },
      true,
    );
    resolveSecond(probe({ provider: "codex", version: "second" }));
    await secondRequest;
    resolveFirst(probe({ provider: "codex", version: "first" }));
    await firstRequest;

    expect(inspectProvider).toHaveBeenCalledTimes(2);
    expect(cache.providers.codex?.version).toBe("second");
  });
});
