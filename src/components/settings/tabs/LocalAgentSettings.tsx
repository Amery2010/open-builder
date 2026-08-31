import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FolderOpen,
  Loader2,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
} from "lucide-react";
import type { AISettings } from "../../../store/settings";
import type { LocalAgentProbe } from "../../../lib/local-agent/types";
import {
  LOCAL_AGENT_PROVIDER_CATALOG,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "../../../lib/local-agent/providers";
import {
  chooseLocalAgentExecutable,
  clearLocalAgentExecutable,
  probeLocalAgent,
} from "../../../lib/local-agent/tauri";
import { Button } from "@/components/ui/button";
import { CapsuleGroup } from "@/components/ui/capsule-group";
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

const DEFAULT_OPTION = "__cli_default__";

interface LocalAgentSettingsProps {
  formData: AISettings;
  setFormData: (value: AISettings) => void;
  supported: boolean;
  runtimeChangeLocked?: boolean;
}

export function LocalAgentSettings({
  formData,
  setFormData,
  supported,
  runtimeChangeLocked = false,
}: LocalAgentSettingsProps) {
  const t = useT();
  const provider = formData.localAgent.provider;
  const providerDefinition = LOCAL_AGENT_PROVIDER_CATALOG[provider];
  const preferences = formData.localAgent.preferences[provider];
  const [probe, setProbe] = useState<LocalAgentProbe | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const requestSequenceRef = useRef(0);
  const providerRef = useRef(provider);
  const formDataRef = useRef(formData);
  providerRef.current = provider;
  formDataRef.current = formData;
  const visibleProbe = probe?.provider === provider ? probe : null;

  const normalizePreferences = useCallback(
    (expectedProvider: LocalAgentProvider, result: LocalAgentProbe) => {
      if (result.availability !== "ready") return;

      const current = formDataRef.current;
      const currentPreferences =
        current.localAgent.preferences[expectedProvider];
      const selectedModel = currentPreferences.model
        ? result.models.find((model) => model.id === currentPreferences.model)
        : result.models.find((model) => model.isDefault);
      const normalizedModel =
        currentPreferences.model && !selectedModel
          ? ""
          : currentPreferences.model;
      const effectiveModel = normalizedModel
        ? result.models.find((model) => model.id === normalizedModel)
        : result.models.find((model) => model.isDefault);
      const supportedEfforts = result.capabilities.reasoning
        ? effectiveModel
          ? effectiveModel.efforts
          : result.efforts
        : [];
      const normalizedEffort = supportedEfforts.includes(
        currentPreferences.effort,
      )
        ? currentPreferences.effort
        : "";

      if (
        normalizedModel === currentPreferences.model &&
        normalizedEffort === currentPreferences.effort
      ) {
        return;
      }

      const next: AISettings = {
        ...current,
        localAgent: {
          ...current.localAgent,
          preferences: {
            ...current.localAgent.preferences,
            [expectedProvider]: {
              model: normalizedModel,
              effort: normalizedEffort,
            },
          },
        },
      };
      formDataRef.current = next;
      setFormData(next);
    },
    [setFormData],
  );

  const runProbeOperation = useCallback(
    async (
      operation: (
        expectedProvider: LocalAgentProvider,
      ) => Promise<LocalAgentProbe | null>,
      clearCurrentProbe = false,
    ) => {
      if (!supported) return;
      const expectedProvider = provider;
      const requestId = ++requestSequenceRef.current;
      setIsLoading(true);
      setActionError("");
      if (clearCurrentProbe) setProbe(null);
      try {
        const result = await operation(expectedProvider);
        if (
          requestId !== requestSequenceRef.current ||
          providerRef.current !== expectedProvider
        ) {
          return;
        }
        if (result && result.provider !== expectedProvider) {
          setProbe(null);
          setActionError(t.settings.localCli.probeMismatch);
          return;
        }
        if (result) {
          setProbe(result);
          normalizePreferences(expectedProvider, result);
        }
      } catch (error) {
        if (
          requestId !== requestSequenceRef.current ||
          providerRef.current !== expectedProvider
        ) {
          return;
        }
        setProbe(null);
        setActionError(error instanceof Error ? error.message : String(error));
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
      normalizePreferences,
      provider,
      supported,
      t.settings.localCli.probeMismatch,
    ],
  );

  const refresh = useCallback(
    () => runProbeOperation(probeLocalAgent, true),
    [runProbeOperation],
  );

  useEffect(() => {
    if (!supported) {
      requestSequenceRef.current += 1;
      setProbe(null);
      setActionError("");
      setIsLoading(false);
      return;
    }
    void refresh();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [refresh, supported]);

  const updatePreferences = (
    patch: Partial<(typeof formData.localAgent.preferences)[typeof provider]>,
  ) => {
    const current = formDataRef.current;
    const next: AISettings = {
      ...current,
      localAgent: {
        ...current.localAgent,
        preferences: {
          ...current.localAgent.preferences,
          [provider]: {
            ...current.localAgent.preferences[provider],
            ...patch,
          },
        },
      },
    };
    formDataRef.current = next;
    setFormData(next);
  };

  const selectProvider = (nextProvider: LocalAgentProvider) => {
    if (nextProvider === providerRef.current) return;
    requestSequenceRef.current += 1;
    providerRef.current = nextProvider;
    setProbe(null);
    setActionError("");
    setIsLoading(false);
    const current = formDataRef.current;
    const next: AISettings = {
      ...current,
      localAgent: {
        ...current.localAgent,
        provider: nextProvider,
      },
    };
    formDataRef.current = next;
    setFormData(next);
  };

  const efforts = useMemo(() => {
    if (visibleProbe?.capabilities.reasoning !== true) return [];
    const selected = preferences.model
      ? visibleProbe?.models.find((model) => model.id === preferences.model)
      : visibleProbe?.models.find((model) => model.isDefault);
    return selected ? selected.efforts : (visibleProbe?.efforts ?? []);
  }, [preferences.model, visibleProbe]);

  const chooseExecutable = () => runProbeOperation(chooseLocalAgentExecutable);

  const clearExecutable = () => runProbeOperation(clearLocalAgentExecutable);

  if (!supported) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
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

  const ready = visibleProbe?.availability === "ready";
  const needsSetup = visibleProbe?.availability === "needsSetup";
  const hasAuthoritativeProbe = ready || needsSetup;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>
          <TerminalSquare size={16} className="mr-1 inline" />
          {t.settings.localCli.provider}
        </Label>
        <CapsuleGroup
          label={t.settings.localCli.provider}
          value={provider}
          onChange={(value) => selectProvider(value as LocalAgentProvider)}
          disabled={runtimeChangeLocked}
          options={LOCAL_AGENT_PROVIDERS.map((entry) => ({
            value: entry.id,
            label: entry.displayName,
          }))}
        />
      </div>

      <div
        className={cn(
          "rounded-lg border p-3",
          ready
            ? "border-emerald-500/30 bg-emerald-500/10"
            : "border-border bg-muted/30",
        )}
        aria-live="polite"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : ready ? (
                <CheckCircle2
                  className="size-4 text-emerald-600"
                  aria-hidden="true"
                />
              ) : (
                <AlertTriangle
                  className="size-4 text-amber-600"
                  aria-hidden="true"
                />
              )}
              {isLoading
                ? t.settings.localCli.scanning
                : ready
                  ? t.settings.localCli.ready
                  : needsSetup
                    ? t.settings.localCli.needsSetup
                    : visibleProbe?.availability === "notFound"
                      ? t.settings.localCli.notFound
                      : t.settings.localCli.unavailable}
            </div>
            {visibleProbe?.path ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {visibleProbe.path}
              </p>
            ) : null}
            {visibleProbe?.version ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {visibleProbe.version}
              </p>
            ) : null}
            {visibleProbe?.message ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {visibleProbe.message}
              </p>
            ) : null}
            {needsSetup && provider === "pi" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t.settings.localCli.piSetupHint}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={isLoading}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t.settings.localCli.rescan}
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
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
          {needsSetup ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(visibleProbe.setupCommand)
              }
            >
              <Copy className="size-3.5" aria-hidden="true" />
              {t.settings.localCli.copySetup}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="local-agent-model">
          {t.settings.localCli.model} ({providerDefinition.modelName})
        </Label>
        <Select
          value={preferences.model || DEFAULT_OPTION}
          disabled={isLoading || !hasAuthoritativeProbe}
          onValueChange={(value) =>
            updatePreferences({
              model: value === DEFAULT_OPTION ? "" : value,
              effort: "",
            })
          }
        >
          <SelectTrigger id="local-agent-model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_OPTION}>
              {t.settings.localCli.cliDefault}
            </SelectItem>
            {visibleProbe?.models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.displayName || model.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t.settings.localCli.modelHint}
        </p>
      </div>

      {efforts.length ? (
        <div className="space-y-2">
          <Label htmlFor="local-agent-effort">
            {t.settings.localCli.effort}
          </Label>
          <Select
            value={preferences.effort || DEFAULT_OPTION}
            disabled={isLoading || !hasAuthoritativeProbe}
            onValueChange={(value) =>
              updatePreferences({
                effort: value === DEFAULT_OPTION ? "" : value,
              })
            }
          >
            <SelectTrigger id="local-agent-effort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_OPTION}>
                {t.settings.localCli.cliDefault}
              </SelectItem>
              {efforts.map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {effort}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t.settings.localCli.cloudNotice}
      </div>

      {actionError ? (
        <p role="alert" className="text-xs text-destructive">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
