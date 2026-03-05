import { useState, memo } from "react";
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
  Image,
  Package,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { FileTreeView } from "./FileTreeView";
import { useT } from "../../i18n";
import type { ToolBlock } from "../../types";

const TOOL_ICONS: Record<string, React.ReactNode> = {
  list_files: <FolderOpen size={14} className="text-yellow-500" />,
  read_file: <Eye size={14} className="text-blue-400" />,
  read_files: <Files size={14} className="text-blue-400" />,
  write_file: <FilePen size={14} className="text-green-500" />,
  patch_file: <Wrench size={14} className="text-orange-400" />,
  delete_file: <Trash2 size={14} className="text-red-400" />,
  search_in_files: <Search size={14} className="text-amber-500" />,
  web_search: <Search size={14} className="text-purple-500" />,
  web_reader: <Globe size={14} className="text-teal-500" />,
  image_search: <Image size={14} className="text-pink-500" />,
  search_npm_packages: <Package size={14} className="text-blue-500" />,
  get_npm_package_detail: <Package size={14} className="text-blue-500" />,
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

function countImageResults(result: string): {
  ok: boolean;
  count: number;
  error?: string;
} {
  try {
    const d = JSON.parse(result);
    return { ok: d.ok, count: d.images?.length ?? 0, error: d.error };
  } catch {
    return { ok: false, count: 0, error: result };
  }
}

function parseNpmSearchResult(result: string): {
  success: boolean;
  count: number;
  error?: string;
} {
  try {
    const d = JSON.parse(result);
    return { success: d.success, count: d.data?.length ?? 0, error: d.error };
  } catch {
    return { success: false, count: 0, error: result };
  }
}

function parseNpmDetailResult(result: string): {
  success: boolean;
  name?: string;
  error?: string;
} {
  try {
    const d = JSON.parse(result);
    return { success: d.success, name: d.data?.name, error: d.error };
  } catch {
    return { success: false, error: result };
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

function parseConsoleIssues(
  result: string,
): { level: "error" | "warn"; text: string }[] {
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

export const ToolCallCard = memo(function ToolCallCard({
  toolName,
  title,
  path,
  paths,
  result,
}: ToolCallCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const isSuccess = result && (result.startsWith("OK") || result.includes("✓"));
  const isError =
    result && (result.startsWith("Error") || result.includes("✗"));

  const searchResultCount =
    toolName === "web_search" && result ? countSearchResults(result).count : 0;
  const imageResultCount =
    toolName === "image_search" && result ? countImageResults(result).count : 0;
  const npmSearchCount =
    toolName === "search_npm_packages" && result ? parseNpmSearchResult(result).count : 0;
  const npmDetailName =
    toolName === "get_npm_package_detail" && result ? parseNpmDetailResult(result).name : "";
  const readerUrls =
    toolName === "web_reader" && result ? countWebReaderUrls(result) : [];
  const consoleIssues =
    toolName === "get_console_logs" && result ? parseConsoleIssues(result) : [];
  const consoleErrorCount = consoleIssues.filter(
    (i) => i.level === "error",
  ).length;
  const consoleWarnCount = consoleIssues.filter(
    (i) => i.level === "warn",
  ).length;

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
            {searchResultCount} {t.tool.results}
          </Badge>
        ) : toolName === "image_search" && result ? (
          <Badge variant="secondary" className="text-xs font-mono h-5">
            {imageResultCount} {t.tool.images}
          </Badge>
        ) : toolName === "search_npm_packages" && result ? (
          <Badge variant="secondary" className="text-xs font-mono h-5">
            {npmSearchCount} {t.tool.packages}
          </Badge>
        ) : toolName === "get_npm_package_detail" && result && npmDetailName ? (
          <Badge variant="secondary" className="text-xs font-mono h-5 max-w-35 truncate">
            {npmDetailName}
          </Badge>
        ) : toolName === "web_reader" && result ? (
          <Badge variant="secondary" className="text-xs font-mono h-5">
            {readerUrls.length} {t.tool.pages}
          </Badge>
        ) : toolName === "get_console_logs" && result ? (
          consoleErrorCount > 0 ? (
            <Badge variant="destructive" className="text-xs font-mono h-5">
              {consoleErrorCount} {t.tool.errors}
              {consoleWarnCount > 0 ? ` · ${consoleWarnCount} ${t.tool.warnings}` : ""}
            </Badge>
          ) : consoleWarnCount > 0 ? (
            <Badge
              variant="secondary"
              className="text-xs font-mono h-5 text-yellow-600"
            >
              {consoleWarnCount} {t.tool.warnings}
            </Badge>
          ) : null
        ) : paths && paths.length > 0 ? (
          <Badge variant="secondary" className="text-xs font-mono h-5">
            {paths.length} {t.tool.files}
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
              toolName !== "get_console_logs" &&
                !isSuccess &&
                !isError &&
                "bg-green-500",
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
              {t.tool.fileHidden}
            </span>
          ) : toolName === "get_console_logs" ? (
            consoleIssues.length === 0 ? (
              <p className="text-xs text-green-600">{t.tool.noIssues}</p>
            ) : (
              <div className="space-y-1">
                {consoleIssues.map((issue, i) => (
                  <p
                    key={i}
                    className={cn(
                      "text-xs font-mono whitespace-pre-wrap leading-relaxed",
                      issue.level === "error"
                        ? "text-red-500"
                        : "text-yellow-600",
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
                ? `${t.tool.failed}${result}`
                : `${t.tool.found}${searchResultCount} ${t.tool.searchResults}`}
            </p>
          ) : toolName === "image_search" ? (
            <p className="text-xs text-muted-foreground">
              {result.startsWith("Error")
                ? `${t.tool.failed}${result}`
                : `${t.tool.found}${imageResultCount} ${t.tool.imageResults}`}
            </p>
          ) : toolName === "search_npm_packages" ? (
            <p className="text-xs text-muted-foreground">
              {result.includes('"success":false')
                ? `${t.tool.failed}${parseNpmSearchResult(result).error}`
                : `${t.tool.found}${npmSearchCount} ${t.tool.npmPackages}`}
            </p>
          ) : toolName === "get_npm_package_detail" ? (
            <p className="text-xs text-muted-foreground">
              {result.includes('"success":false')
                ? `${t.tool.failed}${parseNpmDetailResult(result).error}`
                : `${t.tool.found}${npmDetailName}`}
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
});
