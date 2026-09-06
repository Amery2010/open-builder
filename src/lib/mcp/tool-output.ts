import type { ToolResultPart } from "ai";
import type {
  ToolExecutionContent,
  ToolExecutionOutput,
} from "../ai/generator-types";
import { createMcpToolAlias } from "./alias";
import type { McpToolResultSnapshot } from "./types";

function displayContent(
  snapshot: McpToolResultSnapshot,
): ToolExecutionContent[] {
  return snapshot.content.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
      case "audio":
        return part.data && !part.omitted
          ? { type: part.type, data: part.data, mimeType: part.mimeType }
          : {
              type: "placeholder",
              label: `${part.type} (${part.mimeType})`,
              reason: part.reason || "content omitted",
            };
      case "resource":
        return part.omitted
          ? {
              type: "placeholder",
              label: part.title || part.name || part.uri,
              reason: part.reason || "resource omitted",
            }
          : {
              type: "resource",
              uri: part.uri,
              mimeType: part.mimeType,
              text: part.text,
              blob: part.blob,
            };
      case "resource_link":
        return { ...part };
      case "unsupported":
        return {
          type: "placeholder",
          label: part.originalType,
          reason: part.reason,
        };
    }
  });
}

export function mcpToolExecutionOutputToModelOutput(
  output: ToolExecutionOutput,
): ToolResultPart["output"] {
  const value: Extract<ToolResultPart["output"], { type: "content" }>["value"] =
    [];

  for (const part of output.content ?? []) {
    switch (part.type) {
      case "text":
        value.push({ type: "text", text: part.text });
        break;
      case "image":
      case "audio":
        value.push({
          type: "file",
          data: { type: "data", data: part.data },
          mediaType: part.mimeType,
        });
        break;
      case "resource":
        if (part.text) {
          value.push({
            type: "file",
            data: { type: "text", text: part.text },
            mediaType: part.mimeType || "text/plain",
          });
        } else if (part.blob) {
          value.push({
            type: "file",
            data: { type: "data", data: part.blob },
            mediaType: part.mimeType || "application/octet-stream",
          });
        } else {
          value.push({
            type: "text",
            text: `[Embedded resource ${part.uri} is empty]`,
          });
        }
        break;
      case "resource_link":
        value.push({
          type: "text",
          text: `[MCP resource link: ${part.name} <${part.uri}>; not fetched]`,
        });
        break;
      case "local_image":
        value.push({
          type: "text",
          text: `[Local generated image: ${part.name}; reference id ${part.id}]`,
        });
        break;
      case "placeholder":
        value.push({
          type: "text",
          text: `[${part.label}: ${part.reason}]`,
        });
        break;
    }
  }
  if (output.structuredContent !== undefined) {
    value.push({
      type: "text",
      text: `[Structured content]\n${JSON.stringify(output.structuredContent, null, 2)}`,
    });
  }
  return value.length
    ? { type: "content", value }
    : output.isError
      ? { type: "error-text", value: output.text }
      : { type: "text", value: output.text };
}

export function mcpSnapshotToToolExecutionOutput(
  snapshot: McpToolResultSnapshot,
  identity: {
    serverId: string;
    serverName: string;
    toolName: string;
    toolTitle?: string;
  },
): ToolExecutionOutput {
  return {
    text: snapshot.modelText,
    isError: snapshot.isError,
    structuredContent: snapshot.structuredContent,
    content: displayContent(snapshot),
    source: {
      kind: "mcp",
      ...identity,
      alias: createMcpToolAlias(identity.serverId, identity.toolName),
    },
  };
}
