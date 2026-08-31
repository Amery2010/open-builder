import { useMemo, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Eye,
  Pencil,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { saveAs } from "file-saver";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { Input } from "@/components/ui/input";
import { requestConfirmation } from "@/lib/confirmation";
import { useSnapshotStore } from "../../store/snapshot";
import { findPrecedingUserLabel } from "../../lib/utils/message-navigation";
import {
  buildProjectPatch,
  projectPatchFileName,
} from "../../lib/utils/project-patch-export";
import {
  getNextVisibleCount,
  getVisibleListWindow,
} from "../../lib/utils/list-window";
import { useT } from "../../i18n";
import type { Message, ProjectSnapshot } from "../../types";

interface SnapshotHistoryDialogProps {
  conversationId: string;
  messages: Message[];
  onClose: () => void;
  onShowDiff: (messageId: string) => void;
  onRollback: (messageId: string) => void;
}

const SNAPSHOT_HISTORY_BATCH = 80;

function snapshotStats(snapshot: ProjectSnapshot) {
  return {
    added: Object.keys(snapshot.addedFiles).length,
    modified: Object.keys(snapshot.patches).length,
    deleted: snapshot.deletedFiles.length,
  };
}

export function SnapshotHistoryDialog({
  conversationId,
  messages,
  onClose,
  onShowDiff,
  onRollback,
}: SnapshotHistoryDialogProps) {
  const t = useT();
  const snapshots = useSnapshotStore((s) => s.snapshots[conversationId] ?? []);
  const renameSnapshot = useSnapshotStore((s) => s.renameSnapshot);
  const deleteSnapshot = useSnapshotStore((s) => s.deleteSnapshot);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(SNAPSHOT_HISTORY_BATCH);

  const items = useMemo(() => [...snapshots].reverse(), [snapshots]);
  const itemWindow = useMemo(
    () => getVisibleListWindow(items, visibleCount),
    [items, visibleCount],
  );

  const startEdit = (snapshot: ProjectSnapshot) => {
    setEditingId(snapshot.id);
    setEditingLabel(
      snapshot.label ||
        findPrecedingUserLabel(messages, snapshot.messageId) ||
        "",
    );
  };

  const commitEdit = () => {
    if (!editingId) return;
    renameSnapshot(conversationId, editingId, editingLabel);
    setEditingId(null);
    setEditingLabel("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingLabel("");
  };

  const handleDelete = async (snapshotId: string) => {
    if (
      !(await requestConfirmation({
        title: t.snapshots.delete,
        message: t.snapshots.deleteConfirm,
        confirmLabel: t.snapshots.delete,
        cancelLabel: t.settings.cancel,
        destructive: true,
      }))
    ) {
      return;
    }
    deleteSnapshot(conversationId, snapshotId);
  };

  const getPatchForSnapshot = (snapshot: ProjectSnapshot) => {
    const index = snapshots.findIndex((item) => item.id === snapshot.id);
    const reconstructFiles = useSnapshotStore.getState().reconstructFiles;
    const previousFiles =
      index > 0
        ? reconstructFiles(conversationId, snapshots[index - 1].id)
        : {};
    const currentFiles = reconstructFiles(conversationId, snapshot.id);
    return buildProjectPatch(previousFiles, currentFiles, {
      fromLabel: index > 0 ? "previous snapshot" : "empty project",
      toLabel: snapshot.label || "snapshot",
    });
  };

  const handleCopyPatch = async (snapshot: ProjectSnapshot) => {
    const patch = getPatchForSnapshot(snapshot);
    if (!patch) {
      setNotice(t.snapshots.patchEmpty);
      return;
    }
    await navigator.clipboard.writeText(patch);
    setNotice(t.snapshots.patchCopied);
  };

  const handleDownloadPatch = (snapshot: ProjectSnapshot, label: string) => {
    const patch = getPatchForSnapshot(snapshot);
    if (!patch) {
      setNotice(t.snapshots.patchEmpty);
      return;
    }
    const blob = new Blob([patch], { type: "text/x-patch;charset=utf-8" });
    saveAs(blob, projectPatchFileName(label));
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex min-h-0 max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-5 pt-5 pb-3">
          <DialogTitle>{t.snapshots.title}</DialogTitle>
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
        </DialogHeader>

        <DialogBody>
          {items.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground text-center">
              {t.snapshots.empty}
            </p>
          ) : (
            <div className="divide-y">
              {itemWindow.visible.map((snapshot) => {
                const stats = snapshotStats(snapshot);
                const label =
                  snapshot.label ||
                  findPrecedingUserLabel(messages, snapshot.messageId) ||
                  t.rollback.initialState;
                const isEditing = editingId === snapshot.id;
                return (
                  <div
                    key={snapshot.id}
                    className="px-4 py-3 flex items-start gap-3"
                  >
                    <div className="min-w-0 flex-1 space-y-2">
                      {isEditing ? (
                        <div className="flex items-center gap-1.5">
                          <Input
                            value={editingLabel}
                            onChange={(e) => setEditingLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdit();
                              if (e.key === "Escape") cancelEdit();
                            }}
                            className="h-8 text-sm"
                            autoFocus
                          />
                          <TooltipIconButton
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={commitEdit}
                            label={t.snapshots.saveName}
                          >
                            <Check size={15} />
                          </TooltipIconButton>
                          <TooltipIconButton
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={cancelEdit}
                            label={t.snapshots.cancelName}
                          >
                            <X size={15} />
                          </TooltipIconButton>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {label}
                          </p>
                          <Badge variant="secondary" className="shrink-0">
                            {snapshot.kind === "checkpoint"
                              ? t.snapshots.checkpoint
                              : t.snapshots.patch}
                          </Badge>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          {new Date(snapshot.createdAt).toLocaleString()}
                        </span>
                        <span>
                          {t.snapshots.added}: {stats.added}
                        </span>
                        <span>
                          {t.snapshots.modified}: {stats.modified}
                        </span>
                        <span>
                          {t.snapshots.deleted}: {stats.deleted}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <TooltipIconButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => onShowDiff(snapshot.messageId)}
                        label={t.snapshots.viewDiff}
                      >
                        <Eye size={15} />
                      </TooltipIconButton>
                      <TooltipIconButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => void handleCopyPatch(snapshot)}
                        label={t.snapshots.copyPatch}
                      >
                        <Copy size={15} />
                      </TooltipIconButton>
                      <TooltipIconButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleDownloadPatch(snapshot, label)}
                        label={t.snapshots.downloadPatch}
                      >
                        <Download size={15} />
                      </TooltipIconButton>
                      <TooltipIconButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => onRollback(snapshot.messageId)}
                        label={t.snapshots.restore}
                      >
                        <Undo2 size={15} />
                      </TooltipIconButton>
                      <TooltipIconButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => startEdit(snapshot)}
                        label={t.snapshots.rename}
                      >
                        <Pencil size={15} />
                      </TooltipIconButton>
                      <TooltipIconButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => void handleDelete(snapshot.id)}
                        label={t.snapshots.delete}
                      >
                        <Trash2 size={15} />
                      </TooltipIconButton>
                    </div>
                  </div>
                );
              })}
              {itemWindow.hasMore && (
                <div className="px-4 py-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-full text-xs text-muted-foreground"
                    onClick={() =>
                      setVisibleCount((count) =>
                        getNextVisibleCount(
                          count,
                          items.length,
                          SNAPSHOT_HISTORY_BATCH,
                        ),
                      )
                    }
                  >
                    {t.snapshots.loadMore.replace(
                      "{count}",
                      String(itemWindow.hiddenCount),
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
