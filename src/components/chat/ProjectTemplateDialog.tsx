import { useEffect, useMemo, useState } from "react";
import {
  FileCode2,
  LayoutTemplate,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useProjectTemplateController } from "../../hooks/useProjectTemplateController";
import { useT } from "../../i18n";
import { requestConfirmation } from "../../lib/confirmation";
import {
  getProjectTemplateStats,
  getProjectTemplateAnalysis,
  getProjectTemplateUsability,
  projectTemplateSearchText,
  type PreparedProjectTemplate,
} from "../../lib/utils/project-templates";
import { formatBytes } from "../../lib/utils/storage-governance";
import type { ProjectTemplate } from "../../types";

export interface ProjectTemplateSaveInput {
  name: string;
  description?: string;
  tags: string[];
}

function interpolate(value: string, replacements: Record<string, string>) {
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) => result.replaceAll(`{${key}}`, replacement),
    value,
  );
}

export function ProjectTemplateDialog() {
  const t = useT();
  const controller = useProjectTemplateController();
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [prepared, setPrepared] = useState<PreparedProjectTemplate | null>(
    null,
  );
  const [updateTargetId, setUpdateTargetId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTags, setEditTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!controller.open) return;
    setName(controller.sourceTitle);
    setDescription("");
    setTagInput("");
    setQuery("");
    setPrepared(null);
    setUpdateTargetId(null);
    setEditingId(null);
    setNotice(null);
  }, [
    controller.open,
    controller.sourceConversation?.id,
    controller.sourceTitle,
  ]);

  const sourceStats = useMemo(
    () =>
      controller.sourceConversation
        ? getProjectTemplateStats(controller.sourceConversation)
        : { fileCount: 0, totalBytes: 0 },
    [controller.sourceConversation],
  );
  const canPrepare =
    controller.isReady && sourceStats.fileCount > 0 && Boolean(name.trim());
  const canUpdate = controller.isReady && sourceStats.fileCount > 0;
  const filteredTemplates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return controller.templates;
    return controller.templates.filter((template) =>
      projectTemplateSearchText(template).includes(normalized),
    );
  }, [controller.templates, query]);

  const prepareInput = (
    template?: ProjectTemplate,
  ): ProjectTemplateSaveInput => ({
    name: template?.name ?? name,
    description: template?.description ?? description,
    tags: template?.tags ?? tagInput.split(/[,，]/),
  });

  const reviewSafeCopy = async (template?: ProjectTemplate) => {
    if (!controller.isReady) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = await controller.prepareCurrent(prepareInput(template));
      setPrepared(next);
      setUpdateTargetId(template?.id ?? null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const reviewUpgrade = async (templateId: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const next = await controller.prepareUpgrade(templateId);
      setPrepared(next);
      setUpdateTargetId(templateId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmPrepared = async () => {
    if (!prepared) return;
    setBusy(true);
    setNotice(null);
    try {
      if (updateTargetId) {
        const result = await controller.updatePrepared(
          updateTargetId,
          prepared,
        );
        setNotice(
          result === "noop"
            ? t.sessions.templates.unchanged
            : t.sessions.templates.updated,
        );
      } else {
        const result = await controller.savePrepared(prepared);
        setNotice(
          result.status === "noop"
            ? t.sessions.templates.unchanged
            : t.sessions.templates.saved,
        );
      }
      setPrepared(null);
      setUpdateTargetId(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (template: ProjectTemplate) => {
    setEditingId(template.id);
    setEditName(template.name);
    setEditDescription(template.description ?? "");
    setEditTags(template.tags.join(", "));
    setNotice(null);
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    setBusy(true);
    try {
      await controller.editTemplate(editingId, {
        name: editName,
        description: editDescription,
        tags: editTags.split(/[,，]/),
      });
      setEditingId(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const useTemplate = async (templateId: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await controller.useTemplate(templateId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteTemplate = async (templateId: string) => {
    if (
      !(await requestConfirmation({
        title: t.sessions.templates.delete,
        message: t.sessions.templates.deleteConfirm,
        confirmLabel: t.sessions.templates.delete,
        cancelLabel: t.settings.cancel,
        destructive: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await controller.deleteTemplate(templateId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!controller.open) return null;

  return (
    <Dialog open onOpenChange={(next) => !next && controller.closeLibrary()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-14">
          <div className="flex items-center gap-3">
            <DialogTitle>{t.sessions.templates.title}</DialogTitle>
            <Badge variant="secondary">{controller.templates.length}</Badge>
          </div>
          <DialogDescription>
            {t.sessions.templates.libraryDescription}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 p-4 sm:p-5">
          <section
            aria-labelledby="starter-library-heading"
            className="space-y-3"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h3
                id="starter-library-heading"
                className="flex items-center gap-2 text-sm font-semibold"
              >
                <LayoutTemplate size={16} aria-hidden="true" />
                {t.sessions.templates.library}
              </h3>
              <div className="relative w-full sm:max-w-xs">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label={t.sessions.templates.searchPlaceholder}
                  placeholder={t.sessions.templates.searchPlaceholder}
                  className="h-9 pl-8 text-sm"
                />
              </div>
            </div>

            {filteredTemplates.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                {controller.templates.length === 0
                  ? t.sessions.templates.empty
                  : t.sessions.templates.emptySearch}
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {filteredTemplates.map((template) => {
                  const stats = getProjectTemplateStats(template);
                  const usability = getProjectTemplateUsability(template);
                  const usable = usability.ok;
                  const editing = editingId === template.id;
                  const analysis = getProjectTemplateAnalysis(template);
                  const unavailableReason = usability.ok
                    ? null
                    : t.sessions.templates.unavailableReasons[usability.reason];
                  const canSafelyUpgrade =
                    !usability.ok &&
                    usability.reason !== "unsupported-runtime" &&
                    usability.reason !== "invalid-files";
                  return (
                    <article
                      key={template.id}
                      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
                    >
                      {editing ? (
                        <div className="space-y-2">
                          <Input
                            value={editName}
                            onChange={(event) =>
                              setEditName(event.target.value)
                            }
                            aria-label={t.sessions.templates.namePlaceholder}
                            className="h-8 text-sm"
                          />
                          <Textarea
                            value={editDescription}
                            onChange={(event) =>
                              setEditDescription(event.target.value)
                            }
                            aria-label={
                              t.sessions.templates.descriptionPlaceholder
                            }
                            className="min-h-16 resize-none text-sm"
                          />
                          <Input
                            value={editTags}
                            onChange={(event) =>
                              setEditTags(event.target.value)
                            }
                            aria-label={t.sessions.templates.tagsPlaceholder}
                            className="h-8 text-sm"
                          />
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void saveEdit()}
                              disabled={busy || !editName.trim()}
                            >
                              {t.sessions.templates.saveMetadata}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingId(null)}
                            >
                              {t.sessions.templates.cancelEdit}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <h4 className="truncate text-sm font-semibold">
                                {template.name}
                              </h4>
                              {!usable && (
                                <Badge variant="outline" className="shrink-0">
                                  {unavailableReason}
                                </Badge>
                              )}
                            </div>
                            {template.description && (
                              <p className="line-clamp-2 text-xs text-muted-foreground">
                                {template.description}
                              </p>
                            )}
                          </div>

                          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {analysis && (
                              <>
                                <div>
                                  <dt className="sr-only">
                                    {t.sessions.templates.framework}
                                  </dt>
                                  <dd>{analysis.framework}</dd>
                                </div>
                                <div>
                                  <dt className="sr-only">
                                    {t.sessions.templates.language}
                                  </dt>
                                  <dd>{analysis.language}</dd>
                                </div>
                              </>
                            )}
                            {analysis.tests.length > 0 && (
                              <div className="col-span-2">
                                <dt className="inline">
                                  {t.sessions.templates.tests}:{" "}
                                </dt>
                                <dd className="inline text-foreground">
                                  {analysis.tests.join(", ")}
                                </dd>
                              </div>
                            )}
                            {analysis.designSystem && (
                              <div className="col-span-2">
                                <dt className="inline">
                                  {t.sessions.templates.designSystem}:{" "}
                                </dt>
                                <dd className="inline text-foreground">
                                  {analysis.designSystem}
                                </dd>
                              </div>
                            )}
                            <div>
                              <dt className="sr-only">
                                {t.sessions.templates.files}
                              </dt>
                              <dd className="inline-flex items-center gap-1">
                                <FileCode2 size={12} aria-hidden="true" />
                                {stats.fileCount} ·{" "}
                                {formatBytes(stats.totalBytes)}
                              </dd>
                            </div>
                            {template.sourceUpdatedAt && (
                              <div>
                                <dt className="sr-only">
                                  {t.sessions.templates.sourceFreshness}
                                </dt>
                                <dd>
                                  {interpolate(
                                    t.sessions.templates.sourceFreshness,
                                    {
                                      date: new Date(
                                        template.sourceUpdatedAt,
                                      ).toLocaleDateString(),
                                    },
                                  )}
                                </dd>
                              </div>
                            )}
                          </dl>

                          {(template.tags.length > 0 ||
                            (analysis?.autoTags.length ?? 0) > 0) && (
                            <div className="flex flex-wrap gap-1.5">
                              {[...template.tags, ...(analysis?.autoTags ?? [])]
                                .filter(
                                  (tag, index, all) =>
                                    all.indexOf(tag) === index,
                                )
                                .map((tag) => (
                                  <Badge key={tag} variant="secondary">
                                    <Tag size={10} aria-hidden="true" />
                                    {tag}
                                  </Badge>
                                ))}
                            </div>
                          )}

                          <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                            <Button
                              type="button"
                              size="sm"
                              className="gap-1.5"
                              onClick={() => void useTemplate(template.id)}
                              disabled={busy || !controller.isReady || !usable}
                            >
                              <Play size={13} aria-hidden="true" />
                              {t.sessions.templates.create}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              onClick={() => void reviewSafeCopy(template)}
                              disabled={busy || !canUpdate}
                            >
                              <RefreshCw size={13} aria-hidden="true" />
                              {t.sessions.templates.updateCurrent}
                            </Button>
                            {canSafelyUpgrade && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="gap-1.5"
                                onClick={() => void reviewUpgrade(template.id)}
                                disabled={busy || !controller.isReady}
                              >
                                <ShieldCheck size={13} aria-hidden="true" />
                                {t.sessions.templates.upgradeSafely}
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="gap-1.5"
                              onClick={() => beginEdit(template)}
                              disabled={busy || !controller.isReady}
                            >
                              <Pencil size={13} aria-hidden="true" />
                              {t.sessions.templates.edit}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="gap-1.5 text-destructive hover:text-destructive"
                              onClick={() => void deleteTemplate(template.id)}
                              disabled={busy || !controller.isReady}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                              {t.sessions.templates.delete}
                            </Button>
                          </div>
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section
            aria-labelledby="save-current-project-heading"
            className="space-y-3 border-t pt-5"
          >
            <h3
              id="save-current-project-heading"
              className="flex items-center gap-2 text-sm font-semibold"
            >
              <Save size={16} aria-hidden="true" />
              {t.sessions.templates.saveCurrent}
            </h3>

            {prepared ? (
              <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ShieldCheck size={16} aria-hidden="true" />
                  {t.sessions.templates.safePreview}
                </div>
                {prepared.report.excludedPaths.length === 0 &&
                prepared.report.redactedPaths.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t.sessions.templates.noSensitiveChanges}
                  </p>
                ) : (
                  <div className="space-y-2 text-xs">
                    {prepared.report.excludedPaths.length > 0 && (
                      <div>
                        <p className="font-medium">
                          {interpolate(t.sessions.templates.excludedCount, {
                            count: String(prepared.report.excludedPaths.length),
                          })}
                        </p>
                        <p className="break-all text-muted-foreground">
                          {prepared.report.excludedPaths.join(", ")}
                        </p>
                      </div>
                    )}
                    {prepared.report.redactedPaths.length > 0 && (
                      <div>
                        <p className="font-medium">
                          {interpolate(t.sessions.templates.redactedCount, {
                            count: String(prepared.report.redactedPaths.length),
                          })}
                        </p>
                        <p className="break-all text-muted-foreground">
                          {prepared.report.redactedPaths.join(", ")}
                        </p>
                      </div>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void confirmPrepared()}
                    disabled={busy}
                  >
                    {updateTargetId
                      ? t.sessions.templates.confirmUpdate
                      : t.sessions.templates.confirmSave}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPrepared(null);
                      setUpdateTargetId(null);
                    }}
                    disabled={busy}
                  >
                    {t.sessions.templates.cancelReview}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t.sessions.templates.namePlaceholder}
                  aria-label={t.sessions.templates.namePlaceholder}
                  className="h-9 text-sm"
                  disabled={!controller.isReady || sourceStats.fileCount === 0}
                />
                <Input
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  placeholder={t.sessions.templates.tagsPlaceholder}
                  aria-label={t.sessions.templates.tagsPlaceholder}
                  className="h-9 text-sm"
                  disabled={!controller.isReady || sourceStats.fileCount === 0}
                />
                <Textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t.sessions.templates.descriptionPlaceholder}
                  aria-label={t.sessions.templates.descriptionPlaceholder}
                  className="min-h-20 resize-none text-sm sm:col-span-2"
                  disabled={!controller.isReady || sourceStats.fileCount === 0}
                />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
                  <span className="inline-flex items-center gap-1">
                    <FileCode2 size={13} aria-hidden="true" />
                    {sourceStats.fileCount}
                  </span>
                  <span>{formatBytes(sourceStats.totalBytes)}</span>
                </div>
                {!controller.isReady && (
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    {t.sessions.templates.loading}
                  </p>
                )}
                {sourceStats.fileCount === 0 && (
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    {t.sessions.templates.emptyProject}
                  </p>
                )}
                <Button
                  type="button"
                  className="gap-2 sm:w-fit"
                  onClick={() => void reviewSafeCopy()}
                  disabled={busy || !canPrepare}
                >
                  <ShieldCheck size={15} aria-hidden="true" />
                  {t.sessions.templates.review}
                </Button>
              </div>
            )}

            {notice && (
              <p role="status" className="text-xs text-muted-foreground">
                {notice}
              </p>
            )}
          </section>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t px-5 py-3">
          <Button
            type="button"
            variant="outline"
            onClick={controller.closeLibrary}
          >
            {t.sessions.templates.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
