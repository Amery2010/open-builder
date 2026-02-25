import { useState, useEffect, useRef } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProjectFiles } from "../../types";

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
          folder = { name: part, path: currentPath, type: "folder", children: [] };
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
}

export function FileExplorer({
  files,
  currentFile,
  onFileSelect,
  onCreateFile,
  onCreateFolder,
}: FileExplorerProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(["src"]));
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemParent, setNewItemParent] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const normalizedCurrentFile = currentFile.startsWith("/") ? currentFile.slice(1) : currentFile;
  const fileTree = buildFileTree(files);

  useEffect(() => {
    if ((showNewFileInput || showNewFolderInput) && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showNewFileInput, showNewFolderInput]);

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

  const startCreate = (type: "file" | "folder", parentDir: string) => {
    setShowNewFileInput(type === "file");
    setShowNewFolderInput(type === "folder");
    setNewItemName("");
    setNewItemParent(parentDir);
    if (parentDir) setExpandedFolders((prev) => new Set(prev).add(parentDir));
  };

  const handleConfirmCreate = () => {
    if (!newItemName.trim()) return;
    const fullPath = newItemParent ? `${newItemParent}/${newItemName}` : newItemName;
    if (showNewFileInput) onCreateFile(fullPath);
    else if (showNewFolderInput) onCreateFolder(fullPath);
    setShowNewFileInput(false);
    setShowNewFolderInput(false);
    setNewItemName("");
  };

  const handleCancelCreate = () => {
    setShowNewFileInput(false);
    setShowNewFolderInput(false);
    setNewItemName("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleConfirmCreate();
    else if (e.key === "Escape") handleCancelCreate();
  };

  const isCreatingIn = (folderPath: string) =>
    (showNewFileInput || showNewFolderInput) && newItemParent === folderPath;

  const renderCreateInput = (level: number) => (
    <div
      className="px-2 py-1 bg-blue-50 border-l-2 border-blue-500 mx-2 my-1 rounded"
      style={{ marginLeft: `${level * 12 + 8}px` }}
    >
      <div className="flex items-center gap-1 mb-1">
        {showNewFileInput
          ? <File size={12} className="text-blue-600" />
          : <Folder size={12} className="text-blue-600" />}
        <span className="text-xs text-blue-700">{showNewFileInput ? "新建文件" : "新建文件夹"}</span>
      </div>
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="text"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={showNewFileInput ? "文件名.tsx" : "文件夹名"}
          className="flex-1 px-2 py-1 text-xs border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button onClick={handleCancelCreate} className="p-1 hover:bg-blue-100 rounded transition-colors">
          <X size={10} className="text-gray-600" />
        </button>
      </div>
      <div className="mt-1 text-xs text-gray-500">Enter 确认 · Esc 取消</div>
    </div>
  );

  const renderNode = (node: FileNode, level = 0): React.ReactNode => {
    if (node.type === "folder") {
      const isExpanded = expandedFolders.has(node.path);
      return (
        <div key={node.path}>
          <div
            className={cn(
              "flex items-center gap-1 px-2 py-1 hover:bg-gray-100 cursor-pointer text-sm group",
              isCreatingIn(node.path) && "bg-blue-50",
            )}
            style={{ paddingLeft: `${level * 12 + 8}px` }}
            onClick={() => toggleFolder(node.path)}
          >
            {isExpanded
              ? <ChevronDown size={14} className="text-gray-500" />
              : <ChevronRight size={14} className="text-gray-500" />}
            {isExpanded
              ? <FolderOpen size={14} className="text-blue-500" />
              : <Folder size={14} className="text-blue-500" />}
            <span className="text-gray-700 flex-1">{node.name}</span>
            <div className="hidden group-hover:flex items-center gap-0.5">
              <Button
                variant="ghost" size="icon" className="h-5 w-5"
                onClick={(e) => { e.stopPropagation(); startCreate("file", node.path); }}
                title="在此文件夹中新建文件"
              >
                <FilePlus size={12} />
              </Button>
              <Button
                variant="ghost" size="icon" className="h-5 w-5"
                onClick={(e) => { e.stopPropagation(); startCreate("folder", node.path); }}
                title="在此文件夹中新建文件夹"
              >
                <FolderPlus size={12} />
              </Button>
            </div>
          </div>
          {isExpanded && (
            <div>
              {isCreatingIn(node.path) && renderCreateInput(level + 1)}
              {node.children?.map((child) => renderNode(child, level + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div
        key={node.path}
        className={cn(
          "flex items-center gap-1 px-2 py-1 hover:bg-gray-100 cursor-pointer text-sm",
          normalizedCurrentFile === node.path && "bg-blue-50 text-blue-700",
        )}
        style={{ paddingLeft: `${level * 12 + 22}px` }}
        onClick={() => onFileSelect(node.path)}
      >
        <File size={14} className="text-gray-400" />
        <span className="truncate">{node.name}</span>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-2 py-2 border-b flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase">文件</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6"
            onClick={() => startCreate("file", getCurrentDirectory())} title="新建文件">
            <FilePlus size={14} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6"
            onClick={() => startCreate("folder", getCurrentDirectory())} title="新建文件夹">
            <FolderPlus size={14} />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable" }}>
        {fileTree.map((node) => renderNode(node))}

        {(showNewFileInput || showNewFolderInput) && newItemParent === "" && (
          <div className="px-2 py-1 bg-blue-50 border-l-2 border-blue-500 mx-2 my-1 rounded">
            <div className="flex items-center gap-1 mb-1">
              {showNewFileInput
                ? <File size={12} className="text-blue-600" />
                : <Folder size={12} className="text-blue-600" />}
              <span className="text-xs text-blue-700">{showNewFileInput ? "新建文件" : "新建文件夹"}</span>
            </div>
            <div className="flex items-center gap-1">
              <Input
                ref={inputRef}
                type="text"
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={showNewFileInput ? "文件名.tsx" : "文件夹名"}
                className="h-7 text-xs"
              />
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCancelCreate}>
                <X size={10} />
              </Button>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">Enter 确认 · Esc 取消</div>
          </div>
        )}
      </div>
    </div>
  );
}
