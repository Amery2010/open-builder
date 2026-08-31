import { memo, type RefObject } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Copy,
  Download,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { requestConfirmation } from "@/lib/confirmation";
import { formatDeleteConfirmation } from "@/lib/utils/delete-confirmation";
import { useT } from "../../../i18n";
import type { FileNode } from "./types";
import { BASE_PAD, INDENT } from "./types";
import { InlineInput } from "./InlineInput";

export interface FileTreeNodeProps {
  node: FileNode;
  level: number;
  // Visual state
  expandedFolders: Set<string>;
  selectedFolder: string | null;
  dragOverPath: string | null;
  normalizedCurrentFile: string;
  // Create state
  createState: { type: "file" | "folder"; parent: string } | null;
  createName: string;
  setCreateName: (v: string) => void;
  createInputRef: RefObject<HTMLInputElement | null>;
  confirmCreate: () => void;
  cancelCreate: () => void;
  handleCreateKeyDown: (e: React.KeyboardEvent) => void;
  startCreate: (type: "file" | "folder", parentDir: string) => void;
  // Rename state
  renamingPath: string | null;
  renameName: string;
  setRenameName: (v: string) => void;
  renameInputRef: RefObject<HTMLInputElement | null>;
  confirmRename: () => void;
  cancelRename: () => void;
  handleRenameKeyDown: (e: React.KeyboardEvent) => void;
  startRename: (node: FileNode) => void;
  // Actions
  toggleFolder: (path: string) => void;
  onFileSelect: (path: string) => void;
  onDeleteFile: (path: string) => void;
  copyPath: (path: string) => void;
  downloadFile: (path: string) => void;
  downloadFolder: (folderPath: string) => void;
  setSelectedFolder: (path: string | null) => void;
  // Drag handlers
  handleDragStart: (e: React.DragEvent, node: FileNode) => void;
  handleDragOver: (e: React.DragEvent, folderPath: string) => void;
  handleDragLeave: () => void;
  handleDrop: (e: React.DragEvent, targetFolder: string) => void;
}

export const FileTreeNode = memo(function FileTreeNode(
  props: FileTreeNodeProps,
) {
  const {
    node,
    level,
    expandedFolders,
    selectedFolder,
    dragOverPath,
    normalizedCurrentFile,
    createState,
    createName,
    setCreateName,
    createInputRef,
    confirmCreate,
    cancelCreate,
    handleCreateKeyDown,
    startCreate,
    renamingPath,
    renameName,
    setRenameName,
    renameInputRef,
    confirmRename,
    cancelRename,
    handleRenameKeyDown,
    startRename,
    toggleFolder,
    onFileSelect,
    onDeleteFile,
    copyPath,
    downloadFile,
    downloadFolder,
    setSelectedFolder,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = props;
  const t = useT();
  const isRenaming = renamingPath === node.path;
  const isCreatingIn = createState && createState.parent === node.path;
  const confirmDelete = async () => {
    if (
      await requestConfirmation({
        title: t.explorer.delete,
        message: formatDeleteConfirmation(t.explorer.deleteConfirm, node.path),
        confirmLabel: t.explorer.delete,
        cancelLabel: t.settings.cancel,
        destructive: true,
      })
    ) {
      onDeleteFile(node.path);
    }
  };

  if (node.type === "folder") {
    const isExpanded = expandedFolders.has(node.path);
    const isDragOver = dragOverPath === node.path;

    return (
      <div>
        {isRenaming ? (
          <InlineInput
            ref={renameInputRef}
            icon={<Folder size={14} className="text-blue-500 shrink-0" />}
            value={renameName}
            onChange={setRenameName}
            onKeyDown={handleRenameKeyDown}
            onConfirm={confirmRename}
            onCancel={cancelRename}
            paddingLeft={BASE_PAD + level * INDENT + INDENT}
            paddingRight={BASE_PAD}
            stopPropagation
          />
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-1 py-1 text-left hover:bg-accent/50 cursor-pointer text-sm group",
                  isCreatingIn && "bg-accent/30",
                  selectedFolder === node.path &&
                    "bg-accent text-accent-foreground",
                  isDragOver &&
                    "bg-blue-100 dark:bg-blue-900/30 outline-dashed outline-1 outline-blue-400",
                )}
                style={{
                  paddingLeft: `${BASE_PAD + level * INDENT}px`,
                  paddingRight: `${BASE_PAD}px`,
                }}
                onClick={() => toggleFolder(node.path)}
                draggable
                onDragStart={(e) => handleDragStart(e, node)}
                onDragOver={(e) => handleDragOver(e, node.path)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, node.path)}
              >
                {isExpanded ? (
                  <ChevronDown
                    size={14}
                    className="text-muted-foreground shrink-0"
                  />
                ) : (
                  <ChevronRight
                    size={14}
                    className="text-muted-foreground shrink-0"
                  />
                )}
                {isExpanded ? (
                  <FolderOpen size={14} className="text-blue-500 shrink-0" />
                ) : (
                  <Folder size={14} className="text-blue-500 shrink-0" />
                )}
                <span className="text-foreground/80 flex-1 truncate">
                  {node.name}
                </span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-44">
              <ContextMenuItem onClick={() => startCreate("file", node.path)}>
                <FilePlus size={14} />
                {t.explorer.newFile}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => startCreate("folder", node.path)}>
                <FolderPlus size={14} />
                {t.explorer.newFolder}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => startRename(node)}>
                <Pencil size={14} />
                {t.explorer.rename}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => copyPath(node.path)}>
                <Copy size={14} />
                {t.explorer.copyPath}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => downloadFolder(node.path)}>
                <Download size={14} />
                {t.explorer.download}
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={confirmDelete}>
                <Trash2 size={14} />
                {t.explorer.delete}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}

        {isExpanded && (
          <div>
            {isCreatingIn && (
              <InlineInput
                ref={createInputRef}
                icon={
                  createState!.type === "file" ? (
                    <File size={14} className="text-gray-400 shrink-0" />
                  ) : (
                    <Folder size={14} className="text-blue-500 shrink-0" />
                  )
                }
                value={createName}
                onChange={setCreateName}
                onKeyDown={handleCreateKeyDown}
                onConfirm={confirmCreate}
                onCancel={cancelCreate}
                placeholder={
                  createState!.type === "file" ? "filename.tsx" : "folder-name"
                }
                paddingLeft={BASE_PAD + (level + 1) * INDENT + INDENT}
                paddingRight={BASE_PAD}
              />
            )}
            {node.children?.map((child) => (
              <FileTreeNode
                key={child.path}
                {...props}
                node={child}
                level={level + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isRenaming) {
    return (
      <InlineInput
        ref={renameInputRef}
        icon={<File size={14} className="text-muted-foreground shrink-0" />}
        value={renameName}
        onChange={setRenameName}
        onKeyDown={handleRenameKeyDown}
        onConfirm={confirmRename}
        onCancel={cancelRename}
        paddingLeft={BASE_PAD + level * INDENT + INDENT}
        paddingRight={BASE_PAD}
        stopPropagation
      />
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-1 py-1 text-left hover:bg-accent/50 cursor-pointer text-sm",
            normalizedCurrentFile === node.path &&
              "bg-accent text-accent-foreground",
          )}
          style={{
            paddingLeft: `${BASE_PAD + level * INDENT}px`,
            paddingRight: `${BASE_PAD}px`,
          }}
          onClick={() => {
            setSelectedFolder(null);
            onFileSelect(node.path);
          }}
          draggable
          onDragStart={(e) => handleDragStart(e, node)}
        >
          <File size={14} className="text-muted-foreground shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={() => startRename(node)}>
          <Pencil size={14} />
          {t.explorer.rename}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => copyPath(node.path)}>
          <Copy size={14} />
          {t.explorer.copyPath}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => downloadFile(node.path)}>
          <Download size={14} />
          {t.explorer.download}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={confirmDelete}>
          <Trash2 size={14} />
          {t.explorer.delete}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
