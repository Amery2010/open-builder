import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./providers";
import { normalizeLocalCliProbe, redactLocalCliMessage } from "./runtime";
import type {
  LocalAgentModel,
  LocalAgentPreference,
  LocalAgentProbe,
  LocalCliCatalogAuthority,
  LocalCliFailure,
  LocalCliInspectionStatus,
  LocalCliPreparedMetadata,
  LocalCliUnavailableReason,
} from "./types";

/**
 * Persisted local-CLI observations are display data, not launch authority.
 * The backend still performs the preflight check for every run.
 */
export const LOCAL_CLI_OBSERVATION_SCHEMA_VERSION = 1 as const;

export type LocalCliHostObservationStatus =
  "supported" | "unsupported" | "error";

export type LocalCliPathSource = "override" | "path" | "common";

export interface PersistedLocalCliHostObservation {
  status: LocalCliHostObservationStatus;
  checkedAt: number;
}

export interface PersistedLocalCliObservation {
  provider: LocalAgentProvider;
  status: LocalCliInspectionStatus;
  reasonCode?: LocalCliUnavailableReason;
  path?: string;
  pathSource?: LocalCliPathSource;
  modelDirectory?: string;
  version?: string;
  installationFingerprint?: string;
  catalogAuthority: LocalCliCatalogAuthority;
  models: LocalAgentModel[];
  efforts: string[];
  capabilities: LocalAgentProbe["capabilities"];
  setupCommand: string;
  /** Required credential variables the desktop process did not receive. */
  missingEnvironment?: string[];
  /** The preference used by the most recent inspect/prepared observation. */
  inspectedPreference: LocalAgentPreference;
  /** Explicitly persisted for consumers that do not interpret status. */
  verificationRequired: boolean;
  checkedAt: number;
}

export interface LocalCliObservationCache {
  schemaVersion: typeof LOCAL_CLI_OBSERVATION_SCHEMA_VERSION;
  host: PersistedLocalCliHostObservation | null;
  providers: Partial<Record<LocalAgentProvider, PersistedLocalCliObservation>>;
}

const LOCAL_CLI_INSPECTION_STATUSES: readonly LocalCliInspectionStatus[] = [
  "ready",
  "verificationRequired",
  "setupRequired",
  "unavailable",
];

const LOCAL_CLI_HOST_STATUSES: readonly LocalCliHostObservationStatus[] = [
  "supported",
  "unsupported",
  "error",
];

const LOCAL_CLI_UNAVAILABLE_REASONS: readonly LocalCliUnavailableReason[] = [
  "notFound",
  "unsupported",
  "hostUnsupported",
  "probeError",
];

const LOCAL_CLI_CATALOG_AUTHORITIES: readonly LocalCliCatalogAuthority[] = [
  "authoritative",
  "partial",
];

const LOCAL_CLI_PATH_SOURCES: readonly LocalCliPathSource[] = [
  "override",
  "path",
  "common",
];

const MAX_PERSISTED_MODELS = 128;
const MAX_PERSISTED_MODEL_EFFORTS = 16;
const MAX_PERSISTED_PROVIDER_EFFORTS = 64;
const MAX_PERSISTED_MISSING_ENVIRONMENT = 8;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_INSPECTED_MODELS = 4_096;
const MAX_INSPECTED_MODEL_EFFORTS = 64;

const EMPTY_CAPABILITIES: LocalAgentProbe["capabilities"] = {
  sessions: false,
  reasoning: false,
  tools: false,
  nativeSearch: false,
  imageGeneration: false,
  imageEditing: false,
  mediaCapabilitiesVerified: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return isString(value) && value.length <= maxLength;
}

function isEnvironmentName(value: unknown): value is string {
  return isString(value) && ENVIRONMENT_NAME.test(value);
}

function isEnvironmentNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PERSISTED_MISSING_ENVIRONMENT &&
    value.every(isEnvironmentName)
  );
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isPreference(value: unknown): value is LocalAgentPreference {
  return (
    isRecord(value) &&
    isBoundedString(value.model, 300) &&
    isBoundedString(value.effort, 100)
  );
}

function isModel(value: unknown): value is LocalAgentModel {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 300) &&
    isBoundedString(value.displayName, 300) &&
    typeof value.isDefault === "boolean" &&
    Array.isArray(value.efforts) &&
    value.efforts.length <= MAX_PERSISTED_MODEL_EFFORTS &&
    value.efforts.every((effort) => isBoundedString(effort, 100)) &&
    (value.defaultEffort === undefined ||
      isBoundedString(value.defaultEffort, 100))
  );
}

function isSanitizableModel(value: unknown): value is LocalAgentModel {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 300) &&
    isBoundedString(value.displayName, 300) &&
    typeof value.isDefault === "boolean" &&
    Array.isArray(value.efforts) &&
    value.efforts.length <= MAX_INSPECTED_MODEL_EFFORTS &&
    value.efforts.every((effort) => isBoundedString(effort, 100)) &&
    (value.defaultEffort === undefined ||
      isBoundedString(value.defaultEffort, 100))
  );
}

function isCapabilities(
  value: unknown,
): value is LocalAgentProbe["capabilities"] {
  return (
    isRecord(value) &&
    typeof value.sessions === "boolean" &&
    typeof value.reasoning === "boolean" &&
    typeof value.tools === "boolean" &&
    typeof value.nativeSearch === "boolean" &&
    (value.imageGeneration === undefined ||
      typeof value.imageGeneration === "boolean") &&
    (value.imageEditing === undefined ||
      typeof value.imageEditing === "boolean") &&
    (value.mediaCapabilitiesVerified === undefined ||
      typeof value.mediaCapabilitiesVerified === "boolean")
  );
}

function cleanCapabilities(
  value: LocalAgentProbe["capabilities"],
): LocalAgentProbe["capabilities"] {
  return {
    sessions: value.sessions,
    reasoning: value.reasoning,
    tools: value.tools,
    nativeSearch: value.nativeSearch,
    imageGeneration: value.imageGeneration === true,
    imageEditing: value.imageEditing === true,
    mediaCapabilitiesVerified: value.mediaCapabilitiesVerified === true,
  };
}

function isPersistedLocalCliHostObservation(
  value: unknown,
): value is PersistedLocalCliHostObservation {
  return (
    isRecord(value) &&
    isOneOf(value.status, LOCAL_CLI_HOST_STATUSES) &&
    isFiniteTimestamp(value.checkedAt)
  );
}

/** Validate a single persisted observation without trusting unknown fields. */
export function isPersistedLocalCliObservation(
  value: unknown,
  expectedProvider?: LocalAgentProvider,
): value is PersistedLocalCliObservation {
  if (!isRecord(value)) return false;
  if (!isLocalAgentProvider(value.provider)) return false;
  if (expectedProvider && value.provider !== expectedProvider) return false;
  return (
    isOneOf(value.status, LOCAL_CLI_INSPECTION_STATUSES) &&
    (value.reasonCode === undefined ||
      isOneOf(value.reasonCode, LOCAL_CLI_UNAVAILABLE_REASONS)) &&
    (value.path === undefined || isBoundedString(value.path, 2_048)) &&
    (value.pathSource === undefined ||
      isOneOf(value.pathSource, LOCAL_CLI_PATH_SOURCES)) &&
    (value.modelDirectory === undefined ||
      isBoundedString(value.modelDirectory, 2_048)) &&
    (value.version === undefined || isBoundedString(value.version, 300)) &&
    (value.installationFingerprint === undefined ||
      isBoundedString(value.installationFingerprint, 300)) &&
    isOneOf(value.catalogAuthority, LOCAL_CLI_CATALOG_AUTHORITIES) &&
    Array.isArray(value.models) &&
    value.models.length <= MAX_PERSISTED_MODELS &&
    value.models.every(isModel) &&
    Array.isArray(value.efforts) &&
    value.efforts.length <= MAX_PERSISTED_PROVIDER_EFFORTS &&
    value.efforts.every((effort) => isBoundedString(effort, 100)) &&
    isCapabilities(value.capabilities) &&
    isBoundedString(value.setupCommand, 600) &&
    (value.missingEnvironment === undefined ||
      isEnvironmentNames(value.missingEnvironment)) &&
    isPreference(value.inspectedPreference) &&
    typeof value.verificationRequired === "boolean" &&
    isFiniteTimestamp(value.checkedAt)
  );
}

/**
 * A strict schema check used during settings hydration. A future schema is
 * intentionally rejected as a whole so unrecognized fields cannot become
 * accidental launch authority.
 */
export function isLocalCliObservationCache(
  value: unknown,
): value is LocalCliObservationCache {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (value.host !== null && !isPersistedLocalCliHostObservation(value.host)) {
    return false;
  }
  if (!isRecord(value.providers)) return false;
  return Object.entries(value.providers).every(([provider, observation]) => {
    return (
      isLocalAgentProvider(provider) &&
      isPersistedLocalCliObservation(observation, provider)
    );
  });
}

export function createEmptyLocalCliObservationCache(): LocalCliObservationCache {
  return {
    schemaVersion: LOCAL_CLI_OBSERVATION_SCHEMA_VERSION,
    host: null,
    providers: {},
  };
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function cleanModel(value: LocalAgentModel): LocalAgentModel {
  return {
    id: redactLocalCliMessage(value.id.slice(0, 300)),
    displayName: redactLocalCliMessage(value.displayName.slice(0, 300)),
    isDefault: value.isDefault,
    ...(value.defaultEffort
      ? {
          defaultEffort: redactLocalCliMessage(
            value.defaultEffort.slice(0, 100),
          ),
        }
      : {}),
    efforts: value.efforts
      .slice(0, MAX_PERSISTED_MODEL_EFFORTS)
      .map((effort) => redactLocalCliMessage(effort.slice(0, 100)))
      .filter(Boolean),
  };
}

function cleanModelCatalog(
  values: LocalAgentModel[],
  preferredModel: string,
): { models: LocalAgentModel[]; truncated: boolean } {
  const inspected = values.slice(0, MAX_INSPECTED_MODELS);
  const valid = inspected.filter(isSanitizableModel);
  const ordered: LocalAgentModel[] = [];
  const seen = new Set<string>();
  const add = (model: LocalAgentModel | undefined) => {
    if (
      !model ||
      seen.has(model.id) ||
      ordered.length >= MAX_PERSISTED_MODELS
    ) {
      return;
    }
    seen.add(model.id);
    ordered.push(model);
  };

  if (preferredModel) {
    add(valid.find((model) => model.id === preferredModel));
  }
  for (const model of valid) {
    if (model.isDefault) add(model);
  }
  for (const model of valid) add(model);

  return {
    models: ordered.map(cleanModel),
    truncated:
      values.length > inspected.length ||
      valid.length < inspected.length ||
      ordered.length < valid.length ||
      valid.some((model) => model.efforts.length > MAX_PERSISTED_MODEL_EFFORTS),
  };
}

function cleanPreference(
  preference: LocalAgentPreference,
): LocalAgentPreference {
  return {
    model: redactLocalCliMessage(preference.model.slice(0, 300)),
    effort: redactLocalCliMessage(preference.effort.slice(0, 100)),
  };
}

/** Convert backend probe data to the deliberately small persisted shape. */
export function sanitizeLocalCliProbe(
  probe: LocalAgentProbe,
  inspectedPreference: LocalAgentPreference,
  now = Date.now(),
): PersistedLocalCliObservation | null {
  if (!isLocalAgentProvider(probe.provider)) return null;
  const preferenceDecision = probe.preferenceDecision;
  const preference = cleanPreference(
    preferenceDecision?.kind === "replace"
      ? preferenceDecision.preference
      : inspectedPreference,
  );
  const unverified =
    preferenceDecision?.kind === "keep" &&
    preferenceDecision.unverified === true;
  const inspection = normalizeLocalCliProbe(probe);
  const status =
    unverified && inspection.status === "ready"
      ? "verificationRequired"
      : inspection.status;
  const reasonCode = inspection.reasonCode;
  const rawProbe = probe as LocalAgentProbe & {
    modelDirectory?: unknown;
    model_directory?: unknown;
  };
  const modelDirectory = boundedString(
    rawProbe.modelDirectory ?? rawProbe.model_directory,
    2_048,
  );
  const modelCatalog = cleanModelCatalog(
    Array.isArray(probe.models) ? probe.models : [],
    preference.model,
  );
  const rawProviderEfforts = Array.isArray(probe.efforts) ? probe.efforts : [];
  const providerEfforts = rawProviderEfforts
    .slice(0, MAX_PERSISTED_PROVIDER_EFFORTS + 1)
    .filter(isString);
  const catalogTruncated =
    modelCatalog.truncated ||
    rawProviderEfforts.length > MAX_PERSISTED_PROVIDER_EFFORTS ||
    providerEfforts.length !== rawProviderEfforts.length;
  const missingEnvironment = Array.isArray(probe.missingEnvironment)
    ? [...new Set(probe.missingEnvironment.filter(isEnvironmentName))].slice(
        0,
        MAX_PERSISTED_MISSING_ENVIRONMENT,
      )
    : [];
  return {
    provider: probe.provider,
    status,
    ...(reasonCode ? { reasonCode } : {}),
    ...(boundedString(probe.path, 2_048)
      ? { path: boundedString(probe.path, 2_048) }
      : {}),
    ...(isOneOf(probe.pathSource, LOCAL_CLI_PATH_SOURCES)
      ? { pathSource: probe.pathSource }
      : {}),
    ...(modelDirectory ? { modelDirectory } : {}),
    ...(boundedString(probe.version, 300)
      ? { version: redactLocalCliMessage(boundedString(probe.version, 300)!) }
      : {}),
    ...(boundedString(probe.installationFingerprint, 300)
      ? {
          installationFingerprint: redactLocalCliMessage(
            boundedString(probe.installationFingerprint, 300)!,
          ),
        }
      : {}),
    catalogAuthority:
      !catalogTruncated &&
      isOneOf(probe.catalogAuthority, LOCAL_CLI_CATALOG_AUTHORITIES)
        ? probe.catalogAuthority
        : "partial",
    models: modelCatalog.models,
    efforts: providerEfforts
      .slice(0, MAX_PERSISTED_PROVIDER_EFFORTS)
      .map((effort) => redactLocalCliMessage(effort.slice(0, 100)))
      .filter(Boolean),
    capabilities: isCapabilities(probe.capabilities)
      ? cleanCapabilities(probe.capabilities)
      : { ...EMPTY_CAPABILITIES },
    setupCommand: redactLocalCliMessage(
      boundedString(probe.setupCommand, 600) ?? "",
    ),
    ...(missingEnvironment.length > 0 ? { missingEnvironment } : {}),
    inspectedPreference: preference,
    verificationRequired: status === "verificationRequired" || unverified,
    checkedAt: isFiniteTimestamp(probe.checkedAt) ? probe.checkedAt : now,
  };
}

/**
 * Sanitize a hydrated cache. Invalid or unknown schemas are discarded as one
 * unit; partial caches would make their provenance impossible to reason about.
 */
export function sanitizeLocalCliObservationCache(
  value: unknown,
): LocalCliObservationCache {
  if (!isLocalCliObservationCache(value)) {
    return createEmptyLocalCliObservationCache();
  }

  const providers: Partial<
    Record<LocalAgentProvider, PersistedLocalCliObservation>
  > = {};
  for (const provider of LOCAL_AGENT_PROVIDERS) {
    const observation = value.providers[provider.id as LocalAgentProvider];
    if (!observation) continue;
    providers[observation.provider] = {
      provider: observation.provider,
      status: observation.status,
      ...(observation.reasonCode ? { reasonCode: observation.reasonCode } : {}),
      ...(observation.path ? { path: observation.path.slice(0, 2_048) } : {}),
      ...(observation.pathSource ? { pathSource: observation.pathSource } : {}),
      ...(observation.modelDirectory
        ? { modelDirectory: observation.modelDirectory.slice(0, 2_048) }
        : {}),
      ...(observation.version
        ? { version: redactLocalCliMessage(observation.version.slice(0, 300)) }
        : {}),
      ...(observation.installationFingerprint
        ? {
            installationFingerprint: redactLocalCliMessage(
              observation.installationFingerprint.slice(0, 300),
            ),
          }
        : {}),
      catalogAuthority: observation.catalogAuthority,
      models: observation.models.map(cleanModel),
      efforts: observation.efforts
        .map((effort) => redactLocalCliMessage(effort.slice(0, 100)))
        .filter(Boolean),
      capabilities: cleanCapabilities(observation.capabilities),
      setupCommand: redactLocalCliMessage(
        observation.setupCommand.slice(0, 600),
      ),
      inspectedPreference: cleanPreference(observation.inspectedPreference),
      verificationRequired: observation.verificationRequired,
      checkedAt: observation.checkedAt,
    };
  }

  return {
    schemaVersion: LOCAL_CLI_OBSERVATION_SCHEMA_VERSION,
    host: value.host ? { ...value.host } : null,
    providers,
  };
}

export function getLocalCliObservation(
  cache: LocalCliObservationCache,
  provider: LocalAgentProvider,
): PersistedLocalCliObservation | undefined {
  return cache.providers[provider];
}

export function markLocalCliPreferenceVerificationRequired(
  cache: LocalCliObservationCache,
  provider: LocalAgentProvider,
): LocalCliObservationCache {
  const current = cache.providers[provider];
  if (!current) return cache;
  return {
    ...cache,
    providers: {
      ...cache.providers,
      [provider]: {
        ...current,
        status: "verificationRequired",
        reasonCode: undefined,
        // This remains the preference used by the last real inspection. The
        // newly selected preference lives in AISettings until a future probe.
        inspectedPreference: current.inspectedPreference,
        verificationRequired: true,
        checkedAt: current.checkedAt,
      },
    },
  };
}

function emptyObservation(
  provider: LocalAgentProvider,
  preference: LocalAgentPreference,
  now: number,
): PersistedLocalCliObservation {
  return {
    provider,
    status: "unavailable",
    reasonCode: "probeError",
    catalogAuthority: "partial",
    models: [],
    efforts: [],
    capabilities: { ...EMPTY_CAPABILITIES },
    setupCommand: "",
    inspectedPreference: cleanPreference(preference),
    verificationRequired: false,
    checkedAt: now,
  };
}

export function mergeLocalCliPreparedMetadata(
  cache: LocalCliObservationCache,
  provider: LocalAgentProvider,
  metadata: LocalCliPreparedMetadata,
  now = Date.now(),
  verifiedPreference?: LocalAgentPreference,
): LocalCliObservationCache {
  const current =
    cache.providers[provider] ??
    emptyObservation(provider, { model: "", effort: "" }, now);
  return {
    ...cache,
    providers: {
      ...cache.providers,
      [provider]: {
        ...current,
        status: "ready",
        reasonCode: undefined,
        ...(metadata.installationFingerprint
          ? {
              installationFingerprint: redactLocalCliMessage(
                metadata.installationFingerprint.slice(0, 300),
              ),
            }
          : {}),
        ...(metadata.cliVersion
          ? {
              version: redactLocalCliMessage(metadata.cliVersion.slice(0, 300)),
            }
          : {}),
        inspectedPreference: cleanPreference(
          verifiedPreference ?? current.inspectedPreference,
        ),
        verificationRequired: false,
        checkedAt: now,
      },
    },
  };
}

const UNAVAILABLE_FAILURES: Partial<
  Record<LocalCliFailure["code"], LocalCliUnavailableReason>
> = {
  executableNotFound: "notFound",
  cliUnsupported: "unsupported",
} as const;

const SETUP_FAILURES = new Set(["setupRequired", "credentialRejected"]);
const VERIFICATION_FAILURES = new Set([
  "installationChanged",
  "modelRejected",
  "selectionRejected",
]);

/** Merge only durable launch-state failures; transient run failures are ignored. */
export function mergeLocalCliFailure(
  cache: LocalCliObservationCache,
  failure: LocalCliFailure,
  now = Date.now(),
): LocalCliObservationCache {
  if (!isLocalAgentProvider(failure.provider)) return cache;
  const unavailableReason = UNAVAILABLE_FAILURES[failure.code];
  const isSetup = SETUP_FAILURES.has(failure.code);
  const isVerification = VERIFICATION_FAILURES.has(failure.code);
  if (!unavailableReason && !isSetup && !isVerification) return cache;

  const current =
    cache.providers[failure.provider] ??
    emptyObservation(failure.provider, { model: "", effort: "" }, now);
  const status: LocalCliInspectionStatus = unavailableReason
    ? "unavailable"
    : isSetup
      ? "setupRequired"
      : "verificationRequired";
  return {
    ...cache,
    providers: {
      ...cache.providers,
      [failure.provider]: {
        ...current,
        status,
        ...(unavailableReason
          ? { reasonCode: unavailableReason }
          : { reasonCode: undefined }),
        verificationRequired: status === "verificationRequired",
        checkedAt: now,
      },
    },
  };
}

export function invalidateLocalCliObservation(
  cache: LocalCliObservationCache,
  provider?: LocalAgentProvider,
): LocalCliObservationCache {
  if (!provider) return createEmptyLocalCliObservationCache();
  if (!cache.providers[provider]) return cache;
  const providers = { ...cache.providers };
  delete providers[provider];
  return { ...cache, providers };
}

export interface LocalCliObservationStore {
  get: () => LocalCliObservationCache;
  set: (cache: LocalCliObservationCache) => void;
}

export interface LocalCliObservationCoordinatorDependencies {
  queryHost: () => Promise<boolean>;
  resetHostCache?: () => void;
  inspectProvider: (
    provider: LocalAgentProvider,
    preference: LocalAgentPreference,
    forceRefresh: boolean,
  ) => Promise<LocalAgentProbe>;
  now?: () => number;
}

export interface LocalCliObservationCoordinator {
  ensureHost: (
    forceRefresh?: boolean,
  ) => Promise<PersistedLocalCliHostObservation>;
  ensureProvider: (
    provider: LocalAgentProvider,
    preference: LocalAgentPreference,
    forceRefresh?: boolean,
  ) => Promise<PersistedLocalCliObservation | undefined>;
  refreshProvider: (
    provider: LocalAgentProvider,
    preference: LocalAgentPreference,
  ) => Promise<PersistedLocalCliObservation | undefined>;
  recordProbe: (
    probe: LocalAgentProbe,
    inspectedPreference: LocalAgentPreference,
  ) => PersistedLocalCliObservation | undefined;
  invalidateProvider: (provider?: LocalAgentProvider) => void;
  mergePrepared: (
    provider: LocalAgentProvider,
    metadata: LocalCliPreparedMetadata,
    verifiedPreference?: LocalAgentPreference,
  ) => void;
  mergeFailure: (failure: LocalCliFailure) => void;
  markPreference: (provider: LocalAgentProvider) => void;
}

function preferenceKey(preference: LocalAgentPreference): string {
  return `${preference.model}\u0000${preference.effort}`;
}

function hostObservation(
  status: LocalCliHostObservationStatus,
  now: number,
): PersistedLocalCliHostObservation {
  return { status, checkedAt: now };
}

function unavailableObservation(
  provider: LocalAgentProvider,
  preference: LocalAgentPreference,
  reasonCode: LocalCliUnavailableReason,
  now: number,
): PersistedLocalCliObservation {
  return {
    ...emptyObservation(provider, preference, now),
    reasonCode,
  };
}

/**
 * Store-backed cache coordinator. It owns cache-first semantics, single-flight
 * requests, and latest-request protection while leaving volatile loading state
 * to the caller.
 */
export function createLocalCliObservationCoordinator(
  store: LocalCliObservationStore,
  dependencies: LocalCliObservationCoordinatorDependencies,
): LocalCliObservationCoordinator {
  const now = dependencies.now ?? (() => Date.now());
  let hostRequest: Promise<PersistedLocalCliHostObservation> | null = null;
  let hostRequestSequence = 0;
  const providerRequests = new Map<
    LocalAgentProvider,
    {
      key: string;
      forceRefresh: boolean;
      sequence: number;
      promise: Promise<PersistedLocalCliObservation | undefined>;
    }
  >();
  const providerSequences = new Map<LocalAgentProvider, number>();

  const ensureHost = async (
    forceRefresh = false,
  ): Promise<PersistedLocalCliHostObservation> => {
    const cached = store.get().host;
    if (!forceRefresh && cached) return cached;
    if (hostRequest && !forceRefresh) return hostRequest;
    if (hostRequest && forceRefresh) {
      hostRequestSequence += 1;
      hostRequest = null;
    }
    if (forceRefresh) dependencies.resetHostCache?.();

    const sequence = ++hostRequestSequence;
    const request = (async () => {
      let result: PersistedLocalCliHostObservation;
      try {
        result = hostObservation(
          (await dependencies.queryHost()) ? "supported" : "unsupported",
          now(),
        );
      } catch {
        result = hostObservation("error", now());
      }
      if (sequence === hostRequestSequence) {
        store.set({ ...store.get(), host: result });
      }
      return result;
    })();
    hostRequest = request;
    void request.finally(() => {
      if (hostRequest === request) hostRequest = null;
    });
    return request;
  };

  const ensureProvider = async (
    provider: LocalAgentProvider,
    preference: LocalAgentPreference,
    forceRefresh = false,
  ): Promise<PersistedLocalCliObservation | undefined> => {
    if (!isLocalAgentProvider(provider)) return undefined;
    const cached = store.get().providers[provider];
    if (!forceRefresh && cached) {
      if (
        preferenceKey(cached.inspectedPreference) === preferenceKey(preference)
      ) {
        return cached;
      }
      const nextCache = markLocalCliPreferenceVerificationRequired(
        store.get(),
        provider,
      );
      store.set(nextCache);
      return nextCache.providers[provider];
    }

    const key = preferenceKey(preference);
    const existingRequest = providerRequests.get(provider);
    if (
      existingRequest?.key === key &&
      (!forceRefresh || existingRequest.forceRefresh)
    ) {
      return existingRequest.promise;
    }

    const sequence = (providerSequences.get(provider) ?? 0) + 1;
    providerSequences.set(provider, sequence);
    const request = (async () => {
      const host = await ensureHost(false);
      let result: PersistedLocalCliObservation;
      if (host.status !== "supported") {
        result = unavailableObservation(
          provider,
          preference,
          host.status === "unsupported" ? "hostUnsupported" : "probeError",
          now(),
        );
      } else {
        try {
          const probe = await dependencies.inspectProvider(
            provider,
            preference,
            forceRefresh,
          );
          result =
            probe.provider === provider
              ? (sanitizeLocalCliProbe(probe, preference, now()) ??
                unavailableObservation(
                  provider,
                  preference,
                  "probeError",
                  now(),
                ))
              : unavailableObservation(
                  provider,
                  preference,
                  "probeError",
                  now(),
                );
        } catch {
          result = unavailableObservation(
            provider,
            preference,
            "probeError",
            now(),
          );
        }
      }
      if (providerSequences.get(provider) === sequence) {
        store.set({
          ...store.get(),
          providers: { ...store.get().providers, [provider]: result },
        });
        return result;
      }
      return store.get().providers[provider];
    })();
    providerRequests.set(provider, {
      key,
      forceRefresh,
      sequence,
      promise: request,
    });
    void request.finally(() => {
      const current = providerRequests.get(provider);
      if (current?.promise === request) providerRequests.delete(provider);
    });
    return request;
  };

  return {
    ensureHost,
    ensureProvider,
    refreshProvider: (provider, preference) =>
      ensureProvider(provider, preference, true),
    recordProbe: (probe, inspectedPreference) => {
      if (!isLocalAgentProvider(probe.provider)) return undefined;
      providerSequences.set(
        probe.provider,
        (providerSequences.get(probe.provider) ?? 0) + 1,
      );
      const observation = sanitizeLocalCliProbe(
        probe,
        inspectedPreference,
        now(),
      );
      if (!observation) return undefined;
      store.set({
        ...store.get(),
        providers: {
          ...store.get().providers,
          [probe.provider]: observation,
        },
      });
      return observation;
    },
    invalidateProvider: (provider) => {
      if (provider) {
        providerRequests.delete(provider);
        providerSequences.set(
          provider,
          (providerSequences.get(provider) ?? 0) + 1,
        );
      } else {
        hostRequestSequence += 1;
        hostRequest = null;
        providerRequests.clear();
        for (const knownProvider of providerSequences.keys()) {
          providerSequences.set(
            knownProvider,
            (providerSequences.get(knownProvider) ?? 0) + 1,
          );
        }
      }
      store.set(invalidateLocalCliObservation(store.get(), provider));
    },
    mergePrepared: (provider, metadata, verifiedPreference) => {
      if (!isLocalAgentProvider(provider)) return;
      providerSequences.set(
        provider,
        (providerSequences.get(provider) ?? 0) + 1,
      );
      store.set(
        mergeLocalCliPreparedMetadata(
          store.get(),
          provider,
          metadata,
          now(),
          verifiedPreference,
        ),
      );
    },
    mergeFailure: (failure) => {
      const current = store.get();
      const next = mergeLocalCliFailure(current, failure, now());
      if (next === current) return;
      providerSequences.set(
        failure.provider,
        (providerSequences.get(failure.provider) ?? 0) + 1,
      );
      store.set(next);
    },
    markPreference: (provider) => {
      providerSequences.set(
        provider,
        (providerSequences.get(provider) ?? 0) + 1,
      );
      store.set(
        markLocalCliPreferenceVerificationRequired(store.get(), provider),
      );
    },
  };
}
