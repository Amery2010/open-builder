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
import { localCliRuntime } from "../../../lib/local-agent/runtime";
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
import { useT } from "../../../i18n";

const DEFAULT_OPTION = "default:";
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
  const provider = value.provider;
  const providerDefinition = LOCAL_AGENT_PROVIDER_CATALOG[provider];
  const preferences = value.preferences[provider];
  const cachedReadiness = useSettingsStore(
    (state) => state.localAgentReadiness[provider],
  );
  const setLocalAgentProbe = useSettingsStore(
    (state) => state.setLocalAgentProbe,
  );
  const clearLocalAgentReadiness = useSettingsStore(
    (state) => state.clearLocalAgentReadiness,
  );
  const [probe, setProbe] = useState<LocalAgentProbe | null>(
    cachedReadiness?.probe ?? null,
  );
  const [isLoading, setIsLoading] = useState(supported);
  const [actionError, setActionError] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<"success" | "error" | null>(
    null,
  );
  const requestSequenceRef = useRef(0);
  const providerRef = useRef(provider);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  providerRef.current = provider;
  valueRef.current = value;
  onChangeRef.current = onChange;
  const visibleProbe = probe?.provider === provider ? probe : null;

  const applyPreferenceDecision = useCallback(
    (
      expectedProvider: LocalAgentProvider,
      expectedPreference: LocalAgentPreference,
      result: LocalAgentProbe,
    ) => {
      const decision = result.preferenceDecision;
      if (decision?.kind !== "replace") return;

      const current = valueRef.current;
      if (current.provider !== expectedProvider) return;
      const currentPreference = current.preferences[expectedProvider];
      if (
        currentPreference.model !== expectedPreference.model ||
        currentPreference.effort !== expectedPreference.effort
      ) {
        return;
      }

      const replacement = decision.preference;
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
    },
    [],
  );

  const runProbeOperation = useCallback(
    async (operation: LocalAgentOperation, clearCurrentProbe = false) => {
      if (!supported) return;
      const expectedProvider = provider;
      const expectedPreference = {
        ...valueRef.current.preferences[expectedProvider],
      };
      const requestId = ++requestSequenceRef.current;
      setIsLoading(true);
      setActionError("");
      setCopyFeedback(null);
      if (clearCurrentProbe) {
        setProbe(null);
        clearLocalAgentReadiness(expectedProvider);
      }
      try {
        const result = await operation(expectedProvider, expectedPreference);
        if (
          requestId !== requestSequenceRef.current ||
          providerRef.current !== expectedProvider
        ) {
          return;
        }
        if (result && result.provider !== expectedProvider) {
          setProbe(null);
          clearLocalAgentReadiness(expectedProvider);
          setActionError(t.settings.localCli.probeMismatch);
          return;
        }
        if (result) {
          setProbe(result);
          setLocalAgentProbe(result);
          applyPreferenceDecision(expectedProvider, expectedPreference, result);
        }
      } catch {
        if (
          requestId !== requestSequenceRef.current ||
          providerRef.current !== expectedProvider
        ) {
          return;
        }
        setProbe(null);
        clearLocalAgentReadiness(expectedProvider);
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
      applyPreferenceDecision,
      provider,
      supported,
      clearLocalAgentReadiness,
      setLocalAgentProbe,
      t.settings.localCli.probeMismatch,
      t.settings.localCli.probeFailed,
    ],
  );

  const refresh = useCallback(
    (forceRefresh = false) =>
      runProbeOperation(
        (expectedProvider, expectedPreference) =>
          localCliRuntime.inspect({
            provider: expectedProvider,
            preference: expectedPreference,
            forceRefresh,
          }),
        true,
      ),
    [runProbeOperation],
  );

  useEffect(() => {
    if (!supported) {
      requestSequenceRef.current += 1;
      setProbe(null);
      clearLocalAgentReadiness(provider);
      setActionError("");
      setCopyFeedback(null);
      setIsLoading(false);
      return;
    }
    void refresh(false);
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [clearLocalAgentReadiness, provider, refresh, supported]);

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
  };

  const selectProvider = (nextProvider: LocalAgentProvider) => {
    if (nextProvider === providerRef.current) return;
    requestSequenceRef.current += 1;
    providerRef.current = nextProvider;
    setProbe(null);
    clearLocalAgentReadiness(nextProvider);
    setActionError("");
    setCopyFeedback(null);
    setIsLoading(true);
    const current = valueRef.current;
    const next: LocalAgentSettingsValue = {
      ...current,
      provider: nextProvider,
    };
    valueRef.current = next;
    onChangeRef.current(next);
  };

  const efforts = useMemo(() => {
    if (visibleProbe?.capabilities.reasoning !== true) return [];
    const selected = preferences.model
      ? visibleProbe?.models.find((model) => model.id === preferences.model)
      : visibleProbe?.models.find((model) => model.isDefault);
    if (preferences.model && !selected) return [];
    return selected ? selected.efforts : (visibleProbe?.efforts ?? []);
  }, [preferences.model, visibleProbe]);

  const hasUnverifiedModel =
    visibleProbe?.preferenceDecision?.kind === "keep" &&
    visibleProbe.preferenceDecision?.unverified &&
    Boolean(preferences.model) &&
    !visibleProbe.models.some((model) => model.id === preferences.model);

  const chooseExecutable = () =>
    runProbeOperation((expectedProvider, expectedPreference) =>
      chooseLocalAgentExecutable(expectedProvider, expectedPreference),
    );

  const clearExecutable = () =>
    runProbeOperation((expectedProvider, expectedPreference) =>
      clearLocalAgentExecutable(expectedProvider, expectedPreference),
    );

  const copySetupCommand = async () => {
    if (!visibleProbe?.setupCommand) return;
    setCopyFeedback(null);
    try {
      await navigator.clipboard.writeText(visibleProbe.setupCommand);
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

  const status =
    visibleProbe?.status ??
    (visibleProbe?.availability === "ready"
      ? "ready"
      : visibleProbe?.availability === "needsSetup"
        ? "setupRequired"
        : "unavailable");
  const ready = status === "ready";
  const verificationRequired = status === "verificationRequired";
  const needsSetup = status === "setupRequired";
  const notFound = visibleProbe?.availability === "notFound";
  const unavailable = status === "unavailable" || Boolean(actionError);
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
        <Label>
          <TerminalSquare size={16} className="mr-1 inline" />
          {t.settings.localCli.provider}
        </Label>
        <div
          role="group"
          aria-label={t.settings.localCli.provider}
          className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
        >
          {LOCAL_AGENT_PROVIDERS.map((entry) => {
            const selected = entry.id === provider;
            return (
              <button
                key={entry.id}
                type="button"
                aria-pressed={selected}
                disabled={runtimeChangeLocked}
                onClick={() => selectProvider(entry.id)}
                className={cn(
                  "inline-flex min-h-9 items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform]",
                  "focus-visible:ring-ring/50 focus-visible:ring-[3px] active:scale-[0.98] motion-reduce:transform-none",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  selected
                    ? "bg-background text-foreground shadow-sm dark:border dark:border-input dark:bg-input/30"
                    : "text-foreground/60 hover:bg-background/60 hover:text-foreground dark:text-muted-foreground",
                )}
              >
                {entry.displayName}
              </button>
            );
          })}
        </div>
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
            {isLoading ? (
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
              {isLoading ? (
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

              {!isLoading && visibleProbe?.path ? (
                <div className="mt-2 rounded-md bg-background/70 px-2.5 py-2 dark:bg-background/40">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {t.settings.localCli.executablePath}
                  </p>
                  <code className="mt-0.5 block break-all text-xs text-foreground">
                    {visibleProbe.path}
                  </code>
                </div>
              ) : null}
              {!isLoading && visibleProbe?.version ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">
                    {t.settings.localCli.version}:
                  </span>{" "}
                  {visibleProbe.version}
                </p>
              ) : null}
              {!isLoading && visibleProbe?.message ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {probeDetail}
                </p>
              ) : null}
              {!isLoading && needsSetup && provider === "pi" ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t.settings.localCli.piSetupHint}
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
            onClick={() => void refresh(true)}
            disabled={isLoading}
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
              disabled={isLoading}
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
            disabled={isLoading}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            {t.settings.localCli.chooseExecutable}
          </Button>
          {visibleProbe?.pathSource === "override" ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void clearExecutable()}
              disabled={isLoading}
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
              disabled={isLoading || !canEditPreferences}
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
                {(visibleProbe?.models ?? []).map((model) => (
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
                disabled={isLoading || !canEditPreferences}
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
