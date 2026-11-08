import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../store/settings";
import { ModelTab } from "./tabs/ModelTab";
import { SearchServicesTab } from "./tabs/SearchServicesTab";
import { SystemTab } from "./tabs/SystemTab";
import { StorageTab } from "./tabs/StorageTab";
import {
  AdvancedTab,
  validateImageCompressionQualityDraft,
} from "./tabs/AdvancedTab";
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

function areAISettingsEqual(left: AISettings, right: AISettings): boolean {
  if (
    left.runtime !== right.runtime ||
    left.apiType !== right.apiType ||
    left.apiKey !== right.apiKey ||
    left.apiBaseUrl !== right.apiBaseUrl ||
    left.model !== right.model ||
    left.localAgent.provider !== right.localAgent.provider
  ) {
    return false;
  }

  type Provider = keyof AISettings["localAgent"]["preferences"];
  const providers = new Set<Provider>([
    ...(Object.keys(left.localAgent.preferences) as Provider[]),
    ...(Object.keys(right.localAgent.preferences) as Provider[]),
  ]);
  return [...providers].every((provider) => {
    const leftPreference = left.localAgent.preferences[provider];
    const rightPreference = right.localAgent.preferences[provider];
    return (
      leftPreference?.model === rightPreference?.model &&
      leftPreference?.effort === rightPreference?.effort
    );
  });
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

  const openerRef = useRef<HTMLElement | null>(null);
  if (isOpen && openerRef.current === null && typeof document !== "undefined") {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body
    ) {
      openerRef.current = activeElement;
    }
  }

  const restoreOpenerFocus = useCallback(() => {
    if (typeof document === "undefined") return;
    const opener = openerRef.current;
    if (opener?.isConnected) {
      opener.focus({ preventScroll: true });
      return;
    }

    const fallback = document.querySelector<HTMLElement>(
      '[data-settings-focus-fallback="true"]',
    );
    if (fallback?.isConnected) {
      fallback.focus({ preventScroll: true });
      return;
    }

    // The opener can disappear when a conversation or layout is replaced.
    // Focusing body is a safe final fallback and never throws in that case.
    document.body.focus({ preventScroll: true });
  }, []);

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      restoreOpenerFocus();
    },
    [restoreOpenerFocus],
  );

  const settingsMountedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) return;
    settingsMountedRef.current = true;
    return () => {
      settingsMountedRef.current = false;
      queueMicrotask(() => {
        if (settingsMountedRef.current) return;
        restoreOpenerFocus();
        openerRef.current = null;
      });
    };
  }, [isOpen, restoreOpenerFocus]);

  const [formData, setFormData] = useState<AISettings>(settings);
  const [webSearchForm, setWebSearchForm] =
    useState<WebSearchSettings>(webSearchSettings);
  const [assetSearchForm, setAssetSearchForm] =
    useState<AssetSearchSettings>(assetSearchSettings);
  const [systemForm, setSystemForm] = useState<SystemSettings>(systemSettings);
  const [imageCompressionQualityDraft, setImageCompressionQualityDraft] =
    useState(() => String(systemSettings.imageCompressionQuality));
  const [showValidation, setShowValidation] = useState(false);
  const [activeTab, setActiveTab] = useState("model");
  const focusModelFieldRef = useRef<keyof ModelFieldErrors | null>(null);
  const localCliObservation = useSettingsStore(
    (state) =>
      state.localCliObservationCache.providers[formData.localAgent.provider],
  );
  const localNativeSearchAvailable =
    formData.runtime === "localCli" &&
    localCliObservation?.status !== "unavailable" &&
    localCliObservation?.capabilities.nativeSearch === true;

  const modelErrors = useMemo(
    () => validateAISettingsDraft(formData, t.settings.validation),
    [formData, t.settings.validation],
  );
  const modelDraftChanged = useMemo(
    () => !areAISettingsEqual(formData, settings),
    [formData, settings],
  );
  const modelErrorsForSave = modelDraftChanged ? modelErrors : {};
  const customSystemPromptError =
    systemForm.customSystemPrompt.length > CUSTOM_SYSTEM_PROMPT_MAX_CHARS
      ? t.settings.customSystemPrompt.tooLong
      : undefined;
  const imageCompressionQualityError = useMemo(
    () =>
      validateImageCompressionQualityDraft(
        imageCompressionQualityDraft,
        t.settings.imageCompression,
      ),
    [imageCompressionQualityDraft, t.settings.imageCompression],
  );

  useEffect(() => {
    if (!isOpen) return;
    setFormData(settings);
    setWebSearchForm(webSearchSettings);
    setAssetSearchForm(assetSearchSettings);
    setSystemForm(systemSettings);
    setImageCompressionQualityDraft(
      String(systemSettings.imageCompressionQuality),
    );
    setShowValidation(false);
    setActiveTab("model");
    focusModelFieldRef.current = null;
  }, [
    isOpen,
    settings,
    webSearchSettings,
    assetSearchSettings,
    systemSettings,
  ]);

  useEffect(() => {
    if (!showValidation || activeTab !== "model") return;
    const field = focusModelFieldRef.current;
    if (!field || !modelErrorsForSave[field]) return;
    const timer = window.setTimeout(() => {
      const element = document.getElementById(field);
      if (!(element instanceof HTMLElement)) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView?.({ block: "center" });
      focusModelFieldRef.current = null;
    });
    return () => window.clearTimeout(timer);
  }, [activeTab, modelErrorsForSave, showValidation]);

  const handleSave = () => {
    setShowValidation(true);
    const modelErrorKeys = Object.keys(modelErrorsForSave) as Array<
      keyof ModelFieldErrors
    >;
    if (modelErrorKeys.length > 0) {
      focusModelFieldRef.current =
        (["apiKey", "apiBaseUrl", "model"] as const).find(
          (field) => modelErrorsForSave[field],
        ) ?? null;
      setActiveTab("model");
      return;
    }
    if (customSystemPromptError || imageCompressionQualityError) {
      setActiveTab("advanced");
      return;
    }
    if (modelDraftChanged) onSave(formData);
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
      <DialogContent
        className="flex h-[100dvh] max-h-[100dvh] max-w-full flex-col gap-0 rounded-none border-x-0 p-0 sm:h-auto sm:max-h-[90dvh] sm:max-w-md sm:gap-4 sm:rounded-lg sm:border sm:p-6"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <DialogHeader className="sticky top-0 z-10 shrink-0 border-b bg-background px-4 py-4 pr-12 sm:static sm:border-b-0 sm:px-2 sm:py-0 sm:pr-2">
          <DialogTitle>{t.settings.title}</DialogTitle>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
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

          <SettingsTabContent value="model">
            <ModelTab
              formData={formData}
              setFormData={setFormData}
              errors={showValidation ? modelErrorsForSave : {}}
              runtimeChangeLocked={runtimeChangeLocked}
            />
          </SettingsTabContent>

          <SettingsTabContent value="search">
            <SearchServicesTab
              webSearchForm={webSearchForm}
              setWebSearchForm={setWebSearchForm}
              assetSearchForm={assetSearchForm}
              setAssetSearchForm={setAssetSearchForm}
              apiType={formData.apiType}
              runtime={formData.runtime}
              localNativeSearchAvailable={localNativeSearchAvailable}
            />
          </SettingsTabContent>

          <SettingsTabContent value="storage">
            <StorageTab />
          </SettingsTabContent>

          <SettingsTabContent value="system">
            <SystemTab form={systemForm} setForm={setSystemForm} />
          </SettingsTabContent>

          <SettingsTabContent value="advanced">
            <AdvancedTab
              form={systemForm}
              setForm={setSystemForm}
              customSystemPromptError={customSystemPromptError}
              runtimeChangeLocked={runtimeChangeLocked}
              fullPermissionsLabels={t.settings.fullPermissions}
              imageCompressionQualityDraft={imageCompressionQualityDraft}
              onImageCompressionQualityDraftChange={
                setImageCompressionQualityDraft
              }
            />
          </SettingsTabContent>
        </Tabs>

        <DialogFooter className="sticky bottom-0 z-10 shrink-0 flex-row justify-end border-t bg-background px-4 py-3 sm:static sm:border-t-0 sm:px-0 sm:py-0">
          {showValidation &&
            (Object.keys(modelErrorsForSave).length > 0 ||
              customSystemPromptError ||
              imageCompressionQualityError) && (
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

function SettingsTabContent({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  return (
    <TabsContent
      value={value}
      tabIndex={-1}
      className="flex min-h-0 flex-col overflow-hidden"
    >
      <ScrollArea className="flex-1" contentClassName="space-y-4 py-4 pr-3">
        {children}
      </ScrollArea>
    </TabsContent>
  );
}
