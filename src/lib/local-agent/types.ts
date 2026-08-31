import type { LocalAgentProvider } from "./providers";

export type { LocalAgentProvider } from "./providers";
export type LocalAgentAvailability =
  "notFound" | "unsupported" | "needsSetup" | "ready" | "error";

export interface LocalAgentModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort?: string;
  efforts: string[];
}

export interface LocalAgentProbe {
  provider: LocalAgentProvider;
  availability: LocalAgentAvailability;
  path?: string;
  pathSource?: "override" | "path" | "common";
  version?: string;
  setupCommand: string;
  models: LocalAgentModel[];
  efforts: string[];
  capabilities: {
    sessions: boolean;
    reasoning: boolean;
    tools: boolean;
    nativeSearch: boolean;
  };
  message?: string;
}

export interface LocalToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LocalToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource";
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    };

export interface LocalToolResolution {
  text: string;
  isError?: boolean;
  structuredContent?: unknown;
  content?: LocalToolContent[];
}

export interface LocalAgentStartRequest {
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  systemPrompt: string;
  prompt: string;
  bootstrapContext?: string;
  sessionId?: string;
  tools: LocalToolSpec[];
  nativeSearch: boolean;
  maxToolCalls: number;
  mode: "chat" | "plan" | "auto_qa" | "subagent";
}

export type LocalAgentEvent =
  | { type: "status"; state: string; message?: string }
  | { type: "session"; sessionId: string; cliVersion: string }
  | { type: "textDelta"; delta: string }
  | { type: "reasoningDelta"; delta: string }
  | {
      type: "toolRequest";
      runId: string;
      callId: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "nativeTool";
      callId: string;
      name: string;
      phase: "started" | "completed";
      arguments?: unknown;
      result?: unknown;
    }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "done"; aborted: boolean; sessionId?: string };
