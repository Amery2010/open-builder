import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { FilePlus, FolderPlus, Search } from "lucide-react";
import JSZip from "jszip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { Input } from "@/components/ui/input";
import { useT } from "../../i18n";
import type { ProjectFiles } from "@/types";
import { FileTreeNode } from "./file-explorer/FileTreeNode";
import { InlineInput } from "./file-explorer/InlineInput";
import { BASE_PAD, INDENT, buildFileTree } from "./file-explorer/types";
import type { FileNode } from "./file-explorer/types";
import { MaterialIcon } from "./file-explorer/file-icons";

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
  const t = useT();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(["src"]),
  );
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);

  const [createState, setCreateState] = useState<{
    type: "file" | "folder";
    parent: string;
  } | null>(null);
  const [createName, setCreateName] = useState("");

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  const createInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const normalizedCurrentFile = currentFile.startsWith("/")
    ? currentFile.slice(1)
    : currentFile;

  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().toLowerCase();

  // Filter files by path substring. Empty query → unchanged tree.
  const { filteredFiles, matchedPaths } = useMemo(() => {
    if (!trimmedQuery) {
      return {
        filteredFiles: files,
        matchedPaths: null as Set<string> | null,
      };
    }
    const out: ProjectFiles = {};
    const matched = new Set<string>();
    for (const [path, content] of Object.entries(files)) {
      const cleaned = path.startsWith("/") ? path.slice(1) : path;
      if (cleaned.toLowerCase().includes(trimmedQuery)) {
        out[path] = content;
        matched.add(cleaned);
      }
    }
    return { filteredFiles: out, matchedPaths: matched };
  }, [files, trimmedQuery]);

  const fileTree = useMemo(() => buildFileTree(filteredFiles), [filteredFiles]);

  // When searching, auto-expand every ancestor folder of a matched file so
  // hits are visible. We merge with the user's explicit expansion state.
  const effectiveExpandedFolders = useMemo(() => {
    if (!matchedPaths) return expandedFolders;
    const next = new Set(expandedFolders);
    for (const path of matchedPaths) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        next.add(parts.slice(0, i).join("/"));
      }
    }
    return next;
  }, [matchedPaths, expandedFolders]);

  useEffect(() => {
    if (createState && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [createState]);

  useEffect(() => {
    if (renamingPath && renameInputRef.current) {
      renameInputRef.current.focus();
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
    setSelectedFolder(path);
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const getCurrentDirectory = () => {
    const parts = normalizedCurrentFile.split("/");
    return parts.length === 1 ? "" : parts.slice(0, -1).join("/");
  };

  const startCreate = (type: "file" | "folder", parentDir: string) => {
    setRenamingPath(null);
    setCreateState({ type, parent: parentDir });
    setCreateName("");
    if (parentDir) setExpandedFolders((prev) => new Set(prev).add(parentDir));
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
    if (targetFolder.startsWith(sourcePath + "/")) return;
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

  const copyPath = (path: string) => {
    navigator.clipboard.writeText(path);
  };

  const downloadFile = (path: string) => {
    const normalized = path.startsWith("/") ? path.slice(1) : path;
    const content = files[normalized] ?? files[`/${normalized}`] ?? "";
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = path.split("/").pop()!;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadFolder = async (folderPath: string) => {
    const zip = new JSZip();
    const prefix = folderPath + "/";
    for (const [path, content] of Object.entries(files)) {
      const normalized = path.startsWith("/") ? path.slice(1) : path;
      if (normalized.startsWith(prefix) && !normalized.endsWith("/")) {
        zip.file(normalized.slice(prefix.length), content);
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${folderPath.split("/").pop()}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const nodeProps = {
    expandedFolders: effectiveExpandedFolders,
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
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-2 py-2 border-b flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          {t.explorer.files}
        </span>
        <div className="flex items-center gap-1">
          <TooltipIconButton
            label={t.explorer.newFile}
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => startCreate("file", getCurrentDirectory())}
          >
            <FilePlus size={14} />
          </TooltipIconButton>
          <TooltipIconButton
            label={t.explorer.newFolder}
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => startCreate("folder", getCurrentDirectory())}
          >
            <FolderPlus size={14} />
          </TooltipIconButton>
        </div>
      </div>

      <div className="px-2 py-1.5 border-b">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.explorer.searchPlaceholder}
            aria-label={t.explorer.searchPlaceholder}
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarGutter: "stable" }}
        onDragOver={handleRootDragOver}
        onDrop={handleRootDrop}
      >
        {trimmedQuery && fileTree.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            {t.explorer.emptySearch}
          </p>
        ) : null}
        {fileTree.map((node) => (
          <FileTreeNode key={node.path} node={node} level={0} {...nodeProps} />
        ))}

        {createState && createState.parent === "" && (
          <InlineInput
            ref={createInputRef}
            icon={
              createState.type === "file" ? (
                <MaterialIcon name={createName || "file"} kind="file" />
              ) : (
                <MaterialIcon name={createName || "folder"} kind="folder" />
              )
            }
            value={createName}
            onChange={setCreateName}
            onKeyDown={handleCreateKeyDown}
            onConfirm={confirmCreate}
            onCancel={cancelCreate}
            placeholder={
              createState.type === "file" ? "filename.tsx" : "folder-name"
            }
            paddingLeft={BASE_PAD + INDENT}
            paddingRight={BASE_PAD}
          />
        )}
      </div>
    </div>
  );
}
