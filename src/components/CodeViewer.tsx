import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
  SandpackConsole,
  useSandpack,
} from "@codesandbox/sandpack-react";
import { useState, useEffect, useRef } from "react";
import {
  Eye,
  Code2,
  Monitor,
  Smartphone,
  Tablet,
  Terminal,
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  X,
} from "lucide-react";
import { ProjectFiles } from "../lib/web-app-generator";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface CodeViewerProps {
  files: ProjectFiles;
  currentFile: string;
  onFileSelect: (path: string) => void;
  onFileChange: (path: string, content: string) => void;
}

type ViewMode = "preview" | "code";
type DeviceSize = "desktop" | "tablet" | "mobile";

// 文件树节点类型
interface FileNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileNode[];
}

// 构建文件树（不使用前导斜杠）
function buildFileTree(files: ProjectFiles): FileNode[] {
  const root: FileNode[] = [];
  const folderMap = new Map<string, FileNode>();

  // 排序文件路径
  const sortedPaths = Object.keys(files).sort();

  for (const path of sortedPaths) {
    const parts = path.replace(/^\//, "").split("/");
    let currentLevel = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath += (currentPath ? "/" : "") + part;
      const isFile = i === parts.length - 1;

      if (isFile) {
        currentLevel.push({
          name: part,
          path: currentPath,
          type: "file",
        });
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

// 文件浏览器组件
function FileExplorer({
  files,
  currentFile,
  onFileSelect,
  onCreateFile,
  onCreateFolder,
}: {
  files: ProjectFiles;
  currentFile: string;
  onFileSelect: (path: string) => void;
  onCreateFile: (path: string) => void;
  onCreateFolder: (path: string) => void;
}) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(["src"]),
  );
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemParent, setNewItemParent] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 规范化 currentFile（移除前导斜杠用于比较）
  const normalizedCurrentFile = currentFile.startsWith("/")
    ? currentFile.slice(1)
    : currentFile;

  const fileTree = buildFileTree(files);

  useEffect(() => {
    if ((showNewFileInput || showNewFolderInput) && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showNewFileInput, showNewFolderInput]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // 获取当前文件所在的目录（不使用前导斜杠）
  const getCurrentDirectory = () => {
    if (!normalizedCurrentFile) return "";

    // 如果当前选中的是文件，获取其父目录
    const parts = normalizedCurrentFile.split("/");
    if (parts.length === 1) {
      return "";
    }
    return parts.slice(0, -1).join("/");
  };

  const handleCreateFile = () => {
    const parentDir = getCurrentDirectory();
    setShowNewFileInput(true);
    setShowNewFolderInput(false);
    setNewItemName("");
    setNewItemParent(parentDir);

    // 自动展开父目录
    if (parentDir) {
      setExpandedFolders((prev) => new Set(prev).add(parentDir));
    }
  };

  const handleCreateFolder = () => {
    const parentDir = getCurrentDirectory();
    setShowNewFolderInput(true);
    setShowNewFileInput(false);
    setNewItemName("");
    setNewItemParent(parentDir);

    // 自动展开父目录
    if (parentDir) {
      setExpandedFolders((prev) => new Set(prev).add(parentDir));
    }
  };

  // 在特定文件夹中创建文件
  const handleCreateFileInFolder = (folderPath: string) => {
    setShowNewFileInput(true);
    setShowNewFolderInput(false);
    setNewItemName("");
    setNewItemParent(folderPath);

    // 自动展开该文件夹
    setExpandedFolders((prev) => new Set(prev).add(folderPath));
  };

  // 在特定文件夹中创建文件夹
  const handleCreateFolderInFolder = (folderPath: string) => {
    setShowNewFolderInput(true);
    setShowNewFileInput(false);
    setNewItemName("");
    setNewItemParent(folderPath);

    // 自动展开该文件夹
    setExpandedFolders((prev) => new Set(prev).add(folderPath));
  };

  const handleConfirmCreate = () => {
    if (!newItemName.trim()) return;

    // 支持创建嵌套路径，如 "components/Button.tsx"（不使用前导斜杠）
    const fullPath =
      newItemParent === "" || !newItemParent
        ? newItemName
        : `${newItemParent}/${newItemName}`;

    if (showNewFileInput) {
      onCreateFile(fullPath);
    } else if (showNewFolderInput) {
      onCreateFolder(fullPath);
    }

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
    if (e.key === "Enter") {
      handleConfirmCreate();
    } else if (e.key === "Escape") {
      handleCancelCreate();
    }
  };

  const renderNode = (node: FileNode, level: number = 0) => {
    if (node.type === "folder") {
      const isExpanded = expandedFolders.has(node.path);
      const isCreatingInThisFolder =
        (showNewFileInput || showNewFolderInput) && newItemParent === node.path;

      return (
        <div key={node.path}>
          <div
            className={cn(
              "flex items-center gap-1 px-2 py-1 hover:bg-gray-100 cursor-pointer text-sm group",
              isCreatingInThisFolder && "bg-blue-50",
            )}
            style={{ paddingLeft: `${level * 12 + 8}px` }}
            onClick={() => toggleFolder(node.path)}
          >
            {isExpanded ? (
              <ChevronDown size={14} className="text-gray-500" />
            ) : (
              <ChevronRight size={14} className="text-gray-500" />
            )}
            {isExpanded ? (
              <FolderOpen size={14} className="text-blue-500" />
            ) : (
              <Folder size={14} className="text-blue-500" />
            )}
            <span className="text-gray-700 flex-1">{node.name}</span>

            {/* 文件夹操作按钮 */}
            <div className="hidden group-hover:flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCreateFileInFolder(node.path);
                }}
                title="在此文件夹中新建文件"
              >
                <FilePlus size={12} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCreateFolderInFolder(node.path);
                }}
                title="在此文件夹中新建文件夹"
              >
                <FolderPlus size={12} />
              </Button>
            </div>
          </div>

          {isExpanded && (
            <div>
              {/* 在文件夹展开时，如果正在此文件夹中创建，显示输入框 */}
              {isCreatingInThisFolder && (
                <div
                  className="px-2 py-1 bg-blue-50 border-l-2 border-blue-500 mx-2 my-1 rounded"
                  style={{ marginLeft: `${(level + 1) * 12 + 8}px` }}
                >
                  <div className="flex items-center gap-1 mb-1">
                    {showNewFileInput ? (
                      <File size={12} className="text-blue-600" />
                    ) : (
                      <Folder size={12} className="text-blue-600" />
                    )}
                    <span className="text-xs text-blue-700">
                      {showNewFileInput ? "新建文件" : "新建文件夹"}
                    </span>
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
                    <button
                      onClick={handleCancelCreate}
                      className="p-1 hover:bg-blue-100 rounded transition-colors"
                      title="取消"
                    >
                      <X size={10} className="text-gray-600" />
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Enter 确认 · Esc 取消
                  </div>
                </div>
              )}

              {node.children &&
                node.children.map((child) => renderNode(child, level + 1))}
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
      {/* Header */}
      <div className="px-2 py-2 border-b flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          文件
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleCreateFile}
            title="新建文件"
          >
            <FilePlus size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleCreateFolder}
            title="新建文件夹"
          >
            <FolderPlus size={14} />
          </Button>
        </div>
      </div>

      {/* File Tree */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarGutter: "stable" }}
      >
        {fileTree.map((node) => renderNode(node))}

        {/* 根目录创建输入框 */}
        {(showNewFileInput || showNewFolderInput) && newItemParent === "" && (
          <div className="px-2 py-1 bg-blue-50 border-l-2 border-blue-500 mx-2 my-1 rounded">
            <div className="flex items-center gap-1 mb-1">
              {showNewFileInput ? (
                <File size={12} className="text-blue-600" />
              ) : (
                <Folder size={12} className="text-blue-600" />
              )}
              <span className="text-xs text-blue-700">
                {showNewFileInput ? "新建文件" : "新建文件夹"}
              </span>
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
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleCancelCreate}
                title="取消"
              >
                <X size={10} />
              </Button>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Enter 确认 · Esc 取消
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 内部组件：监听 Sandpack 文件变化并移除路径前缀
function SandpackListener({
  onFileChange,
}: {
  onFileChange: (path: string, content: string) => void;
}) {
  const { sandpack } = useSandpack();
  const { files, activeFile } = sandpack;
  const code = files[activeFile]?.code;

  // 防抖更新，避免性能问题和光标跳动
  useEffect(() => {
    const timer = setTimeout(() => {
      if (code && activeFile) {
        // 移除前导斜杠传递给父组件
        const normalizedPath = activeFile.startsWith("/")
          ? activeFile.slice(1)
          : activeFile;
        onFileChange(normalizedPath, code);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [code, activeFile, onFileChange]);

  return null;
}

export function CodeViewer({
  files,
  currentFile,
  onFileSelect,
  onFileChange,
}: CodeViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [deviceSize, setDeviceSize] = useState<DeviceSize>("desktop");
  const [showConsole, setShowConsole] = useState(false);

  // 转换文件格式为 Sandpack 需要的格式（添加前导斜杠）
  const sandpackFiles = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path.startsWith("/") ? path : `/${path}`,
      { code: content },
    ]),
  );

  // 确保 currentFile 有前导斜杠（用于 Sandpack）
  const sandpackCurrentFile = currentFile.startsWith("/")
    ? currentFile
    : `/${currentFile}`;

  // 处理新建文件（移除前导斜杠）
  const handleCreateFile = (path: string) => {
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    if (!files[normalizedPath]) {
      onFileChange(normalizedPath, "// New file\n");
      onFileSelect(normalizedPath);
    }
  };

  // 处理新建文件夹（创建一个占位文件，移除前导斜杠）
  const handleCreateFolder = (path: string) => {
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    const placeholderFile = `${normalizedPath}/.gitkeep`;
    if (!files[placeholderFile]) {
      onFileChange(placeholderFile, "");
    }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Toolbar */}
      <div className="h-14 border-b bg-background px-4 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-1 bg-muted p-1 rounded-lg">
          <Button
            variant={viewMode === "preview" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("preview")}
            className="gap-2"
          >
            <Eye size={16} />
            预览
          </Button>
          <Button
            variant={viewMode === "code" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("code")}
            className="gap-2"
          >
            <Code2 size={16} />
            代码
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {viewMode === "preview" && (
            <div className="flex items-center gap-1">
              <Button
                variant={deviceSize === "desktop" ? "secondary" : "ghost"}
                size="icon"
                onClick={() => setDeviceSize("desktop")}
                title="桌面视图"
              >
                <Monitor size={18} />
              </Button>
              <Button
                variant={deviceSize === "tablet" ? "secondary" : "ghost"}
                size="icon"
                onClick={() => setDeviceSize("tablet")}
                title="平板视图"
              >
                <Tablet size={18} />
              </Button>
              <Button
                variant={deviceSize === "mobile" ? "secondary" : "ghost"}
                size="icon"
                onClick={() => setDeviceSize("mobile")}
                title="手机视图"
              >
                <Smartphone size={18} />
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden relative bg-muted/50">
        <SandpackProvider
          template="vite-react-ts"
          theme="light"
          files={sandpackFiles}
          options={{
            activeFile: sandpackCurrentFile,
          }}
        >
          <SandpackListener onFileChange={onFileChange} />
          <SandpackLayout>
            {/* Preview Mode */}
            <div
              className={cn(
                "h-full w-full transition-all duration-300 mx-auto",
                viewMode === "preview" ? "block" : "hidden",
                deviceSize === "tablet"
                  ? "max-w-3xl my-4 shadow-lg border rounded-lg overflow-hidden bg-background h-[calc(100%-2rem)]"
                  : "",
                deviceSize === "mobile"
                  ? "max-w-sm my-4 shadow-lg border rounded-lg overflow-hidden bg-background h-[calc(100%-2rem)]"
                  : "",
                deviceSize === "desktop" ? "max-w-full h-full" : "",
              )}
            >
              <div className="grid grid-rows-3 h-full">
                <div
                  className={cn(
                    "transition-all duration-300 ease-in-out",
                    showConsole ? "row-span-2" : "row-span-3",
                  )}
                >
                  <SandpackPreview
                    showNavigator={true}
                    showOpenInCodeSandbox={false}
                    showRefreshButton={true}
                    actionsChildren={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setShowConsole(!showConsole)}
                        title={showConsole ? "隐藏控制台" : "显示控制台"}
                      >
                        <Terminal size={16} />
                      </Button>
                    }
                  />
                </div>
                <div
                  className={cn(
                    "overflow-hidden border-t",
                    showConsole ? "row-span-1" : "max-h-0 border-t-0",
                  )}
                >
                  <SandpackConsole />
                </div>
              </div>
            </div>

            {/* Code Mode */}
            <div
              className={cn(
                "h-full w-full overflow-hidden",
                viewMode === "code" ? "flex" : "hidden",
              )}
            >
              <div className="w-56 border-r h-full shrink-0 overflow-hidden flex flex-col">
                <FileExplorer
                  files={files}
                  currentFile={currentFile}
                  onFileSelect={onFileSelect}
                  onCreateFile={handleCreateFile}
                  onCreateFolder={handleCreateFolder}
                />
              </div>
              <div className="flex flex-col flex-1 h-full overflow-x-auto min-w-0">
                <SandpackCodeEditor
                  showTabs={false}
                  showLineNumbers={true}
                  showInlineErrors={true}
                  wrapContent={false}
                  closableTabs={false}
                />
              </div>
            </div>
          </SandpackLayout>
        </SandpackProvider>
      </div>
    </div>
  );
}
