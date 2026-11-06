import { useCallback, useMemo, useState } from "react";
import { diffLines, type Change } from "diff";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useConversationStore } from "../../store/conversation";
import { useSnapshotStore, selectVisibleSnapshots } from "../../store/snapshot";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import { DiffViewer, type DiffMode } from "./diff/DiffViewer";

interface DiffModalProps {
  conversationId: string;
  messageId: string;
  onClose: () => void;
}

interface ChangedFile {
  path: string;
  type: "A" | "M" | "D";
}

export function DiffModal({
  conversationId,
  messageId,
  onClose,
}: DiffModalProps) {
  const t = useT();
  const chain = useSnapshotStore((s) => s.snapshots[conversationId]);
  const conversation = useConversationStore(
    (state) => state.conversations[conversationId],
  );
  const snapshots = useMemo(
    () => selectVisibleSnapshots(conversation, chain ?? []),
    [conversation, chain],
  );
  const snapshot =
    snapshots.find((item) => item.id === messageId) ??
    [...snapshots].reverse().find((item) => item.messageId === messageId);
  const snapshotIndex = snapshots.findIndex((item) => item.id === snapshot?.id);

  const changedFiles = useMemo<ChangedFile[]>(() => {
    if (!snapshot) return [];
    const files: ChangedFile[] = [];
    for (const path of Object.keys(snapshot.addedFiles)) {
      files.push({ path, type: "A" });
    }
    for (const path of Object.keys(snapshot.patches)) {
      files.push({ path, type: "M" });
    }
    for (const path of snapshot.deletedFiles) {
      files.push({ path, type: "D" });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }, [snapshot]);

  const [selectedFile, setSelectedFile] = useState(changedFiles[0]?.path ?? "");
  const [mode, setMode] = useState<DiffMode>("unified");
  const [changeIdx, setChangeIdx] = useState(0);
  const [changeCount, setChangeCount] = useState(0);
  const [jumpTo, setJumpTo] = useState<number | null>(null);

  const diffResult = useMemo<{ changes: Change[]; error?: string }>(() => {
    if (!snapshot || !selectedFile) return { changes: [] };
    try {
      const reconstructFiles = useSnapshotStore.getState().reconstructFiles;
      const parentId =
        snapshot.parentSnapshotId === undefined
          ? snapshots[snapshotIndex - 1]?.id
          : snapshot.parentSnapshotId;
      const prevFiles = parentId
        ? reconstructFiles(conversationId, parentId)
        : {};
      const currFiles = reconstructFiles(conversationId, snapshot.id);
      const oldContent = prevFiles[selectedFile] ?? "";
      const newContent = currFiles[selectedFile] ?? "";
      return { changes: diffLines(oldContent, newContent) };
    } catch (error) {
      return {
        changes: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [snapshot, selectedFile, snapshotIndex, conversationId, snapshots]);
  const diffChanges = diffResult.changes;

  const handleChangeCount = useCallback((count: number) => {
    setChangeCount(count);
    setChangeIdx(0);
  }, []);

  const navigate = (delta: 1 | -1) => {
    if (changeCount === 0) return;
    const next = (changeIdx + delta + changeCount) % changeCount;
    setChangeIdx(next);
    setJumpTo(next);
  };

  if (!snapshot) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-4xl h-[70vh] flex flex-col p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        <DialogHeader className="px-5 pt-5 pb-3 shrink-0 flex flex-row items-center justify-between gap-3">
          <DialogTitle className="flex-1 min-w-0 truncate" title={selectedFile}>
            {t.diff.title}
            {selectedFile && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {selectedFile}
              </span>
            )}
          </DialogTitle>
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden sm:inline-flex rounded-md border border-border overflow-hidden">
              {(
                [
                  { value: "unified", label: t.diff.mode.unified },
                  { value: "split", label: t.diff.mode.split },
                ] as const
              ).map((m, idx) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMode(m.value)}
                  className={cn(
                    "text-xs px-2 py-1 transition-colors cursor-pointer",
                    idx > 0 && "border-l border-border",
                    mode === m.value
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <TooltipIconButton
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => navigate(-1)}
                disabled={changeCount === 0}
                label={t.diff.previous}
              >
                <ChevronUp className="w-4 h-4" />
              </TooltipIconButton>
              <TooltipIconButton
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => navigate(1)}
                disabled={changeCount === 0}
                label={t.diff.next}
              >
                <ChevronDown className="w-4 h-4" />
              </TooltipIconButton>
              {changeCount > 0 && (
                <span className="text-[11px] text-muted-foreground tabular-nums w-12 text-right">
                  {t.diff.changeCount
                    .replace("{current}", String(changeIdx + 1))
                    .replace("{total}", String(changeCount))}
                </span>
              )}
            </div>
          </div>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onClose}
            label={t.diff.close}
          >
            <X className="w-4 h-4" />
          </TooltipIconButton>
        </DialogHeader>

        {diffResult.error && (
          <p role="alert" className="px-5 pb-3 text-sm text-destructive">
            {diffResult.error}
          </p>
        )}
        <div className="flex flex-col sm:flex-row flex-1 min-h-0 overflow-hidden">
          <div
            className={cn(
              "shrink-0 border-b sm:border-b-0 sm:border-r border-border/50",
              "flex sm:flex-col gap-1 px-3 pb-2 sm:pb-3 sm:pt-0 sm:w-48 overflow-x-auto sm:overflow-x-hidden sm:overflow-y-auto",
            )}
          >
            {changedFiles.map((f) => (
              <button
                key={f.path}
                onClick={() => setSelectedFile(f.path)}
                title={f.path}
                className={cn(
                  "text-xs whitespace-nowrap sm:whitespace-normal text-left px-2 py-1.5 rounded cursor-pointer shrink-0 sm:truncate",
                  selectedFile === f.path
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                <span
                  className={cn(
                    "inline-block w-4 font-mono font-bold mr-1",
                    f.type === "A" && "text-green-600",
                    f.type === "M" && "text-yellow-600",
                    f.type === "D" && "text-red-600",
                  )}
                >
                  {f.type}
                </span>
                {f.path}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-auto bg-muted/20">
            {diffChanges.length > 0 ? (
              <DiffViewer
                path={selectedFile}
                changes={diffChanges}
                mode={mode}
                jumpTo={jumpTo}
                onChangeCount={handleChangeCount}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                {t.diff.selectFile}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
