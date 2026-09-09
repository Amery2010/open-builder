import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Cloud,
  Copy,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
} from "lucide-react";
import type { AISettings } from "../../../store/settings";
import { useSettingsStore } from "../../../store/settings";
import type {
  LocalAgentPreference,
  LocalAgentProbe,
} from "../../../lib/local-agent/types";
import {
  LOCAL_AGENT_PROVIDER_CATALOG,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "../../../lib/local-agent/providers";
import {
  chooseLocalAgentExecutable,
  clearLocalAgentExecutable,
} from "../../../lib/local-agent/tauri";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useResolvedLocale, useT, type ResolvedLocale } from "../../../i18n";

const DEFAULT_OPTION = "default:";

function formatCheckedAt(timestamp: number, locale: ResolvedLocale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function describePreference(
  preference: LocalAgentPreference,
  cliDefault: string,
): string {
  return (
    [preference.model, preference.effort].filter(Boolean).join(" · ") ||
    cliDefault
  );
}
const MODEL_OPTION_PREFIX = "model:";
const EFFORT_OPTION_PREFIX = "effort:";

function encodeOption(prefix: string, value: string) {
  return `${prefix}${value}`;
}

function decodeOption(prefix: string, value: string) {
  return value.startsWith(prefix) ? value.slice(prefix.length) : "";
}
type LocalAgentSettingsValue = AISettings["localAgent"];
type LocalAgentOperation = (
  provider: LocalAgentProvider,
  preference: LocalAgentPreference,
) => Promise<LocalAgentProbe | null>;

interface LocalAgentSettingsProps {
  value: LocalAgentSettingsValue;
  onChange: (value: LocalAgentSettingsValue) => void;
  supported: boolean;
  runtimeChangeLocked?: boolean;
}

export function LocalAgentSettings({
  value,
  onChange,
  supported,
  runtimeChangeLocked = false,
}: LocalAgentSettingsProps) {
  const t = useT();
  const locale = useResolvedLocale();
  const provider = value.provider;
  const providerDefinition = LOCAL_AGENT_PROVIDER_CATALOG[provider];
  const preferences = value.preferences[provider];
  const observation = useSettingsStore(
    (state) => state.localCliObservationCache.providers[provider],
  );
  const ensureLocalCliObservation = useSettingsStore(
    (state) => state.ensureLocalCliObservation,
  );
  const refreshLocalCliObservation = useSettingsStore(
    (state) => state.refreshLocalCliObservation,
  );
  const recordLocalCliProbe = useSettingsStore(
    (state) => state.recordLocalCliProbe,
  );
  const markPreferenceVerificationRequired = useSettingsStore(
    (state) => state.markLocalCliPreferenceVerificationRequired,
  );
  const [isLoading, setIsLoading] = useState(supported && !observation);
  const [actionError, setActionError] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<"success" | "error" | null>(
    null,
  );
  const [replacedPreference, setReplacedPreference] = useState<{
    previous: LocalAgentPreference;
    next: LocalAgentPreference;
  } | null>(null);
  const requestSequenceRef = useRef(0);
  const providerRef = useRef(provider);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  providerRef.current = provider;
  valueRef.current = value;
  onChangeRef.current = onChange;

  const applyObservedPreference = useCallback(
    (
      expectedProvider: LocalAgentProvider,
      expectedPreference: LocalAgentPreference,
      replacement: LocalAgentPreference,
    ) => {
      const current = valueRef.current;
      if (current.provider !== expectedProvider) return;
      const currentPreference = current.preferences[expectedProvider];
      if (
        currentPreference.model !== expectedPreference.model ||
        currentPreference.effort !== expectedPreference.effort
      ) {
        return;
      }

      if (
        currentPreference.model === replacement.model &&
        currentPreference.effort === replacement.effort
      ) {
        return;
      }

      const next: LocalAgentSettingsValue = {
        ...current,
        preferences: {
          ...current.preferences,
          [expectedProvider]: replacement,
        },
      };
      valueRef.current = next;
      onChangeRef.current(next);
      setReplacedPreference({ previous: currentPreference, next: replacement });
    },
    [],
  );

  const runInspection = useCallback(
    async (forceRefresh: boolean) => {
      if (!supported) return;
      const expectedProvider = provider;
      const expectedPreference = {
        ...valueRef.current.preferences[expectedProvider],
      };
      const requestId = ++requestSequenceRef.current;
      setIsLoading(true);
      setActionError("");
      setCopyFeedback(null);
      try {
        const result = forceRefresh
          ? await refreshLocalCliObservation(
              expectedProvider,
              expectedPreference,
            )
          : await ensureLocalCliObservation(
              expectedProvider,
              expectedPreference,
            );
        if (
          requestId !== requestSequenceRef.current ||
          providerRef.current !== expectedProvider
        ) {
          return;
        }
        if (!result || result.provider !== expectedProvider) {
          setActionError(t.settings.localCli.probeMismatch);
          return;
        }
        if (result.status !== "verificationRequired") {
          applyObservedPreference(
            expectedProvider,
            expectedPreference,
            result.inspectedPreference,
          );
        }
      } catch {
        if (
          requestId !== requestSequenceRef.current ||
          providerRef.current !== expectedProvider
        ) {
          return;
        }
        setActionError(t.settings.localCli.probeFailed);
      } finally {
        if (
          requestId === requestSequenceRef.current &&
          providerRef.current === expectedProvider
        ) {
          setIsLoading(false);
        }
      }
    },
    [
      applyObservedPreference,
      ensureLocalCliObservation,
      provider,
      refreshLocalCliObservation,
      supported,
      t.settings.localCli.probeMismatch,
      t.settings.localCli.probeFailed,
    ],
  );

  useEffect(() => {
    if (!supported) {
      requestSequenceRef.current += 1;
      setActionError("");
      setCopyFeedback(null);
      setIsLoading(false);
      return;
    }
    const cached =
      useSettingsStore.getState().localCliObservationCache.providers[provider];
    if (cached) {
      setIsLoading(false);
      setActionError("");
      setCopyFeedback(null);
      void ensureLocalCliObservation(provider, {
        ...valueRef.current.preferences[provider],
      });
      return;
    }
    void runInspection(false);
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [ensureLocalCliObservation, provider, runInspection, supported]);

  const updatePreferences = (
    patch: Partial<(typeof value.preferences)[typeof provider]>,
  ) => {
    const current = valueRef.current;
    const next: LocalAgentSettingsValue = {
      ...current,
      preferences: {
        ...current.preferences,
        [provider]: {
          ...current.preferences[provider],
          ...patch,
        },
      },
    };
    valueRef.current = next;
    onChangeRef.current(next);
    setReplacedPreference(null);
    markPreferenceVerificationRequired(provider);
  };

  const selectProvider = (nextProvider: LocalAgentProvider) => {
    if (nextProvider === providerRef.current) return;
    requestSequenceRef.current += 1;
    providerRef.current = nextProvider;
    setActionError("");
    setCopyFeedback(null);
    setReplacedPreference(null);
    const current = valueRef.current;
    const next: LocalAgentSettingsValue = {
      ...current,
      provider: nextProvider,
    };
    valueRef.current = next;
    onChangeRef.current(next);
  };

  const efforts = useMemo(() => {
    if (observation?.capabilities.reasoning !== true) return [];
    const selected = preferences.model
      ? observation.models.find((model) => model.id === preferences.model)
      : observation.models.find((model) => model.isDefault);
    if (preferences.model && !selected) return [];
    return selected ? selected.efforts : (observation?.efforts ?? []);
  }, [preferences.model, observation]);

  const hasUnverifiedModel =
    observation?.verificationRequired === true &&
    Boolean(preferences.model) &&
    !observation.models.some((model) => model.id === preferences.model);

  const runExecutableOperation = useCallback(
    async (operation: LocalAgentOperation) => {
      const expectedProvider = provider;
      const expectedPreference = {
        ...valueRef.current.preferences[expectedProvider],
      };
      const requestId = ++requestSequenceRef.current;
      setIsLoading(true);
      setActionError("");
      setCopyFeedback(null);
      try {
        const result = await operation(expectedProvider, expectedPreference);
        if (result?.provider === expectedProvider) {
          // Executable selection mutates backend state even if the user changes
          // the visible Provider before the dialog resolves.
          recordLocalCliProbe(result, expectedPreference);
        }
        if (
          requestId !== requestSequenceRef.current ||
          providerRef.current !== expectedProvider
        ) {
          return;
        }
        if (!result) return;
        if (result.provider !== expectedProvider) {
          setActionError(t.settings.localCli.probeMismatch);
          return;
        }
        if (result.preferenceDecision.kind === "replace") {
          applyObservedPreference(
            expectedProvider,
            expectedPreference,
            result.preferenceDecision.preference,
          );
        }
      } catch {
        if (
          requestId === requestSequenceRef.current &&
          providerRef.current === expectedProvider
        ) {
          setActionError(t.settings.localCli.probeFailed);
        }
      } finally {
        if (
          requestId === requestSequenceRef.current &&
          providerRef.current === expectedProvider
        ) {
          setIsLoading(false);
        }
      }
    },
    [
      applyObservedPreference,
      provider,
      recordLocalCliProbe,
      t.settings.localCli.probeFailed,
      t.settings.localCli.probeMismatch,
    ],
  );

  const chooseExecutable = () =>
    runExecutableOperation((expectedProvider, expectedPreference) =>
      chooseLocalAgentExecutable(expectedProvider, expectedPreference),
    );

  const clearExecutable = () =>
    runExecutableOperation((expectedProvider, expectedPreference) =>
      clearLocalAgentExecutable(expectedProvider, expectedPreference),
    );

  const copySetupCommand = async () => {
    if (!observation?.setupCommand) return;
    setCopyFeedback(null);
    try {
      await navigator.clipboard.writeText(observation.setupCommand);
      setCopyFeedback("success");
    } catch {
      setCopyFeedback("error");
    }
  };

  if (!supported) {
    return (
      <div
        className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
        role="status"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-600"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium">{t.settings.localCli.desktopOnly}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t.settings.localCli.desktopOnlyDesc}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const status = observation?.status ?? "unavailable";
  const ready = status === "ready";
  const verificationRequired = status === "verificationRequired";
  const needsSetup = status === "setupRequired";
  const notFound = observation?.reasonCode === "notFound";
  const unavailable = status === "unavailable" || Boolean(actionError);
  const showLoading = isLoading || (supported && !observation && !actionError);
  const canEditPreferences = ready || verificationRequired || needsSetup;
  const statusLabel = ready
    ? t.settings.localCli.ready
    : verificationRequired
      ? t.settings.localCli.verificationRequired
      : needsSetup
        ? t.settings.localCli.needsSetup
        : notFound
          ? t.settings.localCli.notFound
          : t.settings.localCli.unavailable;
  const missingEnvironment =
    needsSetup && observation?.missingEnvironment
      ? observation.missingEnvironment
      : [];
  const [missingEnvironmentLead, missingEnvironmentTail] =
    t.settings.localCli.missingEnvironmentHint.split("{variables}");
  const probeDetail = ready
    ? t.settings.localCli.probeDetails.ready
    : verificationRequired
      ? t.settings.localCli.probeDetails.verificationRequired
      : needsSetup
        ? t.settings.localCli.probeDetails.setupRequired
        : t.settings.localCli.probeDetails.unavailable;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="local-agent-provider">
          <TerminalSquare size={16} className="mr-1 inline" />
          {t.settings.localCli.provider}
        </Label>
        <Select
          value={provider}
          disabled={runtimeChangeLocked}
          onValueChange={(nextProvider) =>
            selectProvider(nextProvider as LocalAgentProvider)
          }
        >
          <SelectTrigger id="local-agent-provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCAL_AGENT_PROVIDERS.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <section
        className={cn(
          "rounded-lg border p-3.5",
          ready
            ? "border-emerald-500/30 bg-emerald-500/10"
            : verificationRequired || needsSetup || notFound
              ? "border-amber-500/30 bg-amber-500/10"
              : unavailable
                ? "border-destructive/30 bg-destructive/5"
                : "border-border bg-muted/30",
        )}
        aria-live="polite"
        aria-labelledby="local-cli-status-heading"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            {showLoading ? (
              <TerminalSquare
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            ) : ready ? (
              <CheckCircle2
                className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            ) : unavailable ? (
              <CircleX
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
            ) : (
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 flex-1">
              <p id="local-cli-status-heading" className="text-sm font-medium">
                {providerDefinition.displayName}
              </p>
              {showLoading ? (
                <div className="mt-1.5 space-y-2" role="status">
                  <span className="sr-only">
                    {t.settings.localCli.scanning}
                  </span>
                  <div className="h-3 w-28 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
                  <div className="h-3 w-3/4 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
                </div>
              ) : (
                <p
                  className={cn(
                    "mt-0.5 text-xs font-medium",
                    ready
                      ? "text-emerald-700 dark:text-emerald-300"
                      : verificationRequired || needsSetup || notFound
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-destructive",
                  )}
                >
                  {statusLabel}
                </p>
              )}

              {!showLoading && observation?.path ? (
                <div className="mt-2 rounded-md bg-background/70 px-2.5 py-2 dark:bg-background/40">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {t.settings.localCli.executablePath}
                  </p>
                  <code className="mt-0.5 block break-all text-xs text-foreground">
                    {observation.path}
                  </code>
                </div>
              ) : null}
              {!showLoading && observation?.version ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">
                    {t.settings.localCli.version}:
                  </span>{" "}
                  {observation.version}
                </p>
              ) : null}
              {!showLoading && observation ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {probeDetail}
                </p>
              ) : null}
              {!showLoading && observation?.checkedAt ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">
                    {t.settings.localCli.lastChecked}:
                  </span>{" "}
                  {formatCheckedAt(observation.checkedAt, locale)}
                </p>
              ) : null}
              {!showLoading && needsSetup && provider === "pi" ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t.settings.localCli.piSetupHint}
                </p>
              ) : null}
              {!showLoading && missingEnvironment.length > 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {missingEnvironmentLead}
                  <code className="font-mono text-foreground">
                    {missingEnvironment.join(", ")}
                  </code>
                  {missingEnvironmentTail}
                </p>
              ) : null}
              {replacedPreference ? (
                <p
                  role="status"
                  className="mt-2 text-xs text-amber-700 dark:text-amber-300"
                >
                  {t.settings.localCli.preferenceReplaced
                    .replace(
                      "{previous}",
                      describePreference(
                        replacedPreference.previous,
                        t.settings.localCli.cliDefault,
                      ),
                    )
                    .replace("{provider}", providerDefinition.displayName)
                    .replace(
                      "{next}",
                      describePreference(
                        replacedPreference.next,
                        t.settings.localCli.cliDefault,
                      ),
                    )}
                </p>
              ) : null}
              {actionError ? (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {actionError}
                </p>
              ) : null}
              {copyFeedback === "success" ? (
                <p
                  role="status"
                  className="mt-2 text-xs text-emerald-700 dark:text-emerald-300"
                >
                  {t.settings.localCli.copied}
                </p>
              ) : copyFeedback === "error" ? (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {t.settings.localCli.copyFailed}
                </p>
              ) : null}
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 px-2"
            onClick={() => void runInspection(true)}
            disabled={showLoading}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t.settings.localCli.rescan}
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2 border-t border-current/10 pt-3">
          {needsSetup ? (
            <Button
              type="button"
              size="sm"
              onClick={() => void copySetupCommand()}
              disabled={showLoading}
            >
              <Copy className="size-3.5" aria-hidden="true" />
              {t.settings.localCli.copySetup}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={notFound || unavailable ? "default" : "outline"}
            onClick={() => void chooseExecutable()}
            disabled={showLoading}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            {t.settings.localCli.chooseExecutable}
          </Button>
          {observation?.pathSource === "override" ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void clearExecutable()}
              disabled={showLoading}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t.settings.localCli.useAutoDetect}
            </Button>
          ) : null}
        </div>
      </section>

      <section
        className="space-y-3"
        aria-labelledby="local-cli-defaults-heading"
      >
        <div>
          <h3 id="local-cli-defaults-heading" className="text-sm font-medium">
            {t.settings.localCli.defaults}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t.settings.localCli.modelHint}
          </p>
        </div>
        <div
          className={cn(
            "grid gap-3",
            efforts.length > 0 ? "sm:grid-cols-2" : "grid-cols-1",
          )}
        >
          <div className="min-w-0 space-y-2">
            <Label htmlFor="local-agent-model">
              {t.settings.localCli.model} ({providerDefinition.modelName})
            </Label>
            <Select
              value={
                preferences.model
                  ? encodeOption(MODEL_OPTION_PREFIX, preferences.model)
                  : DEFAULT_OPTION
              }
              disabled={showLoading || !canEditPreferences}
              onValueChange={(nextValue) =>
                updatePreferences({
                  model:
                    nextValue === DEFAULT_OPTION
                      ? ""
                      : decodeOption(MODEL_OPTION_PREFIX, nextValue),
                  effort: "",
                })
              }
            >
              <SelectTrigger id="local-agent-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_OPTION}>
                  {t.settings.localCli.cliDefault}
                </SelectItem>
                {hasUnverifiedModel ? (
                  <SelectItem
                    value={encodeOption(MODEL_OPTION_PREFIX, preferences.model)}
                  >
                    {preferences.model} ({t.settings.localCli.unverified})
                  </SelectItem>
                ) : null}
                {(observation?.models ?? []).map((model) => (
                  <SelectItem
                    key={model.id}
                    value={encodeOption(MODEL_OPTION_PREFIX, model.id)}
                  >
                    {model.displayName || model.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {efforts.length > 0 ? (
            <div className="min-w-0 space-y-2">
              <Label htmlFor="local-agent-effort">
                {t.settings.localCli.effort}
              </Label>
              <Select
                value={
                  preferences.effort
                    ? encodeOption(EFFORT_OPTION_PREFIX, preferences.effort)
                    : DEFAULT_OPTION
                }
                disabled={showLoading || !canEditPreferences}
                onValueChange={(nextValue) =>
                  updatePreferences({
                    effort:
                      nextValue === DEFAULT_OPTION
                        ? ""
                        : decodeOption(EFFORT_OPTION_PREFIX, nextValue),
                  })
                }
              >
                <SelectTrigger id="local-agent-effort" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_OPTION}>
                    {t.settings.localCli.cliDefault}
                  </SelectItem>
                  {efforts.map((effort) => (
                    <SelectItem
                      key={effort}
                      value={encodeOption(EFFORT_OPTION_PREFIX, effort)}
                    >
                      {effort}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
      </section>

      <aside className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
        <Cloud
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div>
          <p className="text-xs font-medium text-foreground">
            {t.settings.localCli.dataNotice}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t.settings.localCli.cloudNotice}
          </p>
        </div>
      </aside>
    </div>
  );
}
