import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  FolderUp,
  Loader2,
  PackageOpen,
  Plus,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import { useConversationStore } from "../../store/conversation";
import { useSettingsStore } from "../../store/settings";
import {
  BUNDLED_DESIGN_SYSTEMS,
  CUSTOM_DESIGN_SYSTEM_PREVIEW_PATH,
  type BundledDesignSystemEntry,
} from "../../lib/design-systems/catalog";
import { loadBundledDesignSystem } from "../../lib/design-systems/bundled";
import {
  getDesignSystemRegistry,
  type DesignSystemRegistry,
} from "../../lib/design-systems/registry";
import {
  stageDesignSystemDirectory,
  stageDesignSystemZip,
  type StagedDesignSystemImport,
} from "../../lib/design-systems/importer";
import {
  CUSTOM_DESIGN_SYSTEM_RULES_MAX_CHARS,
  type CustomDesignSystemDraft,
} from "../../lib/design-systems/ai";
import type { DesignSystemRef, ProjectFiles } from "../../types";
import { isTauriMcpHost } from "../../lib/mcp/tauri-host";
import {
  inspectDesignTokenContract,
  sameDesignSystemReference,
} from "../../lib/design/tokens";

interface DesignSystemPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (id: string) => Promise<void> | void;
  onCompileCustom?: (
    draft: CustomDesignSystemDraft,
  ) => Promise<StagedDesignSystemImport>;
  isGenerating: boolean;
  canApplyProject?: boolean;
  registry?: DesignSystemRegistry;
}

type PanelView = "catalog" | "custom";

const EMPTY_PROJECT_FILES: ProjectFiles = {};

const EMPTY_CUSTOM_DRAFT: CustomDesignSystemDraft = {
  name: "",
  visualDirection: "",
  foundations: "",
  composition: "",
};

function rulesLength(draft: CustomDesignSystemDraft): number {
  return (
    draft.visualDirection.length +
    draft.foundations.length +
    draft.composition.length
  );
}

export function DesignSystemPanel({
  open,
  onOpenChange,
  onApply,
  onCompileCustom,
  isGenerating,
  canApplyProject = true,
  registry = getDesignSystemRegistry(),
}: DesignSystemPanelProps) {
  const t = useT();
  const languageSetting = useSettingsStore((state) => state.system.language);
  const language =
    languageSetting === "en" ||
    (languageSetting === "system" &&
      typeof navigator !== "undefined" &&
      !navigator.language.startsWith("zh"))
      ? "en"
      : "zh";
  const designState = useConversationStore((state) =>
    state.activeId
      ? state.conversations[state.activeId]?.designState
      : undefined,
  );
  const projectFiles = useConversationStore(
    (state) =>
      (state.activeId
        ? state.conversations[state.activeId]?.files
        : undefined) ?? EMPTY_PROJECT_FILES,
  );
  const tokenContract = useMemo(
    () => inspectDesignTokenContract(projectFiles, designState),
    [designState, projectFiles],
  );
  const [view, setView] = useState<PanelView>("catalog");
  const [imported, setImported] = useState<DesignSystemRef[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedDesignSystemImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customDraft, setCustomDraft] =
    useState<CustomDesignSystemDraft>(EMPTY_CUSTOM_DRAFT);
  const bodyRef = useRef<HTMLDivElement>(null);
  const catalogScrollRef = useRef(0);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) return;
    setView("catalog");
    setError(null);
    setStaged(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    registry
      .listImported()
      .then((references) => {
        if (!cancelled) setImported(references);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, registry]);

  const returnToCatalog = () => {
    setView("catalog");
    setError(null);
    requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = catalogScrollRef.current;
    });
  };

  const openCustomView = () => {
    catalogScrollRef.current = bodyRef.current?.scrollTop ?? 0;
    setError(null);
    setView("custom");
    requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
    });
  };

  const markManualSelection = (
    reference: DesignSystemRef,
    conversationId: string | null,
  ) => {
    if (!conversationId) return;
    useConversationStore
      .getState()
      .setDesignStateForConversation(conversationId, (current) => ({
        ...current,
        selectedSystem: reference,
        recommendation: undefined,
        autoSelectionError: false,
      }));
  };

  const applyManualSelection = async (
    reference: DesignSystemRef,
    conversationId: string | null,
  ) => {
    if (
      !conversationId ||
      useConversationStore.getState().activeId !== conversationId
    ) {
      return;
    }
    markManualSelection(reference, conversationId);
    if (!canApplyProject) {
      onOpenChange(false);
      return;
    }
    const current = useConversationStore.getState();
    const conversation = current.conversations[conversationId];
    if (!conversation || current.activeId !== conversationId) return;
    const contract = inspectDesignTokenContract(
      conversation.files,
      conversation.designState,
    );
    if (
      sameDesignSystemReference(
        reference,
        conversation.designState?.appliedSystem,
      ) &&
      contract.status === "ready"
    ) {
      onOpenChange(false);
      return;
    }
    await onApply(reference.id);
    if (useConversationStore.getState().activeId === conversationId) {
      onOpenChange(false);
    }
  };

  const selectBundled = async (entry: BundledDesignSystemEntry) => {
    const conversationId = useConversationStore.getState().activeId;
    setError(null);
    setLoadingId(entry.id);
    try {
      await applyManualSelection(
        (await loadBundledDesignSystem(entry.id)).reference,
        conversationId,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingId(null);
    }
  };

  const selectImported = async (reference: DesignSystemRef) => {
    const conversationId = useConversationStore.getState().activeId;
    setError(null);
    setLoadingId(reference.id);
    try {
      await applyManualSelection(
        (await registry.loadImported(reference.id)).reference,
        conversationId,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingId(null);
    }
  };

  const resetAutomaticSelection = () => {
    setError(null);
    const conversationId = useConversationStore.getState().activeId;
    if (!conversationId) return;
    useConversationStore
      .getState()
      .setDesignStateForConversation(conversationId, (current) => ({
        ...current,
        selectedSystem: undefined,
        recommendation: undefined,
        autoSelectionError: false,
      }));
  };

  const stageZip = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setLoadingId("import");
    try {
      setStaged(await stageDesignSystemZip(await file.arrayBuffer()));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingId(null);
      if (zipInputRef.current) zipInputRef.current.value = "";
    }
  };

  const stageFolder = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setLoadingId("import");
    try {
      setStaged(await stageDesignSystemDirectory(Array.from(files)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingId(null);
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  };

  const pickFolder = async () => {
    if (!isTauriMcpHost()) {
      folderInputRef.current?.click();
      return;
    }
    setError(null);
    setLoadingId("import");
    try {
      const { stageDesignSystemTauriDirectory } =
        await import("../../lib/design-systems/tauri-directory-import");
      const next = await stageDesignSystemTauriDirectory();
      if (next) setStaged(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingId(null);
    }
  };

  const confirmImport = async () => {
    if (!staged) return;
    const conversationId = useConversationStore.getState().activeId;
    setLoadingId("import");
    setError(null);
    try {
      const reference = await registry.confirmImport(staged.package);
      setImported(await registry.listImported());
      markManualSelection(reference, conversationId);
      setStaged(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingId(null);
    }
  };

  const updateCustomRule = (
    field: "visualDirection" | "foundations" | "composition",
    value: string,
  ) => {
    setCustomDraft((current) => {
      const nextLength =
        rulesLength(current) - current[field].length + value.length;
      return nextLength <= CUSTOM_DESIGN_SYSTEM_RULES_MAX_CHARS
        ? { ...current, [field]: value }
        : current;
    });
  };

  const createCustom = async () => {
    if (
      !onCompileCustom ||
      !customDraft.name.trim() ||
      !customDraft.visualDirection.trim() ||
      !customDraft.foundations.trim() ||
      !customDraft.composition.trim()
    ) {
      setError(t.designSystems.customRequired);
      return;
    }
    const conversationId = useConversationStore.getState().activeId;
    setError(null);
    setLoadingId("custom");
    try {
      const compiled = await onCompileCustom(customDraft);
      const reference = await registry.confirmImport(compiled.package);
      setImported(await registry.listImported());
      markManualSelection(reference, conversationId);
      setCustomDraft(EMPTY_CUSTOM_DRAFT);
      returnToCatalog();
    } catch (reason) {
      setError(
        t.designSystems.customCompileFailed.replace(
          "{message}",
          reason instanceof Error ? reason.message : String(reason),
        ),
      );
    } finally {
      setLoadingId(null);
    }
  };

  const selected = designState?.selectedSystem;
  const applied =
    tokenContract.status === "ready" ? tokenContract.appliedSystem : undefined;
  const customRulesLength = rulesLength(customDraft);
  const userSystemGroups = [
    {
      source: "custom" as const,
      label: t.designSystems.custom,
      systems: imported.filter((item) => item.source === "custom"),
    },
    {
      source: "imported" as const,
      label: t.designSystems.imported,
      systems: imported.filter((item) => item.source === "imported"),
    },
  ].filter((group) => group.systems.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[85dvh] sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>
            {view === "custom"
              ? t.designSystems.customTitle
              : t.designSystems.title}
          </DialogTitle>
          <DialogDescription>
            {view === "custom"
              ? t.designSystems.customDescription
              : t.designSystems.description}
          </DialogDescription>
        </DialogHeader>

        <div
          ref={bodyRef}
          data-testid="design-system-scroll-region"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6"
        >
          {view === "custom" ? (
            <div className="mx-auto max-w-2xl space-y-5">
              <div className="space-y-2">
                <label
                  htmlFor="custom-system-name"
                  className="text-sm font-medium"
                >
                  {t.designSystems.customName}
                </label>
                <Input
                  id="custom-system-name"
                  required
                  maxLength={100}
                  value={customDraft.name}
                  placeholder={t.designSystems.customNamePlaceholder}
                  disabled={loadingId !== null}
                  onChange={(event) =>
                    setCustomDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </div>
              {(
                [
                  {
                    field: "visualDirection",
                    label: t.designSystems.customVisualDirection,
                    placeholder:
                      t.designSystems.customVisualDirectionPlaceholder,
                  },
                  {
                    field: "foundations",
                    label: t.designSystems.customFoundations,
                    placeholder: t.designSystems.customFoundationsPlaceholder,
                  },
                  {
                    field: "composition",
                    label: t.designSystems.customComposition,
                    placeholder: t.designSystems.customCompositionPlaceholder,
                  },
                ] as const
              ).map(({ field, label, placeholder }) => (
                <div key={field} className="space-y-2">
                  <label
                    htmlFor={`custom-system-${field}`}
                    className="text-sm font-medium"
                  >
                    {label}
                  </label>
                  <Textarea
                    id={`custom-system-${field}`}
                    required
                    rows={6}
                    value={customDraft[field]}
                    placeholder={placeholder}
                    disabled={loadingId !== null}
                    className="min-h-32 resize-y"
                    onChange={(event) =>
                      updateCustomRule(field, event.target.value)
                    }
                  />
                </div>
              ))}
              <p className="text-right text-xs text-muted-foreground">
                {t.designSystems.customCharacters.replace(
                  "{count}",
                  customRulesLength.toLocaleString(),
                )}
              </p>
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={openCustomView}
                  disabled={loadingId !== null || isGenerating}
                  className="flex min-h-28 items-center gap-3 rounded-xl border border-dashed p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
                    <Plus size={18} aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium">
                      {t.designSystems.createCustom}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t.designSystems.customDescription}
                    </span>
                  </span>
                </button>

                <div className="rounded-xl border border-dashed p-4">
                  <p className="text-sm font-medium">
                    {t.designSystems.importTitle}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.designSystems.importHint}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => zipInputRef.current?.click()}
                      disabled={loadingId !== null}
                    >
                      <PackageOpen size={14} /> {t.designSystems.importZip}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void pickFolder()}
                      disabled={loadingId !== null}
                    >
                      <FolderUp size={14} /> {t.designSystems.importFolder}
                    </Button>
                  </div>
                </div>
              </div>
              <input
                ref={zipInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(event) => void stageZip(event.target.files?.[0])}
              />
              <input
                ref={(node) => {
                  folderInputRef.current = node;
                  node?.setAttribute("webkitdirectory", "");
                }}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => void stageFolder(event.target.files)}
              />

              {staged && (
                <div className="mb-4 rounded-lg bg-muted/60 p-3 text-xs">
                  <div className="font-medium">
                    {staged.summary.name} · {staged.summary.id}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    DESIGN.md {staged.summary.designBytes.toLocaleString()} B ·
                    tokens.css {staged.summary.tokenBytes.toLocaleString()} B ·
                    sha256 {staged.summary.digest.slice(0, 12)}…
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => void confirmImport()}
                      disabled={loadingId !== null}
                    >
                      {t.designSystems.confirmImport}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setStaged(null)}
                      disabled={loadingId !== null}
                    >
                      {t.designSystems.cancelImport}
                    </Button>
                  </div>
                </div>
              )}

              {error && (
                <p role="alert" className="mb-4 text-xs text-destructive">
                  {t.designSystems.importFailed.replace("{message}", error)}
                </p>
              )}

              {applied?.source === "legacy" && (
                <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                  {t.designSystems.legacyReference}
                </div>
              )}

              <button
                type="button"
                onClick={resetAutomaticSelection}
                disabled={loadingId !== null || isGenerating}
                className={cn(
                  "mb-4 flex w-full items-start justify-between gap-4 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !selected && !designState?.recommendation
                    ? "border-violet-500/50 bg-violet-500/5"
                    : "hover:bg-muted/40",
                )}
              >
                <span>
                  <span className="block text-sm font-medium">
                    {t.designSystems.reevaluate}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t.designSystems.automaticHint}
                  </span>
                </span>
                {!selected && !designState?.recommendation && (
                  <Check
                    size={15}
                    className="mt-0.5 shrink-0 text-violet-500"
                  />
                )}
              </button>

              {designState?.autoSelectionError && (
                <p
                  role="alert"
                  className="mb-4 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                >
                  {t.designSystems.automaticFailed}
                </p>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {BUNDLED_DESIGN_SYSTEMS.map((entry) => {
                  const isSelected = selected?.id === entry.id;
                  const isApplied = applied?.id === entry.id;
                  const isRecommended =
                    designState?.recommendation?.systemId === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => void selectBundled(entry)}
                      disabled={loadingId !== null || isGenerating}
                      className={cn(
                        "group overflow-hidden rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                        isSelected
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-foreground/25 hover:bg-muted/40",
                      )}
                    >
                      <img
                        src={entry.previewPath}
                        alt=""
                        aria-hidden="true"
                        loading="lazy"
                        decoding="async"
                        className="aspect-[4/3] w-full border-b object-cover"
                      />
                      <span className="block p-3">
                        <span className="flex items-start justify-between gap-2">
                          <span className="font-medium">{entry.name}</span>
                          {loadingId === entry.id ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : isSelected ? (
                            <Check size={15} className="text-primary" />
                          ) : null}
                        </span>
                        <span className="mt-2 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
                          <span className="font-medium text-foreground/80">
                            {t.designSystems.bestFor}:
                          </span>{" "}
                          {entry.bestFor[language]}
                        </span>
                        <span className="mt-3 flex flex-wrap gap-1">
                          {isRecommended && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-600 dark:text-violet-300">
                              <Sparkles size={10} />
                              {t.designSystems.recommended}
                            </span>
                          )}
                          {isApplied && (
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                              {t.designSystems.applied}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {userSystemGroups.map((group) => (
                <div key={group.source} className="mt-6">
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {group.systems.map((reference) => (
                      <button
                        key={reference.id}
                        type="button"
                        onClick={() => void selectImported(reference)}
                        disabled={loadingId !== null || isGenerating}
                        className={cn(
                          "overflow-hidden rounded-xl border text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                          selected?.id === reference.id &&
                            "border-primary bg-primary/5",
                        )}
                      >
                        <img
                          src={CUSTOM_DESIGN_SYSTEM_PREVIEW_PATH}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                          decoding="async"
                          className="aspect-[4/3] w-full border-b object-cover"
                        />
                        <span className="flex items-center justify-between gap-2 px-3 py-2.5">
                          <span className="truncate">{reference.name}</span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {applied?.id === reference.id && (
                              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                                {t.designSystems.applied}
                              </span>
                            )}
                            {selected?.id === reference.id && (
                              <Check size={14} className="shrink-0" />
                            )}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
                {t.designSystems.sourceNotice}
              </p>
            </>
          )}
        </div>

        {view === "custom" && (
          <DialogFooter className="shrink-0 border-t bg-muted/20 px-4 py-4 sm:px-6">
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={returnToCatalog}
              disabled={loadingId !== null}
            >
              <ArrowLeft size={14} /> {t.designSystems.backToCatalog}
            </Button>
            <Button
              type="button"
              onClick={() => void createCustom()}
              disabled={loadingId !== null || !onCompileCustom}
            >
              {loadingId === "custom" && (
                <Loader2 size={14} className="animate-spin" />
              )}
              {loadingId === "custom"
                ? t.designSystems.creating
                : t.designSystems.createAndSelect}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
