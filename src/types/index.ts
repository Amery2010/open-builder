export type {
  ProjectFiles,
  Message,
  ToolCall,
  ToolDefinition,
  FileChange,
  GenerateResult,
  GeneratorOptions,
  GeneratorEvents,
} from "../lib/generator";

export type { AISettings } from "../lib/settings";
export type { OpenAIClientConfig } from "../lib/client";

// ─── Chat UI types ────────────────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  content: string;
  id: string;
}

export interface ToolBlock {
  type: "tool";
  toolName: string;
  title: string;
  path: string;
  paths?: string[];
  result: string;
  id: string;
}

export type Block = TextBlock | ToolBlock;

export interface MergedMessage {
  role: "user" | "assistant";
  blocks: Block[];
  id: string;
}
