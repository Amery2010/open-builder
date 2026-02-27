import { useState, useEffect, useRef, useCallback } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Check,
  X,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { ProjectFiles } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileNode[];
}

// ─── buildFileTree ────────────────────────────────────────────────────────────

function buildFileTree(files: ProjectFiles): FileNode[] {
  const root: FileNode[] = [];
  const folderMap = new Map<string, FileNode>();

  for (const path of Object.keys(files).sort()) {
    const parts = path.replace(/^\//, "").split("/");
    let currentLevel = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath += (currentPath ? "/" : "") + part;
      const isFile = i === parts.length - 1;

      if (isFile) {
        currentLevel.push({ name: part, path: currentPath, type: "file" });
      } else {
        let folder = folderMap.get(currentPath);
        if (!folder) {
          folder = {
            name: part,
            path: currentPath,
            type: "folder",
            children: [],
          };
          folderMap.set(currentPath, folder);
          currentLevel.push(folder);
        }
        currentLevel = folder.children!;
      }
    }
  }

  return root;
}

// ─── FileExplorer ─────────────────────────────────────────────────────────────

interface FileExplorerProps {
  files: ProjectFiles;
  currentFile: string;
  onFileSelect: (path: string) => void;
  onCreateFile: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onRenameFile: (oldPath: string, newPath: string) => void;
  onDeleteFile: (path: string) => void;
  onMoveFile: (sourcePath: string, targetFolder: string) => void;
}

export function FileExplorer({
  files,
  currentFile,
  onFileSelect,
  onCreateFile,
  onCreateFolder,
  onRenameFile,
  onDeleteFile,
  onMoveFile,
}: FileExplorerProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(["src"]),
  );

  // Create state
  const [createState, setCreateState] = useState<{
    type: "file" | "folder";
    parent: string;
  } | null>(null);
  const [createName, setCreateName] = useState("");

  // Rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  // Drag state
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  const createInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const normalizedCurrentFile = currentFile.startsWith("/")
    ? currentFile.slice(1)
    : currentFile;
  const fileTree = buildFileTree(files);

  // Focus inputs when shown
  useEffect(() => {
    if (createState && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [createState]);

  useEffect(() => {
    if (renamingPath && renameInputRef.current) {
      renameInputRef.current.focus();
      // Select filename without extension for files
      const name = renameName;
      const dotIdx = name.lastIndexOf(".");
      if (dotIdx > 0) {
        renameInputRef.current.setSelectionRange(0, dotIdx);
      } else {
        renameInputRef.current.select();
      }
    }
  }, [renamingPath]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const getCurrentDirectory = () => {
    const parts = normalizedCurrentFile.split("/");
    return parts.length === 1 ? "" : parts.slice(0, -1).join("/");
  };

  // ── Create handlers ──

  const startCreate = (type: "file" | "folder", parentDir: string) => {
    setRenamingPath(null);
    setCreateState({ type, parent: parentDir });
    setCreateName("");
    if (parentDir)
      setExpandedFolders((prev) => new Set(prev).add(parentDir));
  };

  const confirmCreate = () => {
    if (!createState || !createName.trim()) return;
    const fullPath = createState.parent
      ? `${createState.parent}/${createName}`
      : createName;
    if (createState.type === "file") onCreateFile(fullPath);
    else onCreateFolder(fullPath);
    setCreateState(null);
    setCreateName("");
  };

  const cancelCreate = () => {
    setCreateState(null);
    setCreateName("");
  };

  const handleCreateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") confirmCreate();
    else if (e.key === "Escape") cancelCreate();
  };

  // ── Rename handlers ──

  const startRename = (node: FileNode) => {
    setCreateState(null);
    setRenamingPath(node.path);
    setRenameName(node.name);
  };

  const confirmRename = useCallback(() => {
    if (!renamingPath || !renameName.trim()) return;
    const parts = renamingPath.split("/");
    parts[parts.length - 1] = renameName.trim();
    const newPath = parts.join("/");
    if (newPath !== renamingPath) {
      onRenameFile(renamingPath, newPath);
    }
    setRenamingPath(null);
    setRenameName("");
  }, [renamingPath, renameName, onRenameFile]);

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
    setRenameName("");
  }, []);

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") confirmRename();
    else if (e.key === "Escape") cancelRename();
  };

  // ── Drag handlers ──

  const handleDragStart = (e: React.DragEvent, node: FileNode) => {
    e.dataTransfer.setData("text/plain", node.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, folderPath: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverPath(folderPath);
  };

  const handleDragLeave = () => {
    setDragOverPath(null);
  };

  const handleDrop = (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    const sourcePath = e.dataTransfer.getData("text/plain");
    if (!sourcePath || sourcePath === targetFolder) return;
    // Don't drop into itself or its own children
    if (targetFolder.startsWith(sourcePath + "/")) return;
    // Don't drop if already in that folder
    const sourceParent = sourcePath.includes("/")
      ? sourcePath.substring(0, sourcePath.lastIndexOf("/"))
      : "";
    if (sourceParent === targetFolder) return;
    onMoveFile(sourcePath, targetFolder);
  };

  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverPath(null);
    const sourcePath = e.dataTransfer.getData("text/plain");
    if (!sourcePath) return;
    const sourceParent = sourcePath.includes("/")
      ? sourcePath.substring(0, sourcePath.lastIndexOf("/"))
      : "";
    if (sourceParent === "") return;
    onMoveFile(sourcePath, "");
  };

  const handleRootDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  // ── Inline input row (shared by create & rename) ──

  const renderInlineInput = ({
    icon,
    value,
    onChange,
    onKeyDown,
    onConfirm,
    onCancel,
    placeholder,
    ref,
    level,
  }: {
    icon: React.ReactNode;
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onConfirm: () => void;
    onCancel: () => void;
    placeholder: string;
    ref: React.RefObject<HTMLInputElement | null>;
    level: number;
  }) => (
    <div
      className="flex items-center gap-1 px-2 py-0.5"
      style={{ paddingLeft: `${level * 12 + 8}px` }}
    >
      {icon}
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onCancel}
        placeholder={placeholder}
        className="flex-1 min-w-0 h-6 px-1.5 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 shrink-0 text-green-600 hover:text-green-700 hover:bg-green-50"
        onMouseDown={(e) => {
          e.preventDefault();
          onConfirm();
        }}
      >
        <Check size={12} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
        onMouseDown={(e) => {
          e.preventDefault();
          onCancel();
        }}
      >
        <X size={12} />
      </Button>
    </div>
  );

  // ── Render create input ──

  const renderCreateInput = (level: number) => {
    if (!createState) return null;
    return renderInlineInput({
      icon:
        createState.type === "file" ? (
          <File size={14} className="text-gray-400 shrink-0" />
        ) : (
          <Folder size={14} className="text-blue-500 shrink-0" />
        ),
      value: createName,
      onChange: setCreateName,
      onKeyDown: handleCreateKeyDown,
      onConfirm: confirmCreate,
      onCancel: cancelCreate,
      placeholder: createState.type === "file" ? "filename.tsx" : "folder-name",
      ref: createInputRef,
      level,
    });
  };

  // ── Render node ──

  const renderNode = (node: FileNode, level = 0): React.ReactNode => {
    const isRenaming = renamingPath === node.path;
    const isCreatingIn =
      createState && createState.parent === node.path;

    if (node.type === "folder") {
      const isExpanded = expandedFolders.has(node.path);
      const isDragOver = dragOverPath === node.path;

      return (
        <div key={node.path}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "flex items-center gap-1 px-2 py-1 hover:bg-accent/50 cursor-pointer text-sm group",
                  isCreatingIn && "bg-accent/30",
                  isDragOver && "bg-blue-100 outline-dashed outline-1 outline-blue-400",
                )}
                style={{ paddingLeft: `${level * 12 + 8}px` }}
                onClick={() => toggleFolder(node.path)}
                draggable={!isRenaming}
                onDragStart={(e) => handleDragStart(e, node)}
                onDragOver={(e) => handleDragOver(e, node.path)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, node.path)}
              >
                {isExpanded ? (
                  <ChevronDown size={14} className="text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight size={14} className="text-muted-foreground shrink-0" />
                )}
                {isExpanded ? (
                  <FolderOpen size={14} className="text-blue-500 shrink-0" />
                ) : (
                  <Folder size={14} className="text-blue-500 shrink-0" />
                )}
                {isRenaming ? (
                  <>
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameName}
                      onChange={(e) => setRenameName(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onBlur={cancelRename}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 min-w-0 h-5 px-1.5 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0 text-green-600 hover:text-green-700 hover:bg-green-50"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        confirmRename();
                      }}
                    >
                      <Check size={12} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        cancelRename();
                      }}
                    >
                      <X size={12} />
                    </Button>
                  </>
                ) : (
                  <span className="text-foreground/80 flex-1 truncate">
                    {node.name}
                  </span>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-44">
              <ContextMenuItem
                onClick={() => startCreate("file", node.path)}
              >
                <FilePlus size={14} />
                新建文件
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => startCreate("folder", node.path)}
              >
                <FolderPlus size={14} />
                新建文件夹
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => startRename(node)}>
                <Pencil size={14} />
                重命名
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onClick={() => onDeleteFile(node.path)}
              >
                <Trash2 size={14} />
                删除
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          {isExpanded && (
            <div>
              {isCreatingIn && renderCreateInput(level + 1)}
              {node.children?.map((child) => renderNode(child, level + 1))}
            </div>
          )}
        </div>
      );
    }

    // File node
    return (
      <ContextMenu key={node.path}>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "flex items-center gap-1 px-2 py-1 hover:bg-accent/50 cursor-pointer text-sm",
              normalizedCurrentFile === node.path &&
                "bg-accent text-accent-foreground",
            )}
            style={{ paddingLeft: `${level * 12 + 22}px` }}
            onClick={() => !isRenaming && onFileSelect(node.path)}
            draggable={!isRenaming}
            onDragStart={(e) => handleDragStart(e, node)}
          >
            <File size={14} className="text-muted-foreground shrink-0" />
            {isRenaming ? (
              <>
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={cancelRename}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-w-0 h-5 px-1.5 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 text-green-600 hover:text-green-700 hover:bg-green-50"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    confirmRename();
                  }}
                >
                  <Check size={12} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelRename();
                  }}
                >
                  <X size={12} />
                </Button>
              </>
            ) : (
              <span className="truncate">{node.name}</span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onClick={() => startRename(node)}>
            <Pencil size={14} />
            重命名
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => onDeleteFile(node.path)}
          >
            <Trash2 size={14} />
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-2 py-2 border-b flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          文件
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => startCreate("file", getCurrentDirectory())}
            title="新建文件"
          >
            <FilePlus size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => startCreate("folder", getCurrentDirectory())}
            title="新建文件夹"
          >
            <FolderPlus size={14} />
          </Button>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarGutter: "stable" }}
        onDragOver={handleRootDragOver}
        onDrop={handleRootDrop}
      >
        {fileTree.map((node) => renderNode(node))}

        {createState && createState.parent === "" && renderCreateInput(0)}
      </div>
    </div>
  );
}
