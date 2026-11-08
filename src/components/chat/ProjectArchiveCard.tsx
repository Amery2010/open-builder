import { useState } from "react";
import { Archive, Download } from "lucide-react";
import {
  archiveRecordKey,
  useProjectArchiveStore,
} from "../../store/project-archives";
import { downloadSnapshotArchive } from "../../lib/project-archives/download";
import { ProjectDownloadMenu } from "../code-viewer/ProjectDownloadMenu";
import { useT } from "../../i18n";

export interface ProjectArchiveLabels {
  title: string;
  source?: string;
  download: string;
  preparing: string;
  failed: string;
  retry: string;
}

interface ProjectArchiveActionProps {
  conversationId: string;
  snapshotIds: readonly string[];
  labels: ProjectArchiveLabels;
  onBuildSnapshot: (snapshotId: string) => void;
  onDownloadStart?: (snapshotId: string) => void;
  onDownloadError?: (snapshotId: string, error: string) => void;
}

/** History actions keep their version identity; the stable parent owns the build dialog. */
export function ProjectArchiveAction({
  conversationId,
  snapshotIds,
  labels,
  onBuildSnapshot,
  onDownloadStart,
  onDownloadError,
}: ProjectArchiveActionProps) {
  const t = useT().projectBuild;
  const records = useProjectArchiveStore((state) => state.records);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ids = [...new Set(snapshotIds)];
  if (!ids.length) return null;

  async function download(snapshotId: string): Promise<void> {
    onDownloadStart?.(snapshotId);
    setPendingId(snapshotId);
    setErrors((previous) => ({ ...previous, [snapshotId]: "" }));
    try {
      await downloadSnapshotArchive(conversationId, snapshotId);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      setErrors((previous) => ({ ...previous, [snapshotId]: error }));
      onDownloadError?.(snapshotId, error);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <ProjectDownloadMenu
        align="start"
        trigger={
          <button
            type="button"
            aria-label={t.menuLabel}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Download className="size-3.5" aria-hidden="true" />
            <span>{t.menuLabel}</span>
          </button>
        }
        versions={ids.map((id) => {
          const record = records[archiveRecordKey(conversationId, id)];
          const pending = pendingId === id || record?.status === "pending";
          return {
            id,
            label: record?.fileName ?? id,
            sourceDisabled: pending || pendingId !== null,
            sourceStatus: pending
              ? labels.preparing
              : errors[id] || record?.status === "failed"
                ? labels.retry
                : undefined,
          };
        })}
        onSource={(id) => void download(id)}
        onBuild={onBuildSnapshot}
      />
      {Object.values(errors).some(Boolean) && (
        <span className="text-xs text-destructive" role="alert">
          {Object.values(errors).filter(Boolean).join(" ")}
        </span>
      )}
    </>
  );
}

export function ProjectArchiveCard({
  conversationId,
  snapshotId,
  labels,
  onBuildSnapshot,
}: {
  conversationId: string;
  snapshotId: string;
  labels: ProjectArchiveLabels;
  onBuildSnapshot: (snapshotId: string) => void;
}) {
  const record = useProjectArchiveStore(
    (state) => state.records[archiveRecordKey(conversationId, snapshotId)],
  );
  const [error, setError] = useState<string>();
  return (
    <div
      className="my-2 flex min-w-0 flex-wrap items-center gap-2 px-1 py-1"
      aria-busy={record?.status === "pending"}
    >
      <Archive
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="break-all text-xs font-medium text-foreground">
          {record?.fileName ?? labels.title}
        </p>
        <p className="text-xs text-muted-foreground" role="status">
          {record?.status === "pending"
            ? labels.preparing
            : record?.status === "failed" || error
              ? labels.failed
              : record?.status === "ready"
                ? `${(record.size / 1024).toFixed(1)} KB · ZIP`
                : "ZIP"}
        </p>
        {(error || record?.error) && (
          <p className="mt-1 break-words text-xs text-destructive" role="alert">
            {error || record?.error}
          </p>
        )}
      </div>
      <ProjectArchiveAction
        conversationId={conversationId}
        snapshotIds={[snapshotId]}
        labels={labels}
        onBuildSnapshot={onBuildSnapshot}
        onDownloadStart={() => setError(undefined)}
        onDownloadError={(_snapshotId, cause) => setError(cause)}
      />
    </div>
  );
}
