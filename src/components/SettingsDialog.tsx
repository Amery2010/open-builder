import { useState, useEffect, useCallback } from "react";
import {
  Key,
  Globe,
  Cpu,
  Search,
  Languages,
  Sun,
  Info,
  RefreshCw,
} from "lucide-react";
import {
  AISettings,
  WebSearchSettings,
  AssetSearchSettings,
  SystemSettings,
  Language,
  Theme,
  useSettingsStore,
} from "../store/settings";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import { buildApiUrl } from "@/lib/client";
import { version } from "../../package.json";
import { useT } from "../i18n";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AISettings;
  onSave: (settings: AISettings) => void;
  webSearchSettings: WebSearchSettings;
  onSaveWebSearch: (settings: WebSearchSettings) => void;
  assetSearchSettings: AssetSearchSettings;
  onSaveAssetSearch: (settings: AssetSearchSettings) => void;
  systemSettings: SystemSettings;
  onSaveSystem: (settings: SystemSettings) => void;
}

export function SettingsDialog({
  isOpen,
  onClose,
  settings,
  onSave,
  webSearchSettings,
  onSaveWebSearch,
  assetSearchSettings,
  onSaveAssetSearch,
  systemSettings,
  onSaveSystem,
}: SettingsDialogProps) {
  const t = useT();
  const [formData, setFormData] = useState<AISettings>(settings);
  const [webSearchForm, setWebSearchForm] =
    useState<WebSearchSettings>(webSearchSettings);
  const [assetSearchForm, setAssetSearchForm] =
    useState<AssetSearchSettings>(assetSearchSettings);
  const [systemForm, setSystemForm] = useState<SystemSettings>(systemSettings);

  useEffect(() => {
    setFormData(settings);
  }, [settings]);

  useEffect(() => {
    setWebSearchForm(webSearchSettings);
  }, [webSearchSettings]);

  useEffect(() => {
    setAssetSearchForm(assetSearchSettings);
  }, [assetSearchSettings]);

  useEffect(() => {
    setSystemForm(systemSettings);
  }, [systemSettings]);

  const handleSave = () => {
    onSave(formData);
    onSaveWebSearch(webSearchForm);
    onSaveAssetSearch(assetSearchForm);
    onSaveSystem(systemForm);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md sm:max-w-md max-h-[90dvh] flex flex-col">
        <DialogHeader className="px-2">
          <DialogTitle>{t.settings.title}</DialogTitle>
        </DialogHeader>

        <Tabs
          defaultValue="model"
          className="flex-1 min-h-0 flex flex-col px-2"
        >
          <TabsList className="w-full">
            <TabsTrigger value="model">{t.settings.tabs.model}</TabsTrigger>
            <TabsTrigger value="search">{t.settings.tabs.search}</TabsTrigger>
            <TabsTrigger value="asset">{t.settings.tabs.asset}</TabsTrigger>
            <TabsTrigger value="system">{t.settings.tabs.system}</TabsTrigger>
          </TabsList>

          {/* ── 模型设置 ── */}
          <TabsContent value="model" className="py-4 space-y-4">
            <ModelSettingsTab formData={formData} setFormData={setFormData} />
          </TabsContent>

          {/* ── 联网搜索 ── */}
          <TabsContent value="search" className="py-4 space-y-4">
            <WebSearchTab form={webSearchForm} setForm={setWebSearchForm} />
          </TabsContent>

          {/* ── 素材搜索 ── */}
          <TabsContent value="asset" className="py-4 space-y-4">
            <AssetSearchTab
              form={assetSearchForm}
              setForm={setAssetSearchForm}
            />
          </TabsContent>

          {/* ── 系统设置 ── */}
          <TabsContent value="system" className="py-4 space-y-4">
            <SystemTab form={systemForm} setForm={setSystemForm} />
          </TabsContent>
        </Tabs>

        <DialogFooter className="flex-row justify-end">
          <Button variant="outline" onClick={onClose}>
            {t.settings.cancel}
          </Button>
          <Button onClick={handleSave}>{t.settings.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Model Settings Tab ── */

function ModelSettingsTab({
  formData,
  setFormData,
}: {
  formData: AISettings;
  setFormData: (v: AISettings) => void;
}) {
  const t = useT();
  const modelCache = useSettingsStore((s) => s.modelCache);
  const setModelCache = useSettingsStore((s) => s.setModelCache);
  const clearModelCache = useSettingsStore((s) => s.clearModelCache);

  const cacheHit =
    modelCache &&
    modelCache.apiBaseUrl === formData.apiBaseUrl &&
    modelCache.apiKey === formData.apiKey;

  const [models, setModels] = useState<string[]>(
    cacheHit ? modelCache.models : [],
  );
  const [fetchFailed, setFetchFailed] = useState(!cacheHit);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchModels = useCallback(async () => {
    if (!formData.apiBaseUrl || !formData.apiKey) {
      setModels([]);
      setFetchFailed(true);
      clearModelCache();
      return;
    }
    setIsLoading(true);
    setIsRefreshing(true);
    try {
      const modelsUrl = buildApiUrl(formData.apiBaseUrl, "/models");
      const res = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${formData.apiKey}` },
      });
      if (!res.ok) throw new Error();
      const json = await res.json();
      const ids: string[] = (json.data || [])
        .map((m: any) => m.id)
        .filter(Boolean)
        .sort();
      setModels(ids);
      setFetchFailed(false);
      setModelCache({
        models: ids,
        apiBaseUrl: formData.apiBaseUrl,
        apiKey: formData.apiKey,
      });
    } catch {
      setModels([]);
      setFetchFailed(true);
      clearModelCache();
    } finally {
      setIsLoading(false);
      setTimeout(() => setIsRefreshing(false), 600);
    }
  }, [formData.apiBaseUrl, formData.apiKey, setModelCache, clearModelCache]);

  useEffect(() => {
    if (!formData.apiBaseUrl || !formData.apiKey) {
      setModels([]);
      setFetchFailed(true);
      return;
    }
    // Use cache if apiBaseUrl and apiKey haven't changed
    const cached = useSettingsStore.getState().modelCache;
    if (
      cached &&
      cached.apiBaseUrl === formData.apiBaseUrl &&
      cached.apiKey === formData.apiKey
    ) {
      setModels(cached.models);
      setFetchFailed(false);
      return;
    }
    const timer = setTimeout(() => {
      fetchModels();
    }, 500);
    return () => clearTimeout(timer);
  }, [formData.apiBaseUrl, formData.apiKey]);

  const showDropdown = models.length > 0 && !fetchFailed;
  const displayModels =
    showDropdown && formData.model && !models.includes(formData.model)
      ? [formData.model, ...models]
      : models;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="apiKey">
          <Key size={16} className="inline mr-1" />
          API Key
        </Label>
        <Input
          id="apiKey"
          type="password"
          value={formData.apiKey}
          onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
          placeholder="sk-..."
        />
        <p className="text-xs text-muted-foreground">
          {t.settings.apiKey.hint}
        </p>
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
          onChange={(e) =>
            setFormData({ ...formData, apiBaseUrl: e.target.value })
          }
          placeholder="https://api.openai.com"
        />
        <p className="text-xs text-muted-foreground truncate">
          {t.settings.apiBaseUrl.preview}
          {formData.apiBaseUrl
            ? buildApiUrl(formData.apiBaseUrl, "/chat/completions")
            : "https://api.openai.com/v1/chat/completions"}
        </p>
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
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t.settings.model.selectPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {displayModels.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              className="shrink-0 size-9"
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
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              id="model"
              type="text"
              value={formData.model}
              onChange={(e) =>
                setFormData({ ...formData, model: e.target.value })
              }
              placeholder="gpt-5.3-codex"
              className="flex-1"
            />
            {formData.apiBaseUrl && formData.apiKey && (
              <Button
                variant="outline"
                size="icon"
                className="shrink-0 size-9"
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
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t.settings.model.hint}</p>
      </div>
    </>
  );
}

/* ── Web Search Tab ── */

function WebSearchTab({
  form,
  setForm,
}: {
  form: WebSearchSettings;
  setForm: (v: WebSearchSettings) => void;
}) {
  const t = useT();
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="searchEngine">
          <Search size={16} className="inline mr-1" />
          {t.settings.webSearch.engine}
        </Label>
        <Select
          value={form.engine}
          onValueChange={(v) => setForm({ ...form, engine: v as any })}
        >
          <SelectTrigger id="searchEngine" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">
              {t.settings.webSearch.disabled}
            </SelectItem>
            <SelectItem value="tavily">Tavily</SelectItem>
            <SelectItem value="firecrawl">Firecrawl</SelectItem>
          </SelectContent>
        </Select>

        <p className="text-xs text-muted-foreground">
          {t.settings.webSearch.desc}
        </p>
      </div>

      {form.engine === "tavily" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="tavilyApiKey">
              <Key size={16} className="inline mr-1" />
              Tavily API Key
            </Label>
            <Input
              id="tavilyApiKey"
              type="password"
              value={form.tavilyApiKey}
              onChange={(e) =>
                setForm({ ...form, tavilyApiKey: e.target.value })
              }
              placeholder="tvly-..."
            />
            <p className="text-xs text-muted-foreground">
              {t.settings.tavilyKey.hint}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tavilyApiUrl">
              <Globe size={16} className="inline mr-1" />
              Tavily API URL
            </Label>
            <Input
              id="tavilyApiUrl"
              type="text"
              value={form.tavilyApiUrl}
              onChange={(e) =>
                setForm({ ...form, tavilyApiUrl: e.target.value })
              }
              placeholder="https://api.tavily.com"
            />
            <p className="text-xs text-muted-foreground">
              {t.settings.tavilyUrl.hint}
            </p>
          </div>
        </>
      )}

      {form.engine === "firecrawl" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="firecrawlApiKey">
              <Key size={16} className="inline mr-1" />
              Firecrawl API Key
            </Label>
            <Input
              id="firecrawlApiKey"
              type="password"
              value={form.firecrawlApiKey}
              onChange={(e) =>
                setForm({ ...form, firecrawlApiKey: e.target.value })
              }
              placeholder="fc-..."
            />
            <p className="text-xs text-muted-foreground">
              {t.settings.firecrawlKey.hint}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="firecrawlApiUrl">
              <Globe size={16} className="inline mr-1" />
              Firecrawl API URL
            </Label>
            <Input
              id="firecrawlApiUrl"
              type="text"
              value={form.firecrawlApiUrl}
              onChange={(e) =>
                setForm({ ...form, firecrawlApiUrl: e.target.value })
              }
              placeholder="https://api.firecrawl.dev"
            />
            <p className="text-xs text-muted-foreground">
              {t.settings.firecrawlUrl.hint}
            </p>
          </div>
        </>
      )}
    </>
  );
}

/* ── Asset Search Tab ── */

function AssetSearchTab({
  form,
  setForm,
}: {
  form: AssetSearchSettings;
  setForm: (v: AssetSearchSettings) => void;
}) {
  const t = useT();
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="assetEngine">
          <Search size={16} className="inline mr-1" />
          {t.settings.assetSearch.engine}
        </Label>
        <Select
          value={form.engine}
          onValueChange={(v) => setForm({ ...form, engine: v as any })}
        >
          <SelectTrigger id="assetEngine" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">
              {t.settings.assetSearch.disabled}
            </SelectItem>
            <SelectItem value="pixabay">Pixabay</SelectItem>
            <SelectItem value="unsplash">Unsplash</SelectItem>
          </SelectContent>
        </Select>

        <p className="text-xs text-muted-foreground">
          {t.settings.assetSearch.desc}
        </p>
      </div>

      {form.engine === "pixabay" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="pixabayApiKey">
              <Key size={16} className="inline mr-1" />
              Pixabay API Key
            </Label>
            <Input
              id="pixabayApiKey"
              type="password"
              value={form.pixabayApiKey}
              onChange={(e) =>
                setForm({ ...form, pixabayApiKey: e.target.value })
              }
              placeholder="..."
            />
            <p className="text-xs text-muted-foreground">
              {t.settings.pixabayKey.hint}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pixabayApiUrl">
              <Globe size={16} className="inline mr-1" />
              Pixabay API URL
            </Label>
            <Input
              id="pixabayApiUrl"
              type="text"
              value={form.pixabayApiUrl}
              onChange={(e) =>
                setForm({ ...form, pixabayApiUrl: e.target.value })
              }
              placeholder="https://pixabay.com/api"
            />
            <p className="text-xs text-muted-foreground">
              {t.settings.pixabayUrl.hint}
            </p>
          </div>
        </>
      )}

      {form.engine === "unsplash" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="unsplashApiKey">
              <Key size={16} className="inline mr-1" />
              Unsplash API Key
            </Label>
            <Input
              id="unsplashApiKey"
              type="password"
              value={form.unsplashApiKey}
              onChange={(e) =>
                setForm({ ...form, unsplashApiKey: e.target.value })
              }
              placeholder="..."
            />
            <p className="text-xs text-muted-foreground">
              {t.settings.unsplashKey.hint}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="unsplashApiUrl">
              <Globe size={16} className="inline mr-1" />
              Unsplash API URL
            </Label>
            <Input
              id="unsplashApiUrl"
              type="text"
              value={form.unsplashApiUrl}
              onChange={(e) =>
                setForm({ ...form, unsplashApiUrl: e.target.value })
              }
              placeholder="https://api.unsplash.com"
            />
            <p className="text-xs text-muted-foreground">
              {t.settings.unsplashUrl.hint}
            </p>
          </div>
        </>
      )}
    </>
  );
}

/* ── System Settings Tab ── */

function SystemTab({
  form,
  setForm,
}: {
  form: SystemSettings;
  setForm: (v: SystemSettings) => void;
}) {
  const t = useT();
  return (
    <>
      {/* 语言 */}
      <div className="space-y-2">
        <Label>
          <Languages size={16} className="inline mr-1" />
          {t.settings.language.label}
        </Label>
        <CapsuleGroup
          value={form.language}
          onChange={(v) => setForm({ ...form, language: v as Language })}
          options={[
            { value: "system", label: t.settings.language.system },
            { value: "zh", label: t.settings.language.zh },
            { value: "en", label: t.settings.language.en },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {t.settings.language.hint}
        </p>
      </div>

      {/* 外观 */}
      <div className="space-y-2">
        <Label>
          <Sun size={16} className="inline mr-1" />
          {t.settings.theme.label}
        </Label>
        <CapsuleGroup
          value={form.theme}
          onChange={(v) => setForm({ ...form, theme: v as Theme })}
          options={[
            { value: "system", label: t.settings.theme.system },
            { value: "light", label: t.settings.theme.light },
            { value: "dark", label: t.settings.theme.dark },
          ]}
        />
        <p className="text-xs text-muted-foreground">{t.settings.theme.hint}</p>
      </div>

      {/* 版本 */}
      <div className="space-y-2">
        <Label>
          <Info size={16} className="inline mr-1" />
          {t.settings.version.label}
        </Label>
        <p className="text-md text-foreground text-center">
          v{version}
          <a
            href="https://github.com/Amery2010/open-builder/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 text-xs text-primary hover:underline"
          >
            {t.settings.version.checkUpdate}
          </a>
        </p>
      </div>
    </>
  );
}

/* ── Capsule Button Group ── */

function CapsuleGroup({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex w-full items-center rounded-lg bg-muted p-0.75 h-9">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "inline-flex flex-1 h-[calc(100%-1px)] items-center justify-center rounded-md px-2 py-1 text-sm font-medium whitespace-nowrap transition-all",
            value === opt.value
              ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
              : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
