import { useState, type ReactNode } from "react";
import { Archive, RotateCcw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  archiveRecordKey,
  useProjectArchiveStore,
} from "../../store/project-archives";
import { downloadSnapshotArchive } from "../../lib/project-archives/download";

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
  onDownloadStart?: (snapshotId: string) => void;
  onDownloadError?: (snapshotId: string, error: string) => void;
}

interface ArchiveDownloadState {
  snapshotId: string | null;
  errors: Record<string, string>;
}

function archiveLabel(
  snapshotId: string,
  fileName: string | undefined,
): string {
  return fileName || snapshotId;
}

function ActionButton({
  ariaLabel,
  disabled,
  onClick,
  children,
}: {
  ariaLabel: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-busy={disabled}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Compact source action used beside message actions. */
export function ProjectArchiveAction({
  conversationId,
  snapshotIds,
  labels,
  onDownloadStart,
  onDownloadError,
}: ProjectArchiveActionProps) {
  const records = useProjectArchiveStore((state) => state.records);
  const [downloadState, setDownloadState] = useState<ArchiveDownloadState>({
    snapshotId: null,
    errors: {},
  });
  const distinctSnapshotIds = [...new Set(snapshotIds)];
  if (distinctSnapshotIds.length === 0) return null;

  const download = async (snapshotId: string) => {
    onDownloadStart?.(snapshotId);
    setDownloadState((current) => ({
      snapshotId,
      errors: { ...current.errors, [snapshotId]: "" },
    }));
    try {
      await downloadSnapshotArchive(conversationId, snapshotId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      onDownloadError?.(snapshotId, message);
      setDownloadState((current) => ({
        snapshotId: null,
        errors: {
          ...current.errors,
          [snapshotId]: message,
        },
      }));
      return;
    }
    setDownloadState((current) => ({
      ...current,
      snapshotId: null,
    }));
  };

  const getRecord = (snapshotId: string) =>
    records[archiveRecordKey(conversationId, snapshotId)];
  const isPending = (snapshotId: string) =>
    downloadState.snapshotId === snapshotId ||
    getRecord(snapshotId)?.status === "pending";
  const hasFailed = (snapshotId: string) =>
    Boolean(downloadState.errors[snapshotId]) ||
    getRecord(snapshotId)?.status === "failed";
  const sourceLabel = labels.source ?? labels.download;
  const hasFailedSnapshot = distinctSnapshotIds.some(hasFailed);
  const hasActiveDownload = downloadState.snapshotId !== null;
  const actionIcon = hasFailedSnapshot ? (
    <RotateCcw className="size-3.5" aria-hidden="true" />
  ) : (
    <Archive className="size-3.5" aria-hidden="true" />
  );

  if (distinctSnapshotIds.length === 1) {
    const snapshotId = distinctSnapshotIds[0];
    const failed = hasFailed(snapshotId);
    return (
      <>
        <ActionButton
          ariaLabel={failed ? labels.retry : labels.download}
          disabled={isPending(snapshotId)}
          onClick={() => void download(snapshotId)}
        >
          {failed ? (
            <RotateCcw className="size-3.5" aria-hidden="true" />
          ) : (
            <Archive className="size-3.5" aria-hidden="true" />
          )}
          <span>{isPending(snapshotId) ? labels.preparing : sourceLabel}</span>
        </ActionButton>
        {downloadState.errors[snapshotId] && (
          <span className="text-xs text-destructive" role="alert">
            {downloadState.errors[snapshotId]}
          </span>
        )}
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={hasFailedSnapshot ? labels.retry : labels.download}
            aria-busy={hasActiveDownload}
            disabled={hasActiveDownload}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {actionIcon}
            <span>{sourceLabel}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{sourceLabel}</DropdownMenuLabel>
          {distinctSnapshotIds.map((snapshotId) => {
            const record = getRecord(snapshotId);
            const failed = hasFailed(snapshotId);
            const pending = isPending(snapshotId);
            const error = downloadState.errors[snapshotId];
            return (
              <DropdownMenuItem
                key={snapshotId}
                disabled={
                  pending ||
                  (hasActiveDownload && downloadState.snapshotId !== snapshotId)
                }
                onSelect={() => void download(snapshotId)}
              >
                <span className="min-w-0 truncate">
                  {archiveLabel(snapshotId, record?.fileName)}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {pending
                    ? labels.preparing
                    : failed
                      ? labels.retry
                      : sourceLabel}
                </span>
                {error && <span className="sr-only">{error}</span>}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {Object.values(downloadState.errors).some(Boolean) && (
        <span className="text-xs text-destructive" role="alert">
          {Object.values(downloadState.errors).filter(Boolean).join(" ")}
        </span>
      )}
    </>
  );
}

export function ProjectArchiveCard({
  conversationId,
  snapshotId,
  labels,
}: {
  conversationId: string;
  snapshotId: string;
  labels: ProjectArchiveLabels;
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
        onDownloadStart={() => setError(undefined)}
        onDownloadError={(_snapshotId, cause) => setError(cause)}
      />
    </div>
  );
}
