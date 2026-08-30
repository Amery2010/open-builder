import {
  AlertCircle,
  ExternalLink,
  Image as ImageIcon,
  LoaderCircle,
  Video,
} from "lucide-react";
import type { ToolBlock } from "../../types";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import { agnesToolNameFromAlias } from "../../lib/mcp/agnes/aliases";
import {
  AGNES_MCP_SERVER_ID,
  isAgnesMediaToolContent,
  type AgnesMediaToolContent,
  type AgnesToolName,
} from "../../lib/mcp/agnes/types";
import { normalizeAgnesPublicHttpsUrl } from "../../lib/mcp/agnes/public-url";
import { AGNES_POLLING_SESSION_ID } from "../../lib/mcp/agnes/session";

export function agnesToolNameForBlock(
  block: Pick<ToolBlock, "toolName" | "toolOutput">,
): AgnesToolName | undefined {
  const source = block.toolOutput?.source;
  if (source) {
    if (source.serverId !== AGNES_MCP_SERVER_ID) return undefined;
    return source.toolName === "generate_image" ||
      source.toolName === "create_video" ||
      source.toolName === "get_video_status"
      ? source.toolName
      : undefined;
  }
  return agnesToolNameFromAlias(block.toolName);
}

function readLegacyAgnesContent(
  result: string,
  toolName: AgnesToolName,
): AgnesMediaToolContent | undefined {
  if (!result || result.length > 20_000) return undefined;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (
      parsed.provider !== "Agnes AI" ||
      parsed.operation !== toolName ||
      (parsed.status !== "queued" &&
        parsed.status !== "in_progress" &&
        parsed.status !== "completed" &&
        parsed.status !== "failed")
    ) {
      return undefined;
    }
    const candidate: AgnesMediaToolContent = {
      kind: "agnes_media_v1",
      operation: toolName,
      mediaType: toolName === "generate_image" ? "image" : "video",
      status: parsed.status,
      ...(Array.isArray(parsed.urls) ? { urls: parsed.urls as string[] } : {}),
      ...(typeof parsed.video_id === "string"
        ? { videoId: parsed.video_id }
        : {}),
      ...(typeof parsed.task_id === "string" ? { taskId: parsed.task_id } : {}),
      ...(typeof parsed.progress === "number"
        ? { progress: parsed.progress }
        : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      ...(parsed.retried === true ? { retried: true } : {}),
      ...(parsed.duplicate_possible === true
        ? { duplicatePossible: true }
        : {}),
    };
    return isAgnesMediaToolContent(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function safeHttpsUrl(value: string): string | null {
  try {
    return normalizeAgnesPublicHttpsUrl(value, "media URL");
  } catch {
    return null;
  }
}

function aspectRatio(block: ToolBlock, mediaType: "image" | "video"): string {
  const structured = isAgnesMediaToolContent(
    block.toolOutput?.structuredContent,
  )
    ? block.toolOutput.structuredContent.ratio
    : undefined;
  const raw =
    structured ??
    (typeof block.rawArgs?.ratio === "string"
      ? block.rawArgs.ratio
      : typeof block.rawArgs?.aspect_ratio === "string"
        ? block.rawArgs.aspect_ratio
        : undefined);
  const ratios: Record<string, string> = {
    "1:1": "1 / 1",
    "3:4": "3 / 4",
    "4:3": "4 / 3",
    "16:9": "16 / 9",
    "9:16": "9 / 16",
    "2:3": "2 / 3",
    "3:2": "3 / 2",
    "21:9": "21 / 9",
  };
  return ratios[raw ?? ""] ?? (mediaType === "image" ? "1 / 1" : "16 / 9");
}

export function AgnesMediaResult({ block }: { block: ToolBlock }) {
  const t = useT();
  const toolName = agnesToolNameForBlock(block);
  if (!toolName) return null;
  const structured = isAgnesMediaToolContent(
    block.toolOutput?.structuredContent,
  )
    ? block.toolOutput.structuredContent
    : readLegacyAgnesContent(block.result, toolName);
  const mediaType =
    structured?.mediaType ??
    (toolName === "generate_image" ? "image" : "video");
  const urls = (Array.isArray(structured?.urls) ? structured.urls : [])
    .map(safeHttpsUrl)
    .filter((url): url is string => Boolean(url));
  const failed =
    block.toolOutput?.isError === true ||
    structured?.status === "failed" ||
    (Boolean(block.result) && !structured);
  const complete = structured?.status === "completed" && urls.length > 0;
  const ratio = aspectRatio(block, mediaType);
  const videoAwaitingCompletion =
    mediaType === "video" &&
    (structured?.status === "queued" || structured?.status === "in_progress");
  const pollingNotResumed =
    videoAwaitingCompletion &&
    structured?.operation === "create_video" &&
    structured.pollingSessionId !== AGNES_POLLING_SESSION_ID;
  const manualRefreshNeeded =
    videoAwaitingCompletion && structured?.operation === "get_video_status";
  const statusLabel = pollingNotResumed
    ? t.mcp.agnes.media.pollingNotResumed
    : manualRefreshNeeded
      ? t.mcp.agnes.media.manualRefreshNeeded
      : structured?.pollingState === "timed_out" ||
          structured?.pollingState === "stopped"
        ? t.mcp.agnes.media.pollingStopped
        : structured?.pollingState === "error"
          ? t.mcp.agnes.media.statusUnavailable
          : structured?.pollingState === "paused"
            ? t.mcp.agnes.media.pollingPaused
            : mediaType === "image"
              ? t.mcp.agnes.media.generatingImage
              : structured?.status === "in_progress"
                ? t.mcp.agnes.media.generatingVideo
                : t.mcp.agnes.media.queuedVideo;
  const pollingActive =
    !pollingNotResumed &&
    !manualRefreshNeeded &&
    structured?.pollingState !== "paused" &&
    structured?.pollingState !== "stopped" &&
    structured?.pollingState !== "timed_out" &&
    structured?.pollingState !== "error";

  if (complete && mediaType === "image") {
    return (
      <figure className="grid max-w-2xl gap-2 sm:grid-cols-2">
        {urls.map((url, index) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className={urls.length === 1 ? "sm:col-span-2" : undefined}
          >
            <img
              src={url}
              alt={t.mcp.agnes.media.imageAlt.replace(
                "{index}",
                String(index + 1),
              )}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="max-h-[34rem] w-full rounded-xl border border-border/60 bg-muted object-contain"
            />
          </a>
        ))}
      </figure>
    );
  }

  if (complete && mediaType === "video") {
    const url = urls[0];
    return (
      <figure className="max-w-2xl space-y-1.5">
        <video
          key={url}
          controls
          playsInline
          preload="metadata"
          src={url}
          className="w-full rounded-xl border border-border/60 bg-black"
        />
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{t.mcp.agnes.media.openVideo}</span>
        </a>
      </figure>
    );
  }

  if (failed || (structured?.status === "completed" && urls.length === 0)) {
    return (
      <div
        role="alert"
        className="flex max-w-2xl items-start gap-2 rounded-xl border border-dashed border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
      >
        <AlertCircle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          {structured?.error ||
            (mediaType === "image"
              ? t.mcp.agnes.media.imageFailed
              : t.mcp.agnes.media.videoFailed)}
        </span>
      </div>
    );
  }

  const Icon = mediaType === "image" ? ImageIcon : Video;
  const progress = structured?.progress;
  return (
    <div
      role="status"
      aria-busy={pollingActive}
      className="relative flex max-w-2xl items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/40"
      style={{ aspectRatio: ratio }}
    >
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-br from-muted/20 via-muted to-muted/30",
          pollingActive && "animate-pulse",
        )}
      />
      <div className="relative flex max-w-[80%] flex-col items-center gap-2 text-center text-muted-foreground">
        <span className="relative flex h-9 w-9 items-center justify-center">
          <Icon size={24} aria-hidden="true" />
          <LoaderCircle
            size={38}
            className={cn(
              "absolute opacity-60",
              pollingActive && "animate-spin",
            )}
            aria-hidden="true"
          />
        </span>
        <span className="text-sm font-medium text-foreground">
          {statusLabel}
        </span>
        {mediaType === "video" && typeof progress === "number" && (
          <div className="w-48 max-w-full space-y-1">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              className="h-1.5 overflow-hidden rounded-full bg-background/70"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[11px]">{progress}%</span>
          </div>
        )}
      </div>
    </div>
  );
}
