import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "../../i18n";
import type { ProjectDesign } from "../../lib/design/project-design";

interface ProjectDesignOutlineDialogProps {
  open: boolean;
  design: ProjectDesign;
  onOpenChange: (open: boolean) => void;
  onSave: (design: ProjectDesign) => Promise<void> | void;
}

function nextUiRevision(revision: string | number): string | number {
  return typeof revision === "number"
    ? revision + 1
    : `ui-${Date.now().toString(36)}`;
}

export function ProjectDesignOutlineDialog({
  open,
  design,
  onOpenChange,
  onSave,
}: ProjectDesignOutlineDialogProps) {
  const t = useT();
  const [productGoal, setProductGoal] = useState(design.productGoal ?? "");
  const [audience, setAudience] = useState(design.audience ?? "");
  const [pages, setPages] = useState(() =>
    design.pages.map((page) => ({
      id: page.id,
      name: page.name,
      responsibility: page.responsibility ?? "",
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setProductGoal(design.productGoal ?? "");
    setAudience(design.audience ?? "");
    setPages(
      design.pages.map((page) => ({
        id: page.id,
        name: page.name,
        responsibility: page.responsibility ?? "",
      })),
    );
    setError(undefined);
  }, [design, open]);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        ...design,
        productGoal: productGoal.trim() || undefined,
        audience: audience.trim() || undefined,
        revision: nextUiRevision(design.revision),
        pages: design.pages.map((page) => {
          const edit = pages.find((candidate) => candidate.id === page.id);
          return edit
            ? {
                ...page,
                name: edit.name || page.id,
                responsibility: edit.responsibility.trim() || undefined,
              }
            : page;
        }),
      });
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.prototypeWorkspace.editTitle}</DialogTitle>
          <DialogDescription>
            {t.prototypeWorkspace.editDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5 pr-1">
          <div className="grid gap-2">
            <Label htmlFor="project-design-goal">
              {t.prototypeWorkspace.productGoal}
            </Label>
            <Textarea
              id="project-design-goal"
              value={productGoal}
              onChange={(event) => setProductGoal(event.currentTarget.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-design-audience">
              {t.prototypeWorkspace.audience}
            </Label>
            <Input
              id="project-design-audience"
              value={audience}
              onChange={(event) => setAudience(event.currentTarget.value)}
            />
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-medium">
              {t.prototypeWorkspace.pages}
            </h3>
            {pages.map((page, index) => (
              <section key={page.id} className="rounded-lg border p-3">
                <p className="mb-3 text-xs font-medium text-muted-foreground">
                  {page.id}
                </p>
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`project-page-name-${index}`}>
                      {t.prototypeWorkspace.pageName}
                    </Label>
                    <Input
                      id={`project-page-name-${index}`}
                      value={page.name}
                      onChange={(event) => {
                        const name = event.currentTarget.value;
                        setPages((current) =>
                          current.map((candidate) =>
                            candidate.id === page.id
                              ? {
                                  ...candidate,
                                  name,
                                }
                              : candidate,
                          ),
                        );
                      }}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`project-page-responsibility-${index}`}>
                      {t.prototypeWorkspace.pageResponsibility}
                    </Label>
                    <Textarea
                      id={`project-page-responsibility-${index}`}
                      value={page.responsibility}
                      onChange={(event) => {
                        const responsibility = event.currentTarget.value;
                        setPages((current) =>
                          current.map((candidate) =>
                            candidate.id === page.id
                              ? {
                                  ...candidate,
                                  responsibility,
                                }
                              : candidate,
                          ),
                        );
                      }}
                    />
                  </div>
                </div>
              </section>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.prototypeWorkspace.cancelOutline}
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving
              ? t.prototypeWorkspace.savingOutline
              : t.prototypeWorkspace.saveOutline}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
