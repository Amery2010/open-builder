import { useEffect, useState, memo } from "react";
import {
  ChevronRight,
  Wrench,
  Check,
  X,
  AlertTriangle,
  ExternalLink,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { FileTreeView } from "./FileTreeView";
import { useT } from "../../i18n";
import type { ToolBlock } from "../../types";
import { TOOL_METADATA } from "../../lib/ai/tool-metadata";
import { getAttachmentBlob } from "../../lib/attachments/store";

export const TOOL_CARD_LIMITS = {
  maxJsonParseChars: 200_000,
  maxResultDisplayChars: 120_000,
  maxConsoleLines: 1_000,
  maxConsoleIssues: 50,
  maxReaderUrls: 20,
} as const;

const TOOL_ICONS: Record<string, React.ReactNode> = Object.fromEntries(
  Object.entries(TOOL_METADATA).map(([name, meta]) => {
    const Icon = meta.iconComponent;
    return [name, <Icon size={14} className={meta.iconClass} />];
  }),
);

function truncateToolCardText(
  value: string,
  truncatedMessage?: string,
): string {
  if (value.length <= TOOL_CARD_LIMITS.maxResultDisplayChars) return value;
  return (
    value.slice(0, TOOL_CARD_LIMITS.maxResultDisplayChars) +
    `\n\n[${truncatedMessage ?? `truncated in UI after ${TOOL_CARD_LIMITS.maxResultDisplayChars} chars`}]`
  );
}

function parseToolJson(result: string): any | null {
  if (result.length > TOOL_CARD_LIMITS.maxJsonParseChars) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

export function countSearchResults(
  result: string,
  truncatedMessage?: string,
): {
  ok: boolean;
  count: number;
  error?: string;
} {
  const d = parseToolJson(result);
  if (!d) {
    return {
      ok: false,
      count: 0,
      error: truncateToolCardText(result, truncatedMessage),
    };
  }
  return { ok: d.ok, count: d.results?.length ?? 0, error: d.error };
}

export function countImageResults(
  result: string,
  truncatedMessage?: string,
): {
  ok: boolean;
  count: number;
  error?: string;
} {
  const d = parseToolJson(result);
  if (!d) {
    return {
      ok: false,
      count: 0,
      error: truncateToolCardText(result, truncatedMessage),
    };
  }
  return { ok: d.ok, count: d.images?.length ?? 0, error: d.error };
}

export function parseNpmSearchResult(
  result: string,
  truncatedMessage?: string,
): {
  success: boolean;
  count: number;
  error?: string;
} {
  const d = parseToolJson(result);
  if (!d) {
    return {
      success: false,
      count: 0,
      error: truncateToolCardText(result, truncatedMessage),
    };
  }
  return { success: d.success, count: d.data?.length ?? 0, error: d.error };
}

export function parseNpmDetailResult(
  result: string,
  truncatedMessage?: string,
): {
  success: boolean;
  name?: string;
  error?: string;
} {
  const d = parseToolJson(result);
  if (!d) {
    return {
      success: false,
      error: truncateToolCardText(result, truncatedMessage),
    };
  }
  return { success: d.success, name: d.data?.name, error: d.error };
}

export function countWebReaderUrls(
  result: string,
): { url: string; ok: boolean }[] {
  const d = parseToolJson(result);
  if (!d) return [];
  return (d.pages ?? [])
    .slice(0, TOOL_CARD_LIMITS.maxReaderUrls)
    .map((p: any) => ({ url: p.url, ok: p.ok }));
}

export function parseConsoleIssues(
  result: string,
): { level: "error" | "warn"; text: string }[] {
  if (!result || result === "No console output yet.") return [];
  return result
    .split("\n")
    .slice(0, TOOL_CARD_LIMITS.maxConsoleLines)
    .filter((line) => line.startsWith("[ERROR]") || line.startsWith("[WARN]"))
    .slice(0, TOOL_CARD_LIMITS.maxConsoleIssues)
    .map((line) => ({
      level: line.startsWith("[ERROR]") ? "error" : "warn",
      text: line.replace(/^\[(ERROR|WARN)\]\s*/, ""),
    }));
}

export type ToolCardStatus = "running" | "completed" | "failed" | "attention";

export function classifyToolCardStatus(
  toolName: string,
  result: string,
  toolOutput?: ToolBlock["toolOutput"],
  skillLoads?: ToolBlock["skillLoads"],
): ToolCardStatus {
  if (skillLoads && skillLoads.length > 0) {
    if (skillLoads.every((skill) => skill.status === "failed")) return "failed";
    if (
      skillLoads.some(
        (skill) => skill.status === "failed" || skill.status === "attention",
      )
    ) {
      return "attention";
    }
    if (skillLoads.some((skill) => skill.status === "running"))
      return "running";
    return "completed";
  }
  if (!result && !toolOutput) return "running";
  if (toolOutput?.isError || result.startsWith("Error")) return "failed";

  if (toolName === "get_console_logs") {
    const issues = parseConsoleIssues(result);
    if (issues.length > 0) return "attention";
    return "completed";
  }

  const structured = parseToolJson(result);
  if (structured && typeof structured === "object") {
    if (toolName === "project_health_check") {
      if (
        structured.ok === false ||
        (Array.isArray(structured.issues) && structured.issues.length > 0)
      ) {
        return "attention";
      }
      return "completed";
    }
    if (structured.ok === false || structured.success === false)
      return "failed";
  }

  return "completed";
}

type ToolCallCardProps = Omit<ToolBlock, "type" | "id">;

export const ToolCallCard = memo(function ToolCallCard({
  toolName,
  title,
  path,
  paths,
  result,
  toolOutput,
  rawArgs,
  skillLoads,
}: ToolCallCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const truncatedMessage = t.tool.truncatedInUi.replace(
    "{count}",
    String(TOOL_CARD_LIMITS.maxResultDisplayChars),
  );
  const displayResult = result
    ? truncateToolCardText(result, truncatedMessage)
    : result;
  const directSkillStatus = classifyToolCardStatus(
    toolName,
    result,
    toolOutput,
  );
  const visibleSkillLoads =
    skillLoads ??
    (toolName === "read_skill"
      ? [
          {
            name:
              typeof rawArgs?.name === "string" && rawArgs.name.trim()
                ? rawArgs.name.trim()
                : title,
            ...(typeof rawArgs?.reference_path === "string" &&
            rawArgs.reference_path.trim()
              ? { referencePaths: [rawArgs.reference_path.trim()] }
              : {}),
            status: directSkillStatus,
            ...(directSkillStatus === "failed" && result
              ? { error: result }
              : {}),
          },
        ]
      : undefined);
  const status = classifyToolCardStatus(
    toolName,
    result,
    toolOutput,
    visibleSkillLoads,
  );
  const statusLabel = t.tool.status[status];

  const searchSummary =
    toolName === "web_search" && result
      ? countSearchResults(result, truncatedMessage)
      : undefined;
  const imageSummary =
    toolName === "image_search" && result
      ? countImageResults(result, truncatedMessage)
      : undefined;
  const npmSearchSummary =
    toolName === "search_npm_packages" && result
      ? parseNpmSearchResult(result, truncatedMessage)
      : undefined;
  const npmDetailSummary =
    toolName === "get_npm_package_detail" && result
      ? parseNpmDetailResult(result, truncatedMessage)
      : undefined;
  const searchResultCount = searchSummary?.count ?? 0;
  const imageResultCount = imageSummary?.count ?? 0;
  const npmSearchCount = npmSearchSummary?.count ?? 0;
  const npmDetailName = npmDetailSummary?.name ?? "";
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
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors cursor-pointer"
      >
        <span className="flex items-center shrink-0">
          {TOOL_ICONS[toolName] ?? (
            <Wrench size={14} className="text-muted-foreground" />
          )}
        </span>
        <span className="text-xs font-medium flex-1 text-foreground">
          {title}
        </span>
        {visibleSkillLoads && visibleSkillLoads.length > 0 ? (
          <Badge variant="secondary" className="text-xs font-mono h-5">
            {visibleSkillLoads.length} {t.tool.skills}
          </Badge>
        ) : toolName === "web_search" && result ? (
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
          <Badge
            variant="secondary"
            className="text-xs font-mono h-5 max-w-35 truncate"
          >
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
              {consoleWarnCount > 0
                ? ` · ${consoleWarnCount} ${t.tool.warnings}`
                : ""}
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
            {path.split("/").pop()}
          </Badge>
        ) : null}
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            status === "running" && "bg-yellow-400 animate-pulse",
            status === "completed" && "bg-green-500",
            status === "failed" && "bg-red-500",
            status === "attention" && "bg-yellow-400",
          )}
          aria-hidden="true"
        />
        <span className="sr-only">{statusLabel}</span>
        <ChevronRight
          size={13}
          className={cn(
            "text-muted-foreground transition-transform shrink-0",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (result || toolOutput || visibleSkillLoads?.length) && (
        <div className="px-3 py-2 border-t border-border/60 bg-muted/20">
          {visibleSkillLoads && visibleSkillLoads.length > 0 ? (
            <div className="space-y-1.5">
              {visibleSkillLoads.map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  {skill.status === "completed" ? (
                    <Check
                      size={13}
                      className="mt-0.5 shrink-0 text-green-500"
                      aria-hidden="true"
                    />
                  ) : skill.status === "failed" ? (
                    <X
                      size={13}
                      className="mt-0.5 shrink-0 text-red-500"
                      aria-hidden="true"
                    />
                  ) : skill.status === "attention" ? (
                    <AlertTriangle
                      size={13}
                      className="mt-0.5 shrink-0 text-yellow-500"
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-yellow-400"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground">
                      {skill.name}
                    </span>
                    {skill.referencePaths &&
                      skill.referencePaths.length > 0 && (
                        <span className="block truncate font-mono text-[11px]">
                          {skill.referencePaths.join(", ")}
                        </span>
                      )}
                    {skill.error && (
                      <span className="block whitespace-pre-wrap text-red-500">
                        {truncateToolCardText(skill.error, truncatedMessage)}
                      </span>
                    )}
                    <span className="sr-only">
                      {t.tool.status[skill.status]}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : toolOutput?.source?.kind === "mcp" ||
            toolOutput?.content?.some((part) => part.type === "local_image") ? (
            <RichToolResult
              output={toolOutput}
              fallback={displayResult ?? ""}
            />
          ) : toolName === "list_files" ? (
            <FileTreeView content={displayResult ?? ""} />
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
                  <div
                    key={i}
                    className={cn(
                      "flex items-start gap-1.5 text-xs font-mono whitespace-pre-wrap leading-relaxed",
                      issue.level === "error"
                        ? "text-red-500"
                        : "text-yellow-600",
                    )}
                  >
                    {issue.level === "error" ? (
                      <X size={12} className="mt-0.5 shrink-0" />
                    ) : (
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    )}
                    <span>{issue.text}</span>
                  </div>
                ))}
              </div>
            )
          ) : toolName === "web_search" ? (
            <p className="text-xs text-muted-foreground">
              {!searchSummary?.ok
                ? `${t.tool.failed}${searchSummary?.error ?? result}`
                : `${t.tool.found}${searchResultCount} ${t.tool.searchResults}`}
            </p>
          ) : toolName === "image_search" ? (
            <p className="text-xs text-muted-foreground">
              {!imageSummary?.ok
                ? `${t.tool.failed}${imageSummary?.error ?? result}`
                : `${t.tool.found}${imageResultCount} ${t.tool.imageResults}`}
            </p>
          ) : toolName === "search_npm_packages" ? (
            <p className="text-xs text-muted-foreground">
              {!npmSearchSummary?.success
                ? `${t.tool.failed}${npmSearchSummary?.error ?? result}`
                : `${t.tool.found}${npmSearchCount} ${t.tool.npmPackages}`}
            </p>
          ) : toolName === "get_npm_package_detail" ? (
            <p className="text-xs text-muted-foreground">
              {!npmDetailSummary?.success
                ? `${t.tool.failed}${npmDetailSummary?.error ?? result}`
                : `${t.tool.found}${npmDetailName}`}
            </p>
          ) : toolName === "web_reader" ? (
            <div className="space-y-0.5">
              {readerUrls.map(({ url, ok }) => (
                <div
                  key={url}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  {ok ? (
                    <Check size={12} className="text-green-500 shrink-0" />
                  ) : (
                    <X size={12} className="text-red-500 shrink-0" />
                  )}
                  <span className="truncate">{url}</span>
                </div>
              ))}
            </div>
          ) : (
            <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
              {displayResult}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

function dataUrl(data: string, mimeType: string): string {
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

function LocalImageResult({ id, name }: { id: string; name: string }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void getAttachmentBlob(id).then((blob) => {
      if (!active || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  if (!url) {
    return (
      <p className="text-xs text-muted-foreground">
        [{name}: {t.tool.emptyEmbeddedResource}]
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <img
        src={url}
        alt={name || t.tool.mcpResultAlt}
        className="max-h-72 max-w-full rounded-md border border-border/60 object-contain"
      />
      <a
        href={url}
        download={name}
        className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
      >
        <Download size={13} />
        {t.explorer.download}
      </a>
    </div>
  );
}

export function safeExternalResourceUrl(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function RichToolResult({
  output,
  fallback,
}: {
  output: NonNullable<ToolBlock["toolOutput"]>;
  fallback: string;
}) {
  const t = useT();
  const truncatedMessage = t.tool.truncatedInUi.replace(
    "{count}",
    String(TOOL_CARD_LIMITS.maxResultDisplayChars),
  );
  const content = output.content ?? [];
  const hasVisibleContent = content.length > 0;
  let structured = "";
  if (output.structuredContent !== undefined) {
    try {
      structured = truncateToolCardText(
        JSON.stringify(output.structuredContent, null, 2),
        truncatedMessage,
      );
    } catch {
      structured = `[${t.tool.structuredContentUnavailable}]`;
    }
  }

  return (
    <div className="space-y-2.5">
      {content.map((part, index) => {
        const key = `${part.type}-${index}`;
        switch (part.type) {
          case "text":
            return (
              <pre
                key={key}
                className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed"
              >
                {truncateToolCardText(part.text, truncatedMessage)}
              </pre>
            );
          case "image":
            return (
              <img
                key={key}
                src={dataUrl(part.data, part.mimeType)}
                alt={t.tool.mcpResultAlt}
                className="max-h-72 max-w-full rounded-md border border-border/60 object-contain"
              />
            );
          case "local_image":
            return <LocalImageResult key={key} id={part.id} name={part.name} />;
          case "audio":
            return (
              <audio
                key={key}
                controls
                preload="none"
                src={dataUrl(part.data, part.mimeType)}
                className="h-9 max-w-full"
              />
            );
          case "resource_link":
            return safeExternalResourceUrl(part.uri) ? (
              <a
                key={key}
                href={safeExternalResourceUrl(part.uri)!}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-start gap-2 rounded-md border border-border/60 px-2.5 py-2 text-xs text-foreground hover:bg-muted/50"
              >
                <ExternalLink size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block font-medium truncate">
                    {part.title || part.name}
                  </span>
                  <span className="block text-muted-foreground truncate">
                    {part.uri}
                  </span>
                </span>
              </a>
            ) : (
              <div
                key={key}
                className="flex items-start gap-2 rounded-md border border-border/60 px-2.5 py-2 text-xs text-foreground"
              >
                <ExternalLink
                  size={13}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0">
                  <span className="block font-medium truncate">
                    {part.title || part.name}
                  </span>
                  <span className="block text-muted-foreground truncate">
                    {part.uri}
                  </span>
                </span>
              </div>
            );
          case "resource":
            return (
              <div
                key={key}
                className="rounded-md border border-border/60 p-2.5"
              >
                <p className="mb-1 truncate text-[11px] font-medium text-foreground">
                  {part.uri}
                </p>
                <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
                  {part.text
                    ? truncateToolCardText(part.text, truncatedMessage)
                    : part.blob
                      ? `[${t.tool.embeddedResource.replace("{type}", part.mimeType || t.tool.binary)}]`
                      : `[${t.tool.emptyEmbeddedResource}]`}
                </pre>
              </div>
            );
          case "placeholder":
            return (
              <p key={key} className="text-xs text-muted-foreground italic">
                [{part.label}: {part.reason}]
              </p>
            );
        }
      })}
      {structured && (
        <details className="rounded-md border border-border/60 px-2.5 py-2">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            {t.tool.structuredContent}
          </summary>
          <pre className="mt-2 text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
            {structured}
          </pre>
        </details>
      )}
      {!hasVisibleContent && !structured && (
        <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
          {fallback}
        </pre>
      )}
    </div>
  );
}
