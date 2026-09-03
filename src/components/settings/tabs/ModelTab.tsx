import { useState, useEffect, useCallback, useRef } from "react";
import { Key, Globe, Cpu, RefreshCw } from "lucide-react";
import { useSettingsStore } from "../../../store/settings";
import type { AISettings } from "../../../store/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  fetchModelList,
  defaultModelForApiType,
  DEFAULT_BASE_URLS,
  resolveBaseURL,
} from "@/lib/ai/provider-config";
import type { ApiType } from "@/lib/ai/provider-config";
import { useT } from "../../../i18n";
import type { ModelFieldErrors } from "../SettingsDialog";
import { CapsuleGroup } from "@/components/ui/capsule-group";
import { LocalAgentSettings } from "./LocalAgentSettings";
import { isLocalAgentHost } from "../../../lib/local-agent/tauri";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const API_ENDPOINTS: Record<ApiType, string> = {
  "openai-compatible": "/chat/completions",
  openai: "/responses",
  anthropic: "/messages",
  google: "/models",
};

interface ModelTabProps {
  formData: AISettings;
  setFormData: (v: AISettings) => void;
  errors?: ModelFieldErrors;
  runtimeChangeLocked?: boolean;
}

export function ModelTab({
  formData,
  setFormData,
  errors = {},
  runtimeChangeLocked = false,
}: ModelTabProps) {
  const t = useT();
  const modelCache = useSettingsStore((s) => s.modelCache);
  const setModelCache = useSettingsStore((s) => s.setModelCache);
  const clearModelCache = useSettingsStore((s) => s.clearModelCache);
  const localCliHostObservation = useSettingsStore(
    (s) => s.localCliObservationCache.host,
  );
  const ensureLocalCliHostObservation = useSettingsStore(
    (s) => s.ensureLocalCliHostObservation,
  );

  const cacheHit =
    modelCache &&
    modelCache.apiType === formData.apiType &&
    modelCache.apiBaseUrl === formData.apiBaseUrl &&
    modelCache.apiKey === formData.apiKey;

  const [models, setModels] = useState<string[]>(
    cacheHit ? modelCache.models : [],
  );
  const [fetchFailed, setFetchFailed] = useState(!cacheHit);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isCheckingLocalCliHost, setIsCheckingLocalCliHost] = useState(
    !localCliHostObservation,
  );
  const loadingKeyRef = useRef<string>("");

  const inspectLocalCliHost = useCallback(
    async (forceRefresh = false) => {
      setIsCheckingLocalCliHost(true);
      try {
        await ensureLocalCliHostObservation(forceRefresh);
      } finally {
        setIsCheckingLocalCliHost(false);
      }
    },
    [ensureLocalCliHostObservation],
  );

  useEffect(() => {
    if (localCliHostObservation) {
      setIsCheckingLocalCliHost(false);
      return;
    }
    void inspectLocalCliHost(false);
  }, [inspectLocalCliHost, localCliHostObservation]);

  const fetchModels = useCallback(async () => {
    if (!formData.apiBaseUrl || !formData.apiKey) {
      setModels([]);
      setFetchFailed(true);
      setFetchError(null);
      clearModelCache();
      return;
    }
    const currentKey = `${formData.apiType}-${formData.apiBaseUrl}-${formData.apiKey}`;
    if (loadingKeyRef.current === currentKey) return;

    setIsLoading(true);
    setIsRefreshing(true);
    loadingKeyRef.current = currentKey;
    try {
      const ids = await fetchModelList(
        formData.apiType,
        formData.apiBaseUrl,
        formData.apiKey,
      );
      setModels(ids);
      setFetchFailed(false);
      setFetchError(null);
      setModelCache({
        models: ids,
        apiType: formData.apiType,
        apiBaseUrl: formData.apiBaseUrl,
        apiKey: formData.apiKey,
      });
    } catch (error) {
      setModels([]);
      setFetchFailed(true);
      setFetchError(
        (error instanceof Error ? error.message : String(error)).slice(0, 300),
      );
      clearModelCache();
    } finally {
      loadingKeyRef.current = "";
      setIsLoading(false);
      setTimeout(() => setIsRefreshing(false), 600);
    }
  }, [
    formData.apiType,
    formData.apiBaseUrl,
    formData.apiKey,
    setModelCache,
    clearModelCache,
  ]);

  useEffect(() => {
    if (formData.runtime !== "api") return;
    if (!formData.apiBaseUrl || !formData.apiKey) {
      setModels([]);
      setFetchFailed(true);
      setFetchError(null);
      return;
    }
    const cached = useSettingsStore.getState().modelCache;
    if (
      cached &&
      cached.apiType === formData.apiType &&
      cached.apiBaseUrl === formData.apiBaseUrl &&
      cached.apiKey === formData.apiKey
    ) {
      setModels(cached.models);
      setFetchFailed(false);
      setFetchError(null);
      return;
    }
    const timer = setTimeout(() => {
      fetchModels();
    }, 500);
    return () => clearTimeout(timer);
  }, [
    formData.runtime,
    formData.apiType,
    formData.apiBaseUrl,
    formData.apiKey,
  ]);

  const handleApiTypeChange = (v: string) => {
    const apiType = v as ApiType;
    setFormData({
      ...formData,
      apiType,
      apiBaseUrl: DEFAULT_BASE_URLS[apiType],
      model: defaultModelForApiType(apiType),
    });
    setModels([]);
    setFetchFailed(true);
    setFetchError(null);
    clearModelCache();
  };

  const showDropdown = models.length > 0 && !fetchFailed;
  const displayModels =
    showDropdown && formData.model && !models.includes(formData.model)
      ? [formData.model, ...models]
      : models;
  const localAgentCapability = isCheckingLocalCliHost
    ? "loading"
    : (localCliHostObservation?.status ?? "loading");
  const localAgentsSupported = localAgentCapability === "supported";
  const showRuntimeSettings =
    formData.runtime === "localCli" ||
    localAgentsSupported ||
    (isLocalAgentHost() && localAgentCapability !== "unsupported");
  const showCapabilityNotice =
    localAgentCapability === "loading" ||
    localAgentCapability === "error" ||
    (localAgentCapability === "unsupported" && formData.runtime === "localCli");

  return (
    <>
      {showRuntimeSettings ? (
        <div className="space-y-2">
          <Label>{t.settings.runtime.label}</Label>
          <CapsuleGroup
            label={t.settings.runtime.label}
            value={formData.runtime}
            onChange={(value) =>
              setFormData({
                ...formData,
                runtime: value as AISettings["runtime"],
              })
            }
            disabled={runtimeChangeLocked}
            options={[
              { value: "api", label: t.settings.runtime.api },
              ...(localAgentsSupported || formData.runtime === "localCli"
                ? [
                    {
                      value: "localCli",
                      label: t.settings.runtime.localCli,
                    },
                  ]
                : []),
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {runtimeChangeLocked
              ? t.settings.runtime.stopFirst
              : t.settings.runtime.hint}
          </p>
          {showCapabilityNotice ? (
            <div
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              role={localAgentCapability === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              <span>
                {localAgentCapability === "loading"
                  ? t.settings.localCli.scanning
                  : localAgentCapability === "unsupported"
                    ? t.settings.localCli.desktopOnly
                    : t.settings.localCli.unavailable}
              </span>
              {localAgentCapability !== "loading" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => void inspectLocalCliHost(true)}
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  {t.settings.localCli.rescan}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {formData.runtime === "localCli" ? (
        localAgentsSupported ? (
          <LocalAgentSettings
            value={formData.localAgent}
            onChange={(localAgent) => setFormData({ ...formData, localAgent })}
            supported
            runtimeChangeLocked={runtimeChangeLocked}
          />
        ) : null
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="apiType">
              <Cpu size={16} className="inline mr-1" />
              {t.settings.apiType?.label ?? "API Type"}
            </Label>
            <Select
              value={formData.apiType}
              onValueChange={handleApiTypeChange}
            >
              <SelectTrigger id="apiType" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-compatible">
                  OpenAI Compatible{" "}
                  <span className="text-blue-500">/v1/chat/completions</span>
                </SelectItem>
                <SelectItem value="openai">
                  OpenAI <span className="text-indigo-500">/v1/responses</span>
                </SelectItem>
                <SelectItem value="anthropic">
                  Anthropic <span className="text-amber-500">/v1/messages</span>
                </SelectItem>
                <SelectItem value="google">
                  Google <span className="text-rose-500">/v1beta/models</span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t.settings.apiType?.hint ?? "Select the API provider type"}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiKey">
              <Key size={16} className="inline mr-1" />
              API Key
            </Label>
            <Input
              id="apiKey"
              type="password"
              value={formData.apiKey}
              aria-invalid={Boolean(errors.apiKey)}
              aria-describedby={errors.apiKey ? "apiKey-error" : "apiKey-hint"}
              onChange={(e) =>
                setFormData({ ...formData, apiKey: e.target.value })
              }
              placeholder="sk-..."
            />
            <p id="apiKey-hint" className="text-xs text-muted-foreground">
              {t.settings.apiKey.hint}
            </p>
            {errors.apiKey && (
              <p
                id="apiKey-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {errors.apiKey}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiBaseUrl">
              <Globe size={16} className="inline mr-1" />
              API Base URL
            </Label>
            <Input
              id="apiBaseUrl"
              type="text"
              value={formData.apiBaseUrl}
              aria-invalid={Boolean(errors.apiBaseUrl)}
              aria-describedby={
                errors.apiBaseUrl ? "apiBaseUrl-error" : "apiBaseUrl-preview"
              }
              onChange={(e) =>
                setFormData({ ...formData, apiBaseUrl: e.target.value })
              }
              placeholder={DEFAULT_BASE_URLS[formData.apiType]}
            />
            <p
              id="apiBaseUrl-preview"
              className="text-xs text-muted-foreground break-all"
            >
              {t.settings.apiBaseUrl.preview}:{" "}
              {resolveBaseURL(
                formData.apiBaseUrl || DEFAULT_BASE_URLS[formData.apiType],
                formData.apiType,
              ) + API_ENDPOINTS[formData.apiType]}
            </p>
            {errors.apiBaseUrl && (
              <p
                id="apiBaseUrl-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {errors.apiBaseUrl}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="model">
              <Cpu size={16} className="inline mr-1" />
              {t.settings.model.label}
            </Label>
            {showDropdown ? (
              <div className="flex gap-2">
                <Select
                  value={formData.model}
                  onValueChange={(v) => setFormData({ ...formData, model: v })}
                >
                  <SelectTrigger
                    id="model"
                    className="w-full"
                    aria-invalid={Boolean(errors.model)}
                    aria-describedby={
                      errors.model ? "model-error" : "model-hint"
                    }
                  >
                    <SelectValue
                      placeholder={t.settings.model.selectPlaceholder}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {displayModels.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0 size-9"
                      aria-label={t.settings.refreshModels}
                      onClick={(e) => {
                        e.preventDefault();
                        fetchModels();
                      }}
                      disabled={isLoading}
                    >
                      <RefreshCw
                        size={14}
                        className={cn(isRefreshing && "animate-spin")}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t.settings.refreshModels}</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  id="model"
                  type="text"
                  value={formData.model}
                  aria-invalid={Boolean(errors.model)}
                  aria-describedby={errors.model ? "model-error" : "model-hint"}
                  onChange={(e) =>
                    setFormData({ ...formData, model: e.target.value })
                  }
                  placeholder={t.settings.model.hint}
                  className="flex-1"
                />
                {formData.apiBaseUrl && formData.apiKey && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="shrink-0 size-9"
                        aria-label={t.settings.refreshModels}
                        onClick={(e) => {
                          e.preventDefault();
                          fetchModels();
                        }}
                        disabled={isLoading}
                      >
                        <RefreshCw
                          size={14}
                          className={cn(isRefreshing && "animate-spin")}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t.settings.refreshModels}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
            <p id="model-hint" className="text-xs text-muted-foreground">
              {t.settings.model.hint}
            </p>
            {errors.model && (
              <p
                id="model-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {errors.model}
              </p>
            )}
            {fetchError && (
              <p role="status" className="text-xs text-destructive break-words">
                {t.settings.connectionFailed}: {fetchError}
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}
