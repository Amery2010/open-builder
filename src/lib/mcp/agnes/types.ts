import type { McpToolDefinition } from "../types";
import { TOOL_POLICY_VERSION } from "../../ai/tool-policy-version";

// ':' is deliberately outside the external MCP server-id grammar, so an
// imported server cannot collide with this managed identity.
export const AGNES_MCP_SERVER_ID = "managed:agnes";
export const AGNES_MCP_SERVER_NAME = "Agnes AI";
export const AGNES_MCP_DEFINITION_VERSION = 1;

export const AGNES_IMAGE_MODEL = "agnes-image-2.1-flash";
export const AGNES_VIDEO_MODEL = "agnes-video-2.5-flash";
export const AGNES_API_ORIGIN = "https://apihub.agnes-ai.com";

export const AGNES_TOOL_NAMES = [
  "generate_image",
  "create_video",
  "get_video_status",
] as const;

export type AgnesToolName = (typeof AGNES_TOOL_NAMES)[number];

export interface AgnesToolApproval {
  enabled: boolean;
  /** Trusted, built-in exception. Only generate_image may set this to true. */
  allowForSubagents: boolean;
  subagentPolicyVersion?: string;
}

export interface AgnesMcpSettings {
  enabled: boolean;
  apiKey: string;
  definitionVersion: number;
  tools: Record<AgnesToolName, AgnesToolApproval>;
  updatedAt: number;
}

export type AgnesMediaStatus =
  "queued" | "in_progress" | "completed" | "failed";

export interface AgnesMediaToolContent {
  kind: "agnes_media_v1";
  operation: "generate_image" | "create_video" | "get_video_status";
  mediaType: "image" | "video";
  status: AgnesMediaStatus;
  prompt?: string;
  urls?: string[];
  videoId?: string;
  taskId?: string;
  progress?: number;
  size?: string;
  ratio?: string;
  seconds?: string;
  pollingState?: "active" | "paused" | "stopped" | "timed_out" | "error";
  pollingSessionId?: string;
  error?: string;
  retried?: boolean;
  duplicatePossible?: boolean;
}

export function createDefaultAgnesMcpSettings(
  now = Date.now(),
): AgnesMcpSettings {
  return {
    enabled: false,
    apiKey: "",
    definitionVersion: AGNES_MCP_DEFINITION_VERSION,
    tools: {
      generate_image: {
        enabled: false,
        allowForSubagents: false,
        subagentPolicyVersion: undefined,
      },
      create_video: { enabled: false, allowForSubagents: false },
      get_video_status: { enabled: false, allowForSubagents: false },
    },
    updatedAt: now,
  };
}

export function normalizeAgnesMcpSettings(
  value: Partial<AgnesMcpSettings> | undefined,
  now = Date.now(),
): AgnesMcpSettings {
  const apiKey = typeof value?.apiKey === "string" ? value.apiKey : "";
  const definitionsCurrent =
    value?.definitionVersion === AGNES_MCP_DEFINITION_VERSION;
  return {
    enabled: Boolean(value?.enabled && apiKey.trim()),
    apiKey,
    definitionVersion: AGNES_MCP_DEFINITION_VERSION,
    tools: Object.fromEntries(
      AGNES_TOOL_NAMES.map((name) => {
        const saved = definitionsCurrent ? value?.tools?.[name] : undefined;
        const allowForSubagents =
          name === "generate_image" &&
          Boolean(saved?.enabled && saved.allowForSubagents) &&
          saved?.subagentPolicyVersion === TOOL_POLICY_VERSION;
        return [
          name,
          {
            enabled: Boolean(saved?.enabled),
            allowForSubagents,
            ...(allowForSubagents
              ? { subagentPolicyVersion: TOOL_POLICY_VERSION }
              : {}),
          },
        ];
      }),
    ) as Record<AgnesToolName, AgnesToolApproval>,
    updatedAt:
      typeof value?.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
}

export function isAgnesToolName(value: string): value is AgnesToolName {
  return (AGNES_TOOL_NAMES as readonly string[]).includes(value);
}

export function isAgnesMediaToolContent(
  value: unknown,
): value is AgnesMediaToolContent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgnesMediaToolContent>;
  const optionalStrings = [
    candidate.prompt,
    candidate.videoId,
    candidate.taskId,
    candidate.size,
    candidate.ratio,
    candidate.seconds,
    candidate.error,
    candidate.pollingSessionId,
  ];
  return (
    candidate.kind === "agnes_media_v1" &&
    (candidate.mediaType === "image" || candidate.mediaType === "video") &&
    (candidate.operation === "generate_image" ||
      candidate.operation === "create_video" ||
      candidate.operation === "get_video_status") &&
    (candidate.status === "queued" ||
      candidate.status === "in_progress" ||
      candidate.status === "completed" ||
      candidate.status === "failed") &&
    optionalStrings.every(
      (item) =>
        item === undefined ||
        (typeof item === "string" && item.length <= 16_000),
    ) &&
    (candidate.urls === undefined ||
      (Array.isArray(candidate.urls) &&
        candidate.urls.length <= 5 &&
        candidate.urls.every(
          (url) => typeof url === "string" && url.length <= 4_096,
        ))) &&
    (candidate.progress === undefined ||
      (Number.isInteger(candidate.progress) &&
        candidate.progress >= 0 &&
        candidate.progress <= 100)) &&
    (candidate.pollingState === undefined ||
      candidate.pollingState === "active" ||
      candidate.pollingState === "paused" ||
      candidate.pollingState === "stopped" ||
      candidate.pollingState === "timed_out" ||
      candidate.pollingState === "error") &&
    (candidate.retried === undefined ||
      typeof candidate.retried === "boolean") &&
    (candidate.duplicatePossible === undefined ||
      typeof candidate.duplicatePossible === "boolean")
  );
}

export const AGNES_TOOL_DEFINITIONS: Record<AgnesToolName, McpToolDefinition> =
  {
    generate_image: {
      name: "generate_image",
      title: "Generate image",
      description:
        "Generate an image with Agnes Image 2.1 Flash. With no references it performs text-to-image; with one or more current-message attachment IDs or public HTTPS image URLs it performs image-to-image or multi-image composition. Never copy base64 into arguments.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 16_000 },
          size: { type: "string", enum: ["1K", "2K", "3K", "4K"] },
          ratio: {
            type: "string",
            enum: ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"],
          },
          attachment_ids: {
            type: "array",
            maxItems: 5,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 256 },
          },
          image_urls: {
            type: "array",
            maxItems: 5,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 4_096 },
          },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    create_video: {
      name: "create_video",
      title: "Create video",
      description:
        "Create a text-to-video task with Agnes Video 2.5 Flash. This tool returns an asynchronous video ID; Open Builder updates its conversation placeholder while the originating conversation remains active.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 16_000 },
          seconds: { type: "integer", minimum: 4, maximum: 12 },
          aspect_ratio: {
            type: "string",
            enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
          },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    get_video_status: {
      name: "get_video_status",
      title: "Get video status",
      description:
        "Query an Agnes Video 2.5 Flash task once by video ID. When the task belongs to an existing conversation placeholder, Open Builder updates that original placeholder.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["video_id"],
        properties: {
          video_id: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
  };
