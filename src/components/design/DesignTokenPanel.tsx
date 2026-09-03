import { useEffect, useMemo, useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "../../i18n";
import type { ConversationDesignState, ProjectFiles } from "../../types";
import {
  EDITABLE_DESIGN_TOKENS,
  inspectDesignTokenContract,
  readEditableTokenValues,
  writeEditableTokenValues,
  type EditableTokenValues,
} from "../../lib/design/tokens";
import type { DesignTokenChange } from "../../lib/design/token-mutation";

interface DesignTokenPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: ProjectFiles;
  designState?: ConversationDesignState;
  onCommit: (changes: readonly DesignTokenChange[]) => Promise<void> | void;
  onUpgrade: () => void;
  isGenerating: boolean;
}

export function DesignTokenPanel({
  open,
  onOpenChange,
  files,
  designState,
  onCommit,
  onUpgrade,
  isGenerating,
}: DesignTokenPanelProps) {
  const t = useT();
  const contract = useMemo(
    () => inspectDesignTokenContract(files, designState),
    [designState, files],
  );
  const tokensPath = contract.status === "ready" ? contract.path : undefined;
  const source = contract.status === "ready" ? contract.source : undefined;
  const editable = contract.status === "ready";
  const initialValues = useMemo(
    () => (source ? readEditableTokenValues(source) : {}),
    [source],
  );
  const [values, setValues] = useState<EditableTokenValues>(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(initialValues);
    setError(null);
    setDirty(false);
  }, [initialValues, open]);

  const updateValue = (property: string, value: string) => {
    if (!source || !tokensPath) return;
    const nextValues = { ...values, [property]: value };
    setValues(nextValues);
    setDirty(true);
    try {
      writeEditableTokenValues(source, nextValues);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const close = () => {
    onOpenChange(false);
  };

  const reset = () => {
    setValues(initialValues);
    setDirty(false);
    setError(null);
  };

  const save = async () => {
    if (!source || !tokensPath || error) return;
    try {
      writeEditableTokenValues(source, values);
      const changes = EDITABLE_DESIGN_TOKENS.flatMap(({ property }) => {
        const value = values[property];
        return value !== undefined && value.trim() !== initialValues[property]
          ? [{ token: property, value }]
          : [];
      });
      if (!changes.length) {
        onOpenChange(false);
        return;
      }
      setSaving(true);
      await onCommit(changes);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="flex min-h-0 max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>{t.designTokens.title}</DialogTitle>
          <DialogDescription>{t.designTokens.description}</DialogDescription>
        </DialogHeader>

        <DialogBody className="px-6 py-5">
          {!editable ? (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
              <div className="flex gap-3">
                <AlertCircle
                  size={18}
                  className="mt-0.5 shrink-0 text-amber-600"
                />
                <div>
                  <p className="text-sm font-medium">
                    {contract.status === "legacy"
                      ? t.designTokens.legacyTitle
                      : contract.status === "selected-unapplied"
                        ? t.designTokens.pendingTitle
                        : contract.status === "invalid"
                          ? t.designTokens.invalidTitle
                          : contract.status === "missing" &&
                              contract.appliedSystem
                            ? t.designTokens.missingTitle
                            : t.designTokens.unavailableTitle}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {contract.status === "legacy"
                      ? t.designTokens.legacyDescription
                      : contract.status === "selected-unapplied"
                        ? t.designTokens.pendingDescription.replace(
                            "{name}",
                            contract.selectedSystem.name,
                          )
                        : contract.status === "invalid"
                          ? t.designTokens.invalidDescription
                          : contract.status === "missing" &&
                              contract.appliedSystem
                            ? t.designTokens.missingDescription
                            : t.designTokens.unavailableDescription}
                  </p>
                  <Button size="sm" className="mt-3" onClick={onUpgrade}>
                    {t.designTokens.chooseSystem}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {(
                ["colors", "typography", "shape", "layout", "motion"] as const
              ).map((group) => {
                const fields = EDITABLE_DESIGN_TOKENS.filter(
                  (definition) =>
                    definition.group === group &&
                    values[definition.property] !== undefined,
                );
                if (!fields.length) return null;
                return (
                  <section key={group}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {t.designTokens.groups[group]}
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {fields.map((definition) => (
                        <label
                          key={definition.property}
                          className="space-y-1.5"
                        >
                          <span className="text-xs font-medium">
                            {t.designTokens.fields[definition.labelKey]}
                          </span>
                          <Input
                            value={values[definition.property] ?? ""}
                            onChange={(event) =>
                              updateValue(
                                definition.property,
                                event.target.value,
                              )
                            }
                            className="h-9 font-mono text-xs"
                            spellCheck={false}
                            disabled={isGenerating}
                          />
                        </label>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-4 text-xs text-destructive">
              {error}
            </p>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0 border-t bg-muted/20 px-6 py-4">
          {editable && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={reset}
              disabled={!dirty || isGenerating || saving}
            >
              <RotateCcw size={14} /> {t.designTokens.reset}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={close}
            disabled={saving}
          >
            {t.designTokens.cancel}
          </Button>
          {editable && (
            <Button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || !!error || isGenerating || saving}
            >
              {t.designTokens.save}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
