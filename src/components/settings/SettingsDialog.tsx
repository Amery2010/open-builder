import { useState, useEffect, useMemo } from "react";
import type {
  AISettings,
  WebSearchSettings,
  AssetSearchSettings,
  SystemSettings,
} from "../../store/settings";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useT } from "../../i18n";
import { ModelTab } from "./tabs/ModelTab";
import { SearchServicesTab } from "./tabs/SearchServicesTab";
import { SystemTab } from "./tabs/SystemTab";
import { StorageTab } from "./tabs/StorageTab";
import { AdvancedTab } from "./tabs/AdvancedTab";
import { CUSTOM_SYSTEM_PROMPT_MAX_CHARS } from "../../lib/ai/custom-system-prompt";

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
  runtimeChangeLocked?: boolean;
}

export type ModelFieldErrors = Partial<
  Record<"apiKey" | "apiBaseUrl" | "model", string>
>;

export function validateAISettingsDraft(
  settings: AISettings,
  messages: {
    apiKeyRequired: string;
    apiBaseUrlRequired: string;
    apiBaseUrlInvalid: string;
    modelRequired: string;
    modelInvalid: string;
  },
): ModelFieldErrors {
  const errors: ModelFieldErrors = {};
  if (settings.runtime === "localCli") return errors;
  if (!settings.apiKey.trim()) errors.apiKey = messages.apiKeyRequired;

  const rawUrl = settings.apiBaseUrl.trim();
  if (!rawUrl) {
    errors.apiBaseUrl = messages.apiBaseUrlRequired;
  } else {
    try {
      const parsed = new URL(rawUrl);
      if (!/^https?:$/.test(parsed.protocol)) {
        errors.apiBaseUrl = messages.apiBaseUrlInvalid;
      }
    } catch {
      errors.apiBaseUrl = messages.apiBaseUrlInvalid;
    }
  }

  const model = settings.model.trim();
  if (!model) errors.model = messages.modelRequired;
  else if (model.length > 160 || /[\u0000-\u001f\u007f]/.test(model)) {
    errors.model = messages.modelInvalid;
  }
  return errors;
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
  runtimeChangeLocked = false,
}: SettingsDialogProps) {
  const t = useT();

  const [formData, setFormData] = useState<AISettings>(settings);
  const [webSearchForm, setWebSearchForm] =
    useState<WebSearchSettings>(webSearchSettings);
  const [assetSearchForm, setAssetSearchForm] =
    useState<AssetSearchSettings>(assetSearchSettings);
  const [systemForm, setSystemForm] = useState<SystemSettings>(systemSettings);
  const [showValidation, setShowValidation] = useState(false);

  const modelErrors = useMemo(
    () => validateAISettingsDraft(formData, t.settings.validation),
    [formData, t.settings.validation],
  );
  const customSystemPromptError =
    systemForm.customSystemPrompt.length > CUSTOM_SYSTEM_PROMPT_MAX_CHARS
      ? t.settings.customSystemPrompt.tooLong
      : undefined;

  useEffect(() => {
    if (!isOpen) return;
    setFormData(settings);
    setWebSearchForm(webSearchSettings);
    setAssetSearchForm(assetSearchSettings);
    setSystemForm(systemSettings);
    setShowValidation(false);
  }, [
    isOpen,
    settings,
    webSearchSettings,
    assetSearchSettings,
    systemSettings,
  ]);

  const handleSave = () => {
    setShowValidation(true);
    if (Object.keys(modelErrors).length > 0 || customSystemPromptError) return;
    onSave(formData);
    onSaveWebSearch(webSearchForm);
    onSaveAssetSearch(assetSearchForm);
    onSaveSystem(
      runtimeChangeLocked
        ? {
            ...systemForm,
            permissionBrokerBypassEnabled:
              systemSettings.permissionBrokerBypassEnabled,
          }
        : systemForm,
    );
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex h-[100dvh] max-h-[100dvh] max-w-full flex-col gap-0 rounded-none border-x-0 p-0 sm:h-auto sm:max-h-[90dvh] sm:max-w-md sm:gap-4 sm:rounded-lg sm:border sm:p-6">
        <DialogHeader className="sticky top-0 z-10 shrink-0 border-b bg-background px-4 py-4 pr-12 sm:static sm:border-b-0 sm:px-2 sm:py-0 sm:pr-2">
          <DialogTitle>{t.settings.title}</DialogTitle>
        </DialogHeader>

        <Tabs
          defaultValue="model"
          className="min-h-0 flex-1 overflow-hidden px-4 py-3 sm:px-2 sm:py-0"
        >
          <TabsList className="w-full shrink-0 justify-start overflow-x-auto sm:justify-center sm:overflow-visible">
            <TabsTrigger
              value="model"
              className="min-w-fit px-1.5 text-xs sm:min-w-0 sm:px-2 sm:text-sm"
            >
              {t.settings.tabs.model}
            </TabsTrigger>
            <TabsTrigger
              value="search"
              className="min-w-fit px-1.5 text-xs sm:min-w-0 sm:px-2 sm:text-sm"
            >
              {t.settings.tabs.search}
            </TabsTrigger>
            <TabsTrigger
              value="storage"
              className="min-w-fit px-1.5 text-xs sm:min-w-0 sm:px-2 sm:text-sm"
            >
              {t.settings.tabs.storage}
            </TabsTrigger>
            <TabsTrigger
              value="system"
              className="min-w-fit px-1.5 text-xs sm:min-w-0 sm:px-2 sm:text-sm"
            >
              {t.settings.tabs.system}
            </TabsTrigger>
            <TabsTrigger
              value="advanced"
              className="min-w-fit px-1.5 text-xs sm:min-w-0 sm:px-2 sm:text-sm"
            >
              {t.settings.tabs.advanced}
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="model"
            className="min-h-0 overflow-y-auto py-4 pr-1 space-y-4"
          >
            <ModelTab
              formData={formData}
              setFormData={setFormData}
              errors={showValidation ? modelErrors : {}}
              runtimeChangeLocked={runtimeChangeLocked}
            />
          </TabsContent>

          <TabsContent
            value="search"
            className="min-h-0 overflow-y-auto py-4 pr-1 space-y-4"
          >
            <SearchServicesTab
              webSearchForm={webSearchForm}
              setWebSearchForm={setWebSearchForm}
              assetSearchForm={assetSearchForm}
              setAssetSearchForm={setAssetSearchForm}
              apiType={formData.apiType}
            />
          </TabsContent>

          <TabsContent
            value="storage"
            className="min-h-0 overflow-y-auto py-4 pr-1 space-y-4"
          >
            <StorageTab />
          </TabsContent>

          <TabsContent
            value="system"
            className="min-h-0 overflow-y-auto py-4 pr-1 space-y-4"
          >
            <SystemTab form={systemForm} setForm={setSystemForm} />
          </TabsContent>

          <TabsContent
            value="advanced"
            className="min-h-0 overflow-y-auto py-4 pr-1 space-y-4"
          >
            <AdvancedTab
              form={systemForm}
              setForm={setSystemForm}
              customSystemPromptError={customSystemPromptError}
              runtimeChangeLocked={runtimeChangeLocked}
              fullPermissionsLabels={t.settings.fullPermissions}
            />
          </TabsContent>
        </Tabs>

        <DialogFooter className="sticky bottom-0 z-10 shrink-0 flex-row justify-end border-t bg-background px-4 py-3 sm:static sm:border-t-0 sm:px-0 sm:py-0">
          {showValidation &&
            (Object.keys(modelErrors).length > 0 ||
              customSystemPromptError) && (
              <p className="mr-auto text-xs text-destructive" role="alert">
                {t.settings.validation.summary}
              </p>
            )}
          <Button variant="outline" onClick={onClose}>
            {t.settings.cancel}
          </Button>
          <Button onClick={handleSave}>{t.settings.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
