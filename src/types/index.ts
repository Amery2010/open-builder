import type { Message as _Message, ProjectFiles as _ProjectFiles } from "../lib/generator";

export type {
  ProjectFiles,
  ContentPart,
  Message,
  ToolCall,
  ToolDefinition,
  FileChange,
  GenerateResult,
  GeneratorOptions,
  GeneratorEvents,
} from "../lib/generator";

export type { AISettings, WebSearchSettings } from "../store/settings";
export type { OpenAIClientConfig } from "../lib/client";

// ─── Chat UI types ────────────────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  content: string;
  id: string;
}

export interface ImageBlock {
  type: "image";
  url: string;
  id: string;
}

export interface ThinkingBlock {
  type: "thinking";
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

export type Block = TextBlock | ImageBlock | ThinkingBlock | ToolBlock;

export interface MergedMessage {
  role: "user" | "assistant";
  blocks: Block[];
  id: string;
}

// ─── Conversation types ──────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  title: string;
  messages: _Message[];
  files: _ProjectFiles;
  template: string;
  isProjectInitialized: boolean;
  createdAt: number;
  updatedAt: number;
}
