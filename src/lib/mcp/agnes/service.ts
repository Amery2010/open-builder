import type {
  ToolExecutionContext,
  ToolExecutionOutput,
} from "../../ai/generator-types";
import { recordPermissionActivity } from "../../security/activity-log";
import { TOOL_POLICY_VERSION } from "../../ai/tool-policy-version";
import { useMcpStore } from "../../../store/mcp";
import type { McpToolCaller } from "../runtime";
import {
  assertMcpLifecycleCurrent,
  captureMcpLifecycleEpoch,
} from "../revocation";
import { AGNES_TOOL_ALIASES } from "./aliases";
import { resolveAgnesImageReferences } from "./attachments";
import {
  AgnesApiError,
  createAgnesVideo,
  generateAgnesImage,
  getAgnesVideoStatus,
  type AgnesVideoResult,
} from "./client";
import { getAgnesVideoTaskManager } from "./video-task-manager";
import {
  AGNES_API_ORIGIN,
  AGNES_MCP_SERVER_ID,
  AGNES_MCP_SERVER_NAME,
  isAgnesToolName,
  type AgnesMediaToolContent,
  type AgnesToolName,
} from "./types";
import { AGNES_POLLING_SESSION_ID } from "./session";

const IMAGE_SIZES = new Set(["1K", "2K", "3K", "4K"]);
const IMAGE_RATIOS = new Set([
  "1:1",
  "3:4",
  "4:3",
  "16:9",
  "9:16",
  "2:3",
  "3:2",
  "21:9",
]);
const VIDEO_RATIOS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);

interface AgnesAccessSnapshot {
  lifecycleEpoch: number;
  revision: number;
  apiKey: string;
  permissionTool: AgnesToolName;
  subagentAccess: boolean;
}

interface SharedStatusRequest {
  controller: AbortController;
  consumers: number;
  promise: Promise<AgnesVideoResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePrompt(value: unknown): string {
  if (typeof value !== "string") throw new Error("prompt must be a string.");
  const prompt = value.trim();
  if (!prompt) throw new Error("prompt must not be empty.");
  if (prompt.length > 16_000) {
    throw new Error("prompt exceeds 16000 characters.");
  }
  return prompt;
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 5 ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${label} must contain at most 5 non-empty strings.`);
  }
  return value.map((item) => String(item).trim());
}

function enumValue(
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback: string,
  label: string,
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${label} is unsupported.`);
  }
  return value;
}

function secondsValue(value: unknown): number {
  if (value === undefined) return 5;
  if (!Number.isInteger(value) || Number(value) < 4 || Number(value) > 12) {
    throw new Error("seconds must be an integer from 4 to 12.");
  }
  return Number(value);
}

function source(toolName: AgnesToolName) {
  return {
    kind: "mcp" as const,
    serverId: AGNES_MCP_SERVER_ID,
    serverName: AGNES_MCP_SERVER_NAME,
    toolName,
    toolTitle:
      toolName === "generate_image"
        ? "Generate image"
        : toolName === "create_video"
          ? "Create video"
          : "Get video status",
    alias: AGNES_TOOL_ALIASES[toolName],
  };
}

function mediaOutput(
  toolName: AgnesToolName,
  content: AgnesMediaToolContent,
): ToolExecutionOutput {
  const urls = content.urls ?? [];
  return {
    text: JSON.stringify({
      provider: "Agnes AI",
      operation: content.operation,
      status: content.status,
      ...(content.videoId ? { video_id: content.videoId } : {}),
      ...(content.taskId ? { task_id: content.taskId } : {}),
      ...(content.progress !== undefined ? { progress: content.progress } : {}),
      ...(urls.length ? { urls } : {}),
      ...(content.retried ? { retried: true } : {}),
      ...(content.duplicatePossible ? { duplicate_possible: true } : {}),
      ...(content.error ? { error: content.error } : {}),
    }),
    isError: content.status === "failed",
    structuredContent: content,
    content: urls.map((url, index) => ({
      type: "resource_link" as const,
      uri: url,
      name:
        content.mediaType === "image"
          ? `Agnes image ${index + 1}`
          : "Agnes video",
      title:
        content.mediaType === "image"
          ? `Generated image ${index + 1}`
          : "Generated video",
    })),
    source: source(toolName),
  };
}

function videoContent(
  result: AgnesVideoResult,
  operation: "create_video" | "get_video_status",
  ratio?: string,
): AgnesMediaToolContent {
  return {
    kind: "agnes_media_v1",
    operation,
    mediaType: "video",
    status: result.status,
    ...(result.url ? { urls: [result.url] } : {}),
    videoId: result.videoId,
    taskId: result.taskId,
    progress: result.progress,
    size: result.size ?? "720P",
    ...(ratio ? { ratio } : {}),
    seconds: result.seconds,
    ...(operation === "create_video" &&
    (result.status === "queued" || result.status === "in_progress")
      ? { pollingSessionId: AGNES_POLLING_SESSION_ID }
      : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.retried ? { retried: true } : {}),
    ...(result.duplicatePossible ? { duplicatePossible: true } : {}),
  };
}

function failureOutput(
  toolName: AgnesToolName,
  mediaType: "image" | "video",
  error: unknown,
): ToolExecutionOutput {
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  const message =
    error instanceof AgnesApiError || error instanceof Error
      ? error.message
      : "Agnes request failed.";
  return mediaOutput(toolName, {
    kind: "agnes_media_v1",
    operation: toolName,
    mediaType,
    status: "failed",
    error: message.slice(0, 500),
    ...(error instanceof AgnesApiError && error.duplicatePossible
      ? { duplicatePossible: true }
      : {}),
  });
}

export class AgnesMcpService implements McpToolCaller {
  private readonly activeControllers = new Set<AbortController>();
  private readonly statusRequests = new Map<string, SharedStatusRequest>();

  abortAll(): void {
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
    for (const entry of this.statusRequests.values()) entry.controller.abort();
    this.statusRequests.clear();
  }

  private accessSnapshot(
    permissionTool: AgnesToolName,
    subagentAccess = false,
  ): AgnesAccessSnapshot {
    const state = useMcpStore.getState();
    const settings = state.agnes;
    if (
      !state.globalEnabled ||
      !settings.enabled ||
      !settings.apiKey.trim() ||
      !settings.tools[permissionTool].enabled ||
      (subagentAccess &&
        (permissionTool !== "generate_image" ||
          !settings.tools.generate_image.allowForSubagents ||
          settings.tools.generate_image.subagentPolicyVersion !==
            TOOL_POLICY_VERSION))
    ) {
      throw new Error("Agnes is disabled or no longer approved.");
    }
    return {
      lifecycleEpoch: captureMcpLifecycleEpoch(),
      revision: settings.updatedAt,
      apiKey: settings.apiKey,
      permissionTool,
      subagentAccess,
    };
  }

  private assertSnapshotCurrent(snapshot: AgnesAccessSnapshot): void {
    assertMcpLifecycleCurrent(snapshot.lifecycleEpoch);
    const state = useMcpStore.getState();
    const settings = state.agnes;
    if (
      !state.globalEnabled ||
      !settings.enabled ||
      settings.apiKey !== snapshot.apiKey ||
      !settings.tools[snapshot.permissionTool].enabled ||
      (snapshot.subagentAccess &&
        (snapshot.permissionTool !== "generate_image" ||
          !settings.tools.generate_image.allowForSubagents ||
          settings.tools.generate_image.subagentPolicyVersion !==
            TOOL_POLICY_VERSION))
    ) {
      throw new DOMException("Agnes access was revoked.", "AbortError");
    }
  }

  private async withRequest<T>(
    permissionTool: AgnesToolName,
    externalSignal: AbortSignal,
    task: (signal: AbortSignal, apiKey: string) => Promise<T>,
    subagentAccess = false,
  ): Promise<T> {
    const snapshot = this.accessSnapshot(permissionTool, subagentAccess);
    if (externalSignal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal.reason);
    externalSignal.addEventListener("abort", abort, { once: true });
    this.activeControllers.add(controller);
    try {
      const result = await task(controller.signal, snapshot.apiKey);
      this.assertSnapshotCurrent(snapshot);
      return result;
    } finally {
      externalSignal.removeEventListener("abort", abort);
      this.activeControllers.delete(controller);
    }
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionOutput> {
    if (!isAgnesToolName(toolName)) {
      return {
        text: `Error: unknown Agnes tool "${toolName}".`,
        isError: true,
      };
    }
    if (
      serverId !== AGNES_MCP_SERVER_ID ||
      context.run.policyVersion !== TOOL_POLICY_VERSION ||
      !context.run.allowedMcpAliases.has(AGNES_TOOL_ALIASES[toolName])
    ) {
      return {
        text: `Error: Agnes tool "${toolName}" is not authorized for this run.`,
        isError: true,
        source: source(toolName),
      };
    }
    const settings = useMcpStore.getState().agnes;
    const approval = settings.tools[toolName];
    const allowedForMode =
      context.run.mode === "chat" ||
      (context.run.mode === "subagent" &&
        toolName === "generate_image" &&
        approval.allowForSubagents &&
        approval.subagentPolicyVersion === TOOL_POLICY_VERSION);
    if (
      !useMcpStore.getState().globalEnabled ||
      !settings.enabled ||
      !settings.apiKey.trim() ||
      !approval.enabled ||
      !allowedForMode
    ) {
      return {
        text: `Error: Agnes tool "${toolName}" is disabled or not approved for this run.`,
        isError: true,
        source: source(toolName),
      };
    }

    recordPermissionActivity({
      conversationId: context.run.conversationId,
      tool: toolName,
      source: "mcp",
      mode: context.run.mode,
      platform: context.run.platform,
      decision: "allowed",
      target: AGNES_API_ORIGIN,
      mcp: {
        serverId: AGNES_MCP_SERVER_ID,
        serverName: AGNES_MCP_SERVER_NAME,
        toolTitle: source(toolName).toolTitle,
      },
    });

    const input = isRecord(args) ? args : {};
    try {
      if (toolName === "generate_image") {
        const prompt = requirePrompt(input.prompt);
        const size = enumValue(input.size, IMAGE_SIZES, "1K", "size");
        const ratio = enumValue(input.ratio, IMAGE_RATIOS, "1:1", "ratio");
        const attachmentIds = optionalStringArray(
          input.attachment_ids,
          "attachment_ids",
        );
        const imageUrls = optionalStringArray(input.image_urls, "image_urls");
        if (context.run.mode === "subagent" && attachmentIds.length > 0) {
          throw new Error(
            "Subagents may use text prompts or public HTTPS image URLs, but not current-message attachment IDs.",
          );
        }
        const images = resolveAgnesImageReferences({
          conversationId: context.run.conversationId,
          attachmentIds,
          imageUrls,
        });
        const result = await this.withRequest(
          "generate_image",
          context.signal,
          (signal, apiKey) =>
            generateAgnesImage(
              { prompt, size, ratio, images },
              { apiKey, signal },
            ),
          context.run.mode === "subagent",
        );
        return mediaOutput(toolName, {
          kind: "agnes_media_v1",
          operation: "generate_image",
          mediaType: "image",
          status: "completed",
          urls: result.urls,
          size,
          ratio,
          ...(result.retried ? { retried: true } : {}),
          ...(result.duplicatePossible ? { duplicatePossible: true } : {}),
        });
      }

      if (toolName === "create_video") {
        const prompt = requirePrompt(input.prompt);
        const seconds = secondsValue(input.seconds);
        const aspectRatio = enumValue(
          input.aspect_ratio,
          VIDEO_RATIOS,
          "16:9",
          "aspect_ratio",
        );
        const result = await this.withRequest(
          "create_video",
          context.signal,
          (signal, apiKey) =>
            createAgnesVideo(
              { prompt, seconds, aspectRatio },
              { apiKey, signal },
            ),
        );
        const output = mediaOutput(
          toolName,
          videoContent(result, "create_video", aspectRatio),
        );
        if (
          context.run.conversationId &&
          (result.status === "queued" || result.status === "in_progress")
        ) {
          getAgnesVideoTaskManager().register({
            conversationId: context.run.conversationId,
            toolCallId: context.toolCallId,
            videoId: result.videoId,
            initialOutput: output,
            poll: (signal) =>
              this.queryVideoOutput(result.videoId, signal, "create_video"),
          });
        }
        return output;
      }

      const videoId =
        typeof input.video_id === "string" ? input.video_id.trim() : "";
      if (!videoId || videoId.length > 512) {
        throw new Error("video_id must be a non-empty string.");
      }
      const output = await this.queryVideoOutput(
        videoId,
        context.signal,
        "get_video_status",
      );
      if (context.run.conversationId) {
        getAgnesVideoTaskManager().applyManualResult(
          context.run.conversationId,
          videoId,
          output,
        );
      }
      return output;
    } catch (error) {
      return failureOutput(
        toolName,
        toolName === "generate_image" ? "image" : "video",
        error,
      );
    }
  }

  private async queryVideoOutput(
    videoId: string,
    signal: AbortSignal,
    permissionTool: "create_video" | "get_video_status",
  ): Promise<ToolExecutionOutput> {
    const snapshot = this.accessSnapshot(permissionTool);
    const requestKey = `${videoId}\0${snapshot.revision}`;
    let entry = this.statusRequests.get(requestKey);
    if (!entry) {
      const controller = new AbortController();
      const promise = getAgnesVideoStatus(videoId, {
        apiKey: snapshot.apiKey,
        signal: controller.signal,
      }).finally(() => {
        if (this.statusRequests.get(requestKey)?.promise === promise) {
          this.statusRequests.delete(requestKey);
        }
      });
      entry = { controller, consumers: 0, promise };
      this.statusRequests.set(requestKey, entry);
    }
    entry.consumers += 1;
    try {
      const result = await this.waitForStatusConsumer(entry.promise, signal);
      this.assertSnapshotCurrent(snapshot);
      return mediaOutput(
        "get_video_status",
        videoContent(result, "get_video_status"),
      );
    } finally {
      entry.consumers -= 1;
      if (entry.consumers === 0 && this.statusRequests.has(requestKey)) {
        entry.controller.abort();
        this.statusRequests.delete(requestKey);
      }
    }
  }

  private async waitForStatusConsumer<T>(
    promise: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }
}

let service: AgnesMcpService | undefined;

export function getAgnesMcpService(): AgnesMcpService {
  service ??= new AgnesMcpService();
  return service;
}

export function abortAgnesMcpRequests(): void {
  service?.abortAll();
}
