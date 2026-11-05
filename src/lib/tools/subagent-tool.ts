import { tool } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";
import { SUBAGENT_REGISTRY } from "../ai/subagents/registry";
import { SUBAGENT_LIMITS } from "../ai/subagents/limits";

const agentList = SUBAGENT_REGISTRY.map(
  (a) => `- "${a.name}": ${a.description}`,
).join("\n");

const SUBAGENT_NAMES = SUBAGENT_REGISTRY.map((a) => a.name) as [
  string,
  ...string[],
];

const description =
  "Delegate a read-only analysis or research task to a specialized subagent and get back a single text result.\n\n" +
  "Available subagents:\n" +
  agentList +
  "\n\n" +
  "Use this to keep the main conversation context clean when you need to explore the codebase, review code, research dependencies, or diagnose runtime issues. " +
  "Multiple dispatch_subagent calls in the same turn are queued and run with up to 3 active at a time. " +
  "Subagents are strictly READ-ONLY — they cannot create, modify, or delete project files. " +
  "Subagents cannot dispatch further subagents.";

export const DISPATCH_SUBAGENT_TOOL: ToolSet = {
  dispatch_subagent: tool({
    description,
    inputSchema: z.object({
      subagent: z
        .enum(SUBAGENT_NAMES)
        .describe(
          "Name of the subagent to invoke. Must exactly match one of the listed names.",
        ),
      task: z
        .string()
        .max(SUBAGENT_LIMITS.maxTaskChars)
        .describe(
          "Detailed task description for the subagent. Be specific about which files, questions, or goals it should address. The subagent only sees this task — it has no other knowledge of the conversation.",
        ),
    }),
  }),
};

export const DISPATCH_SUBAGENT_TOOL_NAME = "dispatch_subagent";
