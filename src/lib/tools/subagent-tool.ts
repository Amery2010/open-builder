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
  "Delegate a bounded development, read-only analysis, or research task to a specialized subagent and get back a single text result.\n\n" +
  "Available subagents:\n" +
  agentList +
  "\n\n" +
  "Use this to keep the main conversation context clean when you need to explore the codebase, review code, research dependencies, or diagnose runtime issues. " +
  "Multiple dispatch_subagent calls in the same turn are queued and run with up to 3 active at a time. " +
  "Only code-writer may create or edit the exact writePaths assigned by the parent. Other roles remain read-only. Shared configuration, dependencies, deletion and moves stay with the parent. Overlapping file scopes queue; successful edits merge atomically after conflict checks. " +
  "Subagents cannot dispatch further subagents.";

export const DISPATCH_SUBAGENT_TOOL: ToolSet = {
  dispatch_subagent: tool({
    description,
    inputSchema: z
      .object({
        writePaths: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Exact project-relative files owned by code-writer, including any new files. Required for code-writer; no globs.",
          ),
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
      })
      .superRefine((value, context) => {
        if (value.subagent === "code-writer" && !value.writePaths?.length)
          context.addIssue({
            code: "custom",
            path: ["writePaths"],
            message: "code-writer requires writePaths",
          });
        if (value.subagent !== "code-writer" && value.writePaths)
          context.addIssue({
            code: "custom",
            path: ["writePaths"],
            message: "Read-only roles cannot receive writePaths",
          });
      }),
  }),
};

export const DISPATCH_SUBAGENT_TOOL_NAME = "dispatch_subagent";
