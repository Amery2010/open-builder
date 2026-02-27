import { useState } from "react";
import {
  ChevronRight,
  FolderOpen,
  Eye,
  Files,
  FilePen,
  Wrench,
  Trash2,
  Search,
  Globe,
  Terminal,
} from "lucide-react";
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
  web_search: <Search size={14} className="text-purple-500" />,
  web_reader: <Globe size={14} className="text-teal-500" />,
  get_console_logs: <Terminal size={14} className="text-sky-500" />,
};

function countSearchResults(result: string): {
  ok: boolean;
  count: number;
  error?: string;
} {
  try {
    const d = JSON.parse(result);
    return { ok: d.ok, count: d.results?.length ?? 0, error: d.error };
  } catch {
    return { ok: false, count: 0, error: result };
  }
}

function countWebReaderUrls(result: string): { url: string; ok: boolean }[] {
  try {
    const d = JSON.parse(result);
    return (d.pages ?? []).map((p: any) => ({ url: p.url, ok: p.ok }));
  } catch {
    return [];
  }
}

function parseConsoleIssues(result: string): { level: "error" | "warn"; text: string }[] {
  if (!result || result === "No console output yet.") return [];
  return result
    .split("\n")
    .filter((line) => line.startsWith("[ERROR]") || line.startsWith("[WARN]"))
    .map((line) => ({
      level: line.startsWith("[ERROR]") ? "error" : "warn",
      text: line.replace(/^\[(ERROR|WARN)\]\s*/, ""),
    }));
}

type ToolCallCardProps = Omit<ToolBlock, "type" | "id">;

export function ToolCallCard({
  toolName,
  title,
  path,
  paths,
  result,
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isSuccess = result && (result.startsWith("OK") || result.includes("✓"));
  const isError =
    result && (result.startsWith("Error") || result.includes("✗"));

  const searchResultCount =
    toolName === "web_search" && result ? countSearchResults(result).count : 0;
  const readerUrls =
    toolName === "web_reader" && result ? countWebReaderUrls(result) : [];
  const consoleIssues =
    toolName === "get_console_logs" && result ? parseConsoleIssues(result) : [];
  const consoleErrorCount = consoleIssues.filter((i) => i.level === "error").length;
  const consoleWarnCount = consoleIssues.filter((i) => i.level === "warn").length;

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-muted/30">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center shrink-0">
          {TOOL_ICONS[toolName] ?? (
            <Wrench size={14} className="text-muted-foreground" />
          )}
        </span>
        <span className="text-xs font-medium flex-1 text-foreground">
          {title}
        </span>
        {toolName === "web_search" && result ? (
          <Badge variant="secondary" className="text-xs font-mono h-5">
            {searchResultCount} 条结果
          </Badge>
        ) : toolName === "web_reader" && result ? (
          <Badge variant="secondary" className="text-xs font-mono h-5">
            {readerUrls.length} 个网页
          </Badge>
        ) : toolName === "get_console_logs" && result ? (
          consoleErrorCount > 0 ? (
            <Badge variant="destructive" className="text-xs font-mono h-5">
              {consoleErrorCount} 个错误{consoleWarnCount > 0 ? ` · ${consoleWarnCount} 个警告` : ""}
            </Badge>
          ) : consoleWarnCount > 0 ? (
            <Badge variant="secondary" className="text-xs font-mono h-5 text-yellow-600">
              {consoleWarnCount} 个警告
            </Badge>
          ) : null
        ) : paths && paths.length > 0 ? (
          <Badge variant="secondary" className="text-xs font-mono h-5">
            {paths.length} 个文件
          </Badge>
        ) : path ? (
          <Badge
            variant="secondary"
            className="text-xs font-mono h-5 max-w-35 truncate"
          >
            {path}
          </Badge>
        ) : null}
        {result ? (
          <div
            className={cn(
              "w-1.5 h-1.5 rounded-full shrink-0",
              toolName === "get_console_logs"
                ? consoleErrorCount > 0
                  ? "bg-red-500"
                  : consoleWarnCount > 0
                    ? "bg-yellow-400"
                    : "bg-green-500"
                : isSuccess && "bg-green-500",
              toolName !== "get_console_logs" && isError && "bg-red-500",
              toolName !== "get_console_logs" && !isSuccess && !isError && "bg-gray-400",
            )}
          />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
        )}
        <ChevronRight
          size={13}
          className={cn(
            "text-muted-foreground transition-transform shrink-0",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && result && (
        <div className="px-3 py-2 border-t border-border/60 bg-muted/20">
          {toolName === "list_files" ? (
            <FileTreeView content={result} />
          ) : toolName === "read_files" ? (
            <FileTreeView content={(paths || []).join("\n")} />
          ) : toolName === "read_file" ? (
            <span className="text-xs text-muted-foreground italic">
              文件内容已隐藏
            </span>
          ) : toolName === "get_console_logs" ? (
            consoleIssues.length === 0 ? (
              <p className="text-xs text-green-600">无错误或警告</p>
            ) : (
              <div className="space-y-1">
                {consoleIssues.map((issue, i) => (
                  <p
                    key={i}
                    className={cn(
                      "text-xs font-mono whitespace-pre-wrap leading-relaxed",
                      issue.level === "error" ? "text-red-500" : "text-yellow-600",
                    )}
                  >
                    {issue.level === "error" ? "✗" : "⚠"} {issue.text}
                  </p>
                ))}
              </div>
            )
          ) : toolName === "web_search" ? (
            <p className="text-xs text-muted-foreground">
              {result.startsWith("Error")
                ? `失败: ${result}`
                : `已找到 ${searchResultCount} 条搜索结果`}
            </p>
          ) : toolName === "web_reader" ? (
            <div className="space-y-0.5">
              {readerUrls.map(({ url, ok }) => (
                <p key={url} className="text-xs text-muted-foreground truncate">
                  {ok ? "✓" : "✗"} {url}
                </p>
              ))}
            </div>
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
