import { useEffect, useMemo, useState } from "react";
import { Archive, Database, History, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requestConfirmation } from "@/lib/confirmation";
import { useT } from "../../../i18n";
import {
  analyzeStorage,
  formatBytes,
} from "../../../lib/utils/storage-governance";
import { useConversationStore } from "../../../store/conversation";
import { useMemoryStore } from "../../../store/memory";
import { useProjectTemplateStore } from "../../../store/project-templates";
import { useSkillsStore } from "../../../store/skills";
import { useSnapshotStore } from "../../../store/snapshot";
import { useProjectDesignWorkspaceStore } from "../../../store/project-design-workspace";

const STORAGE_SNAPSHOT_LIMIT = 20;
type ExtraStorageEstimate = { bytes: number; items: number; error?: string };

export function StorageTab() {
  const t = useT();
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const snapshots = useSnapshotStore((s) => s.snapshots);
  const pruneSnapshots = useSnapshotStore((s) => s.pruneSnapshots);
  const memories = useMemoryStore((s) => s.memories);
  const skills = useSkillsStore((s) => s.skills);
  const templates = useProjectTemplateStore((s) => s.templates);
  const canvasLayouts = useProjectDesignWorkspaceStore((s) => s.layouts);
  const [notice, setNotice] = useState<string | null>(null);
  const [extraDomains, setExtraDomains] = useState<{
    mcp: ExtraStorageEstimate;
    designSystems: ExtraStorageEstimate;
    attachments: ExtraStorageEstimate;
    projectAssets: ExtraStorageEstimate;
    projectArchives: ExtraStorageEstimate;
    designWorkspace: ExtraStorageEstimate;
  }>({
    mcp: { bytes: 0, items: 0 },
    designSystems: { bytes: 0, items: 0 },
    attachments: { bytes: 0, items: 0 },
    projectAssets: { bytes: 0, items: 0 },
    projectArchives: { bytes: 0, items: 0 },
    designWorkspace: { bytes: 0, items: 0 },
  });

  useEffect(() => {
    let active = true;
    void import("../../../lib/storage/registry")
      .then(({ estimateStorageDomains }) => estimateStorageDomains())
      .then((estimates) => {
        if (active) {
          setExtraDomains({
            mcp: estimates.mcp,
            designSystems: estimates.designSystems,
            attachments: estimates.attachments,
            projectAssets: estimates.projectAssets,
            projectArchives: estimates.projectArchives,
            designWorkspace: estimates.designWorkspace,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [conversations, memories, skills, snapshots, templates, canvasLayouts]);

  const report = useMemo(
    () =>
      analyzeStorage({
        conversations,
        activeConversationId: activeId,
        snapshots,
        memories,
        skills,
        templates,
        maxSnapshotsPerConversation: STORAGE_SNAPSHOT_LIMIT,
      }),
    [activeId, conversations, memories, skills, snapshots, templates],
  );

  const showNotice = (count: number) => {
    setNotice(
      count > 0
        ? t.settings.storage.cleaned.replace("{count}", String(count))
        : t.settings.storage.nothingToClean,
    );
  };

  const cleanArchived = async () => {
    const ids = report.cleanup.archivedConversationIds;
    if (ids.length === 0) {
      showNotice(0);
      return;
    }
    if (
      !(await requestConfirmation({
        title: t.settings.storage.cleanupArchived,
        message: t.settings.storage.confirmArchived,
        confirmLabel: t.settings.storage.cleanupArchived,
        cancelLabel: t.settings.cancel,
        destructive: true,
      }))
    ) {
      return;
    }
    ids.forEach(deleteConversation);
    showNotice(ids.length);
  };

  const cleanEmpty = async () => {
    const ids = report.cleanup.emptyConversationIds;
    if (ids.length === 0) {
      showNotice(0);
      return;
    }
    if (
      !(await requestConfirmation({
        title: t.settings.storage.cleanupEmpty,
        message: t.settings.storage.confirmEmpty,
        confirmLabel: t.settings.storage.cleanupEmpty,
        cancelLabel: t.settings.cancel,
        destructive: true,
      }))
    ) {
      return;
    }
    ids.forEach(deleteConversation);
    showNotice(ids.length);
  };

  const pruneOldSnapshots = async () => {
    if (report.cleanup.prunableSnapshotCount === 0) {
      showNotice(0);
      return;
    }
    if (
      !(await requestConfirmation({
        title: t.settings.storage.pruneSnapshots,
        message: t.settings.storage.confirmSnapshots,
        confirmLabel: t.settings.storage.pruneSnapshots,
        cancelLabel: t.settings.cancel,
        destructive: true,
      }))
    ) {
      return;
    }
    showNotice(pruneSnapshots(STORAGE_SNAPSHOT_LIMIT));
  };

  const statItems = [
    {
      label: t.settings.storage.conversations,
      value: report.conversations.count,
      detail: formatBytes(report.conversations.bytes),
    },
    {
      label: t.settings.storage.snapshots,
      value: report.snapshots.count,
      detail: formatBytes(report.snapshots.bytes),
    },
    {
      label: t.settings.storage.projectFiles,
      value: report.conversations.projectFileCount,
      detail: formatBytes(report.conversations.projectFilesBytes),
    },
    {
      label: t.settings.storage.templates,
      value: report.templates.count,
      detail: formatBytes(report.templates.bytes),
    },
    {
      label: t.settings.storage.mcp,
      value: extraDomains.mcp.items,
      detail: formatBytes(extraDomains.mcp.bytes),
    },
    {
      label: t.settings.storage.attachments,
      value: extraDomains.attachments.items,
      detail: formatBytes(extraDomains.attachments.bytes),
    },
    {
      label: t.settings.storage.designSystems,
      value: extraDomains.designSystems.items,
      detail: extraDomains.designSystems.error
        ? t.settings.storage.estimateUnavailable
        : formatBytes(extraDomains.designSystems.bytes),
    },
    {
      label: t.settings.storage.projectArchives,
      value: extraDomains.projectArchives.items,
      detail: extraDomains.projectArchives.error
        ? t.settings.storage.estimateUnavailable
        : formatBytes(extraDomains.projectArchives.bytes),
    },
    {
      label: t.settings.storage.designWorkspace,
      value: extraDomains.designWorkspace.items,
      detail: extraDomains.designWorkspace.error
        ? t.settings.storage.estimateUnavailable
        : formatBytes(extraDomains.designWorkspace.bytes),
    },
    {
      label: t.settings.storage.projectAssets,
      value: extraDomains.projectAssets.items,
      detail: extraDomains.projectAssets.error
        ? t.settings.storage.estimateUnavailable
        : formatBytes(extraDomains.projectAssets.bytes),
    },
  ];

  return (
    <div className="space-y-2">
      <Label>
        <Database size={16} className="inline mr-1" />
        {t.settings.storage.label}
      </Label>
      <div className="rounded-md border border-border bg-muted/30 p-2 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t.settings.storage.total}
          </p>
          <span className="font-mono text-xs font-medium">
            {formatBytes(
              report.totalBytes +
                extraDomains.mcp.bytes +
                extraDomains.designSystems.bytes +
                extraDomains.attachments.bytes +
                extraDomains.projectAssets.bytes +
                extraDomains.designWorkspace.bytes +
                extraDomains.projectArchives.bytes,
            )}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {statItems.map((item) => (
            <div
              key={item.label}
              className="rounded border border-border/70 bg-background/60 px-2 py-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {item.label}
                </span>
                <span className="font-mono text-[11px]">{item.value}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-foreground">
                {item.detail}
              </p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-1.5 text-[11px] text-muted-foreground">
          <span>
            {report.conversations.messagesCount} {t.settings.storage.messages}
          </span>
          <span>
            {report.memories.count} {t.settings.storage.memories}
          </span>
          <span>
            {report.skills.count} {t.settings.storage.skills}
          </span>
          <span>
            {formatBytes(report.conversations.compressedContextBytes)}{" "}
            {t.settings.storage.compressed}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 justify-start px-2 text-xs"
            onClick={cleanArchived}
            disabled={report.cleanup.archivedConversationIds.length === 0}
          >
            <Archive size={13} className="mr-1.5" />
            {t.settings.storage.cleanupArchived}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 justify-start px-2 text-xs"
            onClick={cleanEmpty}
            disabled={report.cleanup.emptyConversationIds.length === 0}
          >
            <Trash2 size={13} className="mr-1.5" />
            {t.settings.storage.cleanupEmpty}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="col-span-2 h-8 justify-start px-2 text-xs"
            onClick={pruneOldSnapshots}
            disabled={report.cleanup.prunableSnapshotCount === 0}
          >
            <History size={13} className="mr-1.5" />
            {t.settings.storage.pruneSnapshots}
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          {t.settings.storage.keepSnapshots}
        </p>
        {notice && (
          <p className="rounded bg-background/80 px-2 py-1 text-[11px] text-foreground">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
