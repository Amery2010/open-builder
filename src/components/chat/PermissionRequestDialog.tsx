import { useEffect, useId, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  ProjectPermissionOperation,
  ProjectPermissionScope,
} from "../../lib/security/project-permission-broker";

export type PermissionRequestOperation = ProjectPermissionOperation;
export type PermissionRequestScope = ProjectPermissionScope;

export interface PermissionRequestDialogLabels {
  title: string;
  description: string;
  operation: Record<PermissionRequestOperation, string>;
  affected: string;
  paths: string;
  scope: string;
  exact: string;
  exactDescription: string;
  commonParent: string;
  commonParentDescription: string;
  project: string;
  projectDescription: string;
  deny: string;
  allowOnce: string;
  allowSession: string;
  close: string;
  sessionDisabled: string;
  submitting: string;
  error: string;
}

export interface PermissionRequestDialogProps {
  open: boolean;
  operation: PermissionRequestOperation;
  paths: readonly string[];
  count: number;
  eligibleForSession: boolean;
  commonParent?: string | null;
  submitting: boolean;
  error?: string | null;
  labels: PermissionRequestDialogLabels;
  onDeny: () => void;
  onAllowOnce: () => void;
  onAllowSession: (scope: PermissionRequestScope) => void;
}

type ScopeChoice = "exact" | "subtree" | "project";

function scopeLabel(
  choice: ScopeChoice,
  labels: PermissionRequestDialogLabels,
): string {
  if (choice === "exact") return labels.exact;
  if (choice === "subtree") return labels.commonParent;
  return labels.project;
}

function scopeDescription(
  choice: ScopeChoice,
  labels: PermissionRequestDialogLabels,
): string {
  if (choice === "exact") return labels.exactDescription;
  if (choice === "subtree") return labels.commonParentDescription;
  return labels.projectDescription;
}

export function PermissionRequestDialog({
  open,
  operation,
  paths,
  count,
  eligibleForSession,
  commonParent = null,
  submitting,
  error = null,
  labels,
  onDeny,
  onAllowOnce,
  onAllowSession,
}: PermissionRequestDialogProps) {
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const scopeGroupId = useId();
  const [selectedScope, setSelectedScope] = useState<ScopeChoice>("exact");
  const requestKey = `${operation}\u0000${commonParent ?? ""}\u0000${paths.join("\u0000")}`;
  const sessionEnabled = eligibleForSession && operation !== "replace_project";

  useEffect(() => {
    if (open) setSelectedScope("exact");
  }, [open, requestKey]);

  const handleAllowSession = () => {
    if (!sessionEnabled || submitting) return;

    if (selectedScope === "exact") {
      onAllowSession({ kind: "exact", paths: [...paths] });
      return;
    }
    if (selectedScope === "subtree") {
      if (!commonParent) return;
      onAllowSession({ kind: "subtree", path: commonParent });
      return;
    }
    onAllowSession({ kind: "project" });
  };

  const scopeChoices: ScopeChoice[] = commonParent
    ? ["exact", "subtree", "project"]
    : ["exact", "project"];

  return (
    <Dialog
      open={open}
      modal
      onOpenChange={(next) => {
        if (!next) onDeny();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          denyButtonRef.current?.focus();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        aria-busy={submitting}
      >
        <DialogHeader className="shrink-0 border-b px-5 pb-4 pt-5 pr-14">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-destructive">
            {labels.operation[operation]}
          </p>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>

        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={labels.close}
            className="absolute right-4 top-4 z-20"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </DialogClose>

        <DialogBody className="space-y-5 px-5 py-5">
          <div className="grid gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{labels.affected}</span>
              <strong className="tabular-nums">{count}</strong>
            </div>
            <div className="space-y-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {labels.paths}
              </h2>
              <ul
                aria-label={labels.paths}
                className="max-h-40 space-y-1 overflow-y-auto rounded-md bg-background/70 p-2 font-mono text-xs"
              >
                {paths.map((path) => (
                  <li key={path} className="break-all">
                    {path}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <fieldset
            className="space-y-2"
            disabled={!sessionEnabled || submitting || Boolean(error)}
          >
            <legend className="text-sm font-medium">{labels.scope}</legend>
            <div className="grid gap-2">
              {scopeChoices.map((choice) => {
                const id = `${scopeGroupId}-${choice}`;
                const descriptionId = `${id}-description`;
                const label = scopeLabel(choice, labels);
                const description = scopeDescription(choice, labels);
                const detail =
                  choice === "subtree" && commonParent
                    ? `${description} · ${commonParent}`
                    : description;

                return (
                  <label
                    key={choice}
                    htmlFor={id}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                      "hover:bg-accent/50 focus-within:ring-2 focus-within:ring-ring/50",
                      selectedScope === choice
                        ? "border-primary bg-muted/60"
                        : "border-border/70",
                      (!sessionEnabled || submitting || Boolean(error)) &&
                        "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      id={id}
                      type="radio"
                      name={scopeGroupId}
                      value={choice}
                      checked={selectedScope === choice}
                      onChange={() => setSelectedScope(choice)}
                      aria-describedby={descriptionId}
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {label}
                        {choice === "subtree" && commonParent
                          ? `: ${commonParent}`
                          : ""}
                      </span>
                      <span
                        id={descriptionId}
                        className="mt-0.5 block text-xs leading-snug text-muted-foreground"
                      >
                        {detail}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            {!sessionEnabled && (
              <p className="text-xs leading-snug text-muted-foreground">
                {labels.sessionDisabled}
              </p>
            )}
          </fieldset>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <span className="font-medium">{labels.error}:</span> {error}
            </div>
          )}

          {submitting && (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {labels.submitting}
            </p>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0 border-t bg-muted/20 px-5 py-4 sm:flex-row sm:items-center">
          <Button
            ref={denyButtonRef}
            type="button"
            variant="outline"
            onClick={onDeny}
            disabled={submitting}
          >
            {error && !submitting ? labels.close : labels.deny}
          </Button>
          {(!error || submitting) && (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={onAllowOnce}
                disabled={submitting}
              >
                {labels.allowOnce}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleAllowSession}
                disabled={!sessionEnabled || submitting}
              >
                {labels.allowSession}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
