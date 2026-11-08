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
import { CANCELLED_TOOL_OUTPUT_KIND } from "../../lib/ai/run-guard";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";

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
  count: number | null;
  sources: { title: string; url: string; snippet?: string }[];
  error?: string;
} {
  // Older Local CLI messages persisted this completion text or a bare array.
  if (result === "web_search completed without structured results.") {
    return { ok: true, count: null, sources: [] };
  }
  const d = parseToolJson(result);
  if (!d || typeof d !== "object") {
    return {
      ok: false,
      count: null,
      sources: [],
      error: truncateToolCardText(result, truncatedMessage),
    };
  }
  const results: unknown[] | null = Array.isArray(d)
    ? d
    : Array.isArray(d.results)
      ? d.results
      : null;
  const ok = Array.isArray(d) || d.ok === true;
  // Native CLI and older messages may have an empty details array without a
  // match count. Only the known Host search contracts establish a true zero.
  const confirmedHostSearch =
    !Array.isArray(d) &&
    ["tavily", "firecrawl", "exa"].includes(d.meta?.engine);
  const sources: { title: string; url: string; snippet?: string }[] = [];
  const seen = new Set<string>();
  if (ok) {
    for (const entry of results ?? []) {
      if (!entry || typeof entry !== "object") continue;
      const source = entry as Record<string, unknown>;
      const url =
        typeof source.url === "string"
          ? safeExternalResourceUrl(source.url)
          : null;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const snippet = source.snippet ?? source.content;
      sources.push({
        title:
          typeof source.title === "string" && source.title.trim()
            ? source.title
            : url,
        url,
        ...(typeof snippet === "string" && snippet ? { snippet } : {}),
      });
    }
  }
  return {
    ok,
    count:
      results?.length === 0 && !confirmedHostSearch
        ? null
        : (results?.length ?? null),
    sources,
    error: typeof d.error === "string" ? d.error : undefined,
  };
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
  packages: { name: string; version?: string; description?: string }[];
  error?: string;
} {
  const d = parseToolJson(result);
  if (!d || d.success !== true || !Array.isArray(d.data)) {
    return {
      success: false,
      count: 0,
      packages: [],
      error:
        typeof d?.error === "string"
          ? truncateToolCardText(d.error, truncatedMessage)
          : truncateToolCardText(result, truncatedMessage),
    };
  }
  const packages = (d.data as unknown[]).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const pkg = value as Record<string, unknown>;
    if (typeof pkg.name !== "string" || !pkg.name.trim()) return [];
    return [
      {
        name: pkg.name,
        version: typeof pkg.version === "string" ? pkg.version : undefined,
        description:
          typeof pkg.description === "string" ? pkg.description : undefined,
      },
    ];
  });
  return { success: true, count: packages.length, packages };
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

export type ToolCardStatus =
  "running" | "completed" | "failed" | "attention" | "aborted";

function cancelledToolReason(output?: ToolBlock["toolOutput"]) {
  const data = output?.structuredContent;
  if (
    !data ||
    typeof data !== "object" ||
    !("kind" in data) ||
    data.kind !== CANCELLED_TOOL_OUTPUT_KIND
  )
    return undefined;
  const reason = "reason" in data ? data.reason : undefined;
  return reason === "user-stopped" || reason === "conversation-switched"
    ? reason
    : "interrupted";
}

export function classifyToolCardStatus(
  toolName: string,
  result: string,
  toolOutput?: ToolBlock["toolOutput"],
  skillLoads?: ToolBlock["skillLoads"],
): ToolCardStatus {
  if (cancelledToolReason(toolOutput)) return "aborted";
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

type ToolCallCardProps = Omit<ToolBlock, "type" | "id"> & {
  status?: ToolCardStatus | "aborted";
};

export const ToolCallCard = memo(function ToolCallCard({
  toolName,
  title,
  path,
  paths,
  result,
  toolOutput,
  rawArgs,
  skillLoads,
  status: explicitStatus,
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
            status:
              directSkillStatus === "aborted"
                ? ("attention" as const)
                : directSkillStatus,
            ...(directSkillStatus === "failed" && result
              ? { error: result }
              : {}),
          },
        ]
      : undefined);
  const inferredStatus = classifyToolCardStatus(
    toolName,
    result,
    toolOutput,
    visibleSkillLoads,
  );
  const status =
    explicitStatus === "completed"
      ? inferredStatus === "running"
        ? "completed"
        : inferredStatus
      : (explicitStatus ?? inferredStatus);
  const emptyResult =
    !result &&
    !toolOutput?.text &&
    !toolOutput?.content?.length &&
    !toolOutput?.structuredContent &&
    !visibleSkillLoads?.length &&
    status !== "running";
  const hasDetails = Boolean(
    result || toolOutput || visibleSkillLoads?.length || status !== "running",
  );
  const statusLabel =
    status === "aborted"
      ? t.tool.cancelledReasons[
          cancelledToolReason(toolOutput) ?? "interrupted"
        ]
      : t.tool.status[status];
  const styleResult =
    toolName === "apply_design_style" ? parseToolJson(result) : null;
  const appliedStyle =
    typeof styleResult?.style === "string"
      ? styleResult.style
      : typeof rawArgs?.style === "string"
        ? rawArgs.style
        : "";
  const designStyleSummary =
    status === "completed" && appliedStyle
      ? t.tool.designStyleApplied.replace("{style}", appliedStyle.slice(0, 120))
      : status === "failed"
        ? t.tool.designStyleFailed.replace(
            "{reason}",
            String(styleResult?.error ?? toolOutput?.text ?? result).slice(
              0,
              240,
            ),
          )
        : statusLabel;

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
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="border border-border/60 rounded-lg overflow-hidden bg-muted/30"
    >
      <CollapsibleTrigger
        type="button"
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
        ) : toolName === "web_search" && searchSummary?.count != null ? (
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
            status === "aborted" && "bg-muted-foreground",
          )}
          aria-hidden="true"
        />
        <span
          className={
            status === "aborted" ? "text-xs text-muted-foreground" : "sr-only"
          }
        >
          {statusLabel}
        </span>
        <ChevronRight
          size={13}
          className={cn(
            "text-muted-foreground transition-transform duration-300 shrink-0",
            expanded && "rotate-90",
          )}
        />
      </CollapsibleTrigger>

      {hasDetails && (
        <CollapsibleContent>
          <div className="px-3 py-2 border-t border-border/60 bg-muted/20">
            {status === "aborted" ? (
              <p className="text-xs text-muted-foreground">{statusLabel}</p>
            ) : toolName === "apply_design_style" ? (
              <p className="text-xs text-muted-foreground">
                {designStyleSummary}
              </p>
            ) : emptyResult ? (
              <p className="text-xs text-muted-foreground">
                {status === "completed" ? t.tool.emptyResult : statusLabel}
              </p>
            ) : visibleSkillLoads && visibleSkillLoads.length > 0 ? (
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
              toolOutput?.content?.some(
                (part) => part.type === "local_image",
              ) ? (
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
              <div className="space-y-3 text-xs">
                <p className="text-muted-foreground">
                  {!searchSummary?.ok
                    ? `${t.tool.failed}${searchSummary?.error ?? displayResult}`
                    : searchSummary.count === null
                      ? t.tool.searchResultsUnavailable
                      : `${t.tool.found}${searchResultCount} ${t.tool.searchResults}`}
                </p>
                {searchSummary?.sources.length ? (
                  <ul className="space-y-3">
                    {searchSummary.sources.map((source) => (
                      <li key={source.url} className="min-w-0 space-y-1">
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-full items-start gap-1 text-primary hover:underline"
                        >
                          <span className="min-w-0 truncate">
                            {source.title}
                          </span>
                          <ExternalLink
                            size={12}
                            className="mt-0.5 shrink-0"
                            aria-hidden="true"
                          />
                        </a>
                        <span className="block truncate text-muted-foreground">
                          {source.url}
                        </span>
                        {source.snippet ? (
                          <p className="line-clamp-2 break-words text-muted-foreground">
                            {source.snippet}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : toolName === "image_search" ? (
              <p className="text-xs text-muted-foreground">
                {!imageSummary?.ok
                  ? `${t.tool.failed}${imageSummary?.error ?? result}`
                  : `${t.tool.found}${imageResultCount} ${t.tool.imageResults}`}
              </p>
            ) : toolName === "search_npm_packages" ? (
              <div className="space-y-2 text-xs">
                <p className="text-muted-foreground">
                  {!npmSearchSummary?.success
                    ? `${t.tool.failed}${npmSearchSummary?.error ?? result}`
                    : `${t.tool.found}${npmSearchCount} ${t.tool.npmPackages}`}
                </p>
                {npmSearchSummary?.success && npmSearchCount > 0 && (
                  <ul className="space-y-2">
                    {npmSearchSummary.packages.map((pkg, index) => (
                      <li key={`${pkg.name}-${index}`}>
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-foreground break-all">
                            {pkg.name}
                          </span>
                          {pkg.version && (
                            <span className="font-mono text-muted-foreground">
                              {pkg.version}
                            </span>
                          )}
                        </div>
                        {pkg.description && (
                          <p className="text-muted-foreground break-words">
                            {pkg.description}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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
        </CollapsibleContent>
      )}
    </Collapsible>
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
        <Collapsible className="rounded-md border border-border/60 px-2.5 py-2">
          <CollapsibleTrigger className="group flex w-full items-center gap-1 text-left text-xs font-medium text-foreground">
            <ChevronRight
              className="size-3 transition-transform duration-300 group-data-[state=open]:rotate-90"
              aria-hidden="true"
            />
            {t.tool.structuredContent}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
              {structured}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
      {!hasVisibleContent && !structured && (
        <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed">
          {fallback}
        </pre>
      )}
    </div>
  );
}
