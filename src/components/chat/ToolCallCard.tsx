import { useState } from "react";
import { ChevronRight, FolderOpen, Eye, Files, FilePen, Wrench, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { FileTreeView } from "./FileTreeView";
import type { ToolBlock } from "../../types";

const TOOL_ICONS: Record<string, React.ReactNode> = {
  list_files: <FolderOpen size={14} className="text-yellow-500" />,
  read_file: <Eye size={14} className="text-blue-400" />,
  read_files: <Files size={14} className="text-blue-400" />,
  write_file: <FilePen size={14} className="text-green-500" />,
  patch_file: <Wrench size={14} className="text-orange-400" />,
  delete_file: <Trash2 size={14} className="text-red-400" />,
};

type ToolCallCardProps = Omit<ToolBlock, "type" | "id">;

export function ToolCallCard({ toolName, title, path, paths, result }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isSuccess = result && (result.startsWith("OK") || result.includes("✓"));
  const isError = result && (result.startsWith("Error") || result.includes("✗"));

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-muted/30">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center shrink-0">
          {TOOL_ICONS[toolName] ?? <Wrench size={14} className="text-muted-foreground" />}
        </span>
        <span className="text-xs font-medium flex-1 text-foreground">{title}</span>
        {paths && paths.length > 0 ? (
          <Badge variant="secondary" className="text-xs font-mono h-5">
            {paths.length} 个文件
          </Badge>
        ) : path ? (
          <Badge variant="secondary" className="text-xs font-mono h-5 max-w-35 truncate">
            {path}
          </Badge>
        ) : null}
        {result ? (
          <div
            className={cn(
              "w-1.5 h-1.5 rounded-full shrink-0",
              isSuccess && "bg-green-500",
              isError && "bg-red-500",
              !isSuccess && !isError && "bg-gray-400",
            )}
          />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
        )}
        <ChevronRight
          size={13}
          className={cn("text-muted-foreground transition-transform shrink-0", expanded && "rotate-90")}
        />
      </button>

      {expanded && result && (
        <div className="px-3 py-2 border-t border-border/60 bg-muted/20">
          {toolName === "list_files" ? (
            <FileTreeView content={result} />
          ) : toolName === "read_files" ? (
            <FileTreeView content={(paths || []).join("\n")} />
          ) : toolName === "read_file" ? (
            <span className="text-xs text-muted-foreground italic">文件内容已隐藏</span>
          ) : (
            <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
              {result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
