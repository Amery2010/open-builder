import type { AISettings } from "../../../store/settings";

/** A built-in subagent definition. Hardcoded in the registry. */
export interface SubagentDefinition {
  /** Stable identifier the main agent uses to dispatch this subagent. */
  name: string;
  /** Short description surfaced to the main agent in the tool description. */
  description: string;
  /** Inner-loop system prompt that scopes the subagent's behavior. */
  systemPrompt: string;
  /** Whitelist of tool names the subagent is allowed to invoke. */
  toolWhitelist: string[];
  /** Optional per-subagent provider/model override. Undefined inherits the main agent. */
  modelOverride?: Partial<AISettings>;
  /** Optional explicit inner-loop limit. Undefined allows the subagent to finish naturally. */
  maxIterations?: number;
  /** Truncate the subagent text result to this many chars before returning (default 4000). */
  maxResultLength?: number;
  /** Whether the subagent can modify project files. Defaults to "readonly":
   *  write tools are stripped from the whitelist and any attempt to call them
   *  is rejected at the tool-handler layer. "fullWrite" subagents may modify
   *  files; the resulting file map is written back to the parent. */
  writePolicy?: "readonly" | "fullWrite";
}

/** A single inner-tool call captured for the UI. */
export interface SubagentEvent {
  /** Inner tool name. */
  name: string;
  /** Inner tool call id (unique within the subagent run). */
  toolCallId: string;
  /** Brief preview of the tool result (truncated). Empty while pending. */
  resultPreview: string;
}

/** Status of a subagent invocation. */
export type SubagentStatus = "running" | "done" | "failed" | "aborted";

/** JSON-serializable result returned by the dispatch_subagent tool — persisted in messages. */
export interface SubagentToolResult {
  ok: boolean;
  subagent: string;
  task: string;
  status: SubagentStatus;
  /** Final assistant text from the inner loop (truncated). */
  text: string;
  /** Captured tool call events for replay in the UI. */
  events: SubagentEvent[];
  durationMs: number;
  /** Error message when status is "failed". */
  error?: string;
}

/** Live progress entry held in the ephemeral subagent store. */
export interface SubagentProgress {
  subagent: string;
  task: string;
  status: SubagentStatus;
  text: string;
  events: SubagentEvent[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
