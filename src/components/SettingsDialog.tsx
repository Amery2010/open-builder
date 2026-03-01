import { useState, useEffect } from "react";
import { Key, Globe, Cpu, Search, Languages, Sun, Info } from "lucide-react";
import {
  AISettings,
  WebSearchSettings,
  SystemSettings,
  Language,
  Theme,
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
import { cn } from "@/lib/utils";
import { version } from "../../package.json";
import { useT } from "../i18n";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AISettings;
  onSave: (settings: AISettings) => void;
  webSearchSettings: WebSearchSettings;
  onSaveWebSearch: (settings: WebSearchSettings) => void;
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
  systemSettings,
  onSaveSystem,
}: SettingsDialogProps) {
  const t = useT();
  const [formData, setFormData] = useState<AISettings>(settings);
  const [webSearchForm, setWebSearchForm] =
    useState<WebSearchSettings>(webSearchSettings);
  const [systemForm, setSystemForm] = useState<SystemSettings>(systemSettings);

  useEffect(() => {
    setFormData(settings);
  }, [settings]);

  useEffect(() => {
    setWebSearchForm(webSearchSettings);
  }, [webSearchSettings]);

  useEffect(() => {
    setSystemForm(systemSettings);
  }, [systemSettings]);

  const handleSave = () => {
    onSave(formData);
    onSaveWebSearch(webSearchForm);
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
            <TabsTrigger value="system">{t.settings.tabs.system}</TabsTrigger>
          </TabsList>

          {/* ── 模型设置 ── */}
          <TabsContent value="model" className="overflow-y-auto py-4 space-y-4">
            <ModelSettingsTab formData={formData} setFormData={setFormData} />
          </TabsContent>

          {/* ── 联网搜索 ── */}
          <TabsContent
            value="search"
            className="overflow-y-auto py-4 space-y-4"
          >
            <WebSearchTab form={webSearchForm} setForm={setWebSearchForm} />
          </TabsContent>

          {/* ── 系统设置 ── */}
          <TabsContent
            value="system"
            className="overflow-y-auto py-4 space-y-4"
          >
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
        <Label htmlFor="apiUrl">
          <Globe size={16} className="inline mr-1" />
          API URL
        </Label>
        <Input
          id="apiUrl"
          type="text"
          value={formData.apiUrl}
          onChange={(e) => setFormData({ ...formData, apiUrl: e.target.value })}
          placeholder="https://api.openai.com/v1/chat/completions"
        />
        <p className="text-xs text-muted-foreground">
          {t.settings.apiUrl.hint}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="model">
          <Cpu size={16} className="inline mr-1" />
          {t.settings.model.label}
        </Label>
        <Input
          id="model"
          type="text"
          value={formData.model}
          onChange={(e) => setFormData({ ...formData, model: e.target.value })}
          placeholder="gpt-5.3-codex"
        />
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
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Search size={14} />
        {t.settings.webSearch.desc}
      </p>

      <div className="space-y-2">
        <Label htmlFor="tavilyApiKey">
          <Key size={16} className="inline mr-1" />
          Tavily API Key
        </Label>
        <Input
          id="tavilyApiKey"
          type="password"
          value={form.tavilyApiKey}
          onChange={(e) => setForm({ ...form, tavilyApiKey: e.target.value })}
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
          onChange={(e) => setForm({ ...form, tavilyApiUrl: e.target.value })}
          placeholder="https://api.tavily.com"
        />
        <p className="text-xs text-muted-foreground">
          {t.settings.tavilyUrl.hint}
        </p>
      </div>
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
