// ============================================================================
//  ai-tools.ts
//  Zod-based 工具定义 —— 使用 AI SDK tool() + Zod schema 定义所有内置工具
// ============================================================================

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { ASK_USER_QUESTION_CONTRACT } from "./ask-user-question-contract";
import { PLAN_OUTPUT_CONTRACT } from "./plan-mode";

export { TOOL_POLICY_VERSION } from "./tool-policy-version";

/**
 * 内置工具定义（Zod 格式）
 * 这些工具的执行逻辑仍在 generator.ts 的 executeTool 中，
 * 这里只定义 schema，不提供 execute 回调。
 */
export const BUILTIN_TOOLS = {
  init_project: tool({
    description:
      "Initialize the project with a Sandpack template. Call this FIRST when starting a new project. " +
      "Available templates: " +
      "static (plain HTML/CSS/JS), " +
      "vanilla (vanilla JS with bundler), " +
      "vanilla-ts (vanilla TypeScript), " +
      "react (React with JavaScript), " +
      "react-ts (React with TypeScript, DEFAULT), " +
      "vue (Vue 3 with JavaScript), " +
      "vue-ts (Vue 3 with TypeScript), " +
      "svelte (Svelte with JavaScript), " +
      "angular (Angular with TypeScript), " +
      "solid (SolidJS with TypeScript), " +
      "node (Node.js), " +
      "nextjs (Next.js), " +
      "vite (Vite vanilla), " +
      "vite-react (Vite + React JS), " +
      "vite-react-ts (Vite + React TypeScript), " +
      "vite-preact (Vite + Preact JS), " +
      "vite-preact-ts (Vite + Preact TypeScript), " +
      "vite-vue (Vite + Vue JS), " +
      "vite-vue-ts (Vite + Vue TypeScript), " +
      "vite-svelte (Vite + Svelte JS), " +
      "vite-svelte-ts (Vite + Svelte TypeScript), " +
      "astro (Astro), " +
      "test-ts (TypeScript test runner).",
    inputSchema: z.object({
      template: z.string().describe("Template name from the available list"),
    }),
  }),

  manage_dependencies: tool({
    description:
      "Add, remove, or update project dependencies by modifying package.json. " +
      "This triggers a full project restart to install the new dependencies. " +
      "Open Builder automatically preserves the current template's Sandpack/Nodebox-critical build dependencies, including verified Vite/esbuild-wasm and framework compiler pairings. " +
      "Provide the complete updated package.json content.",
    inputSchema: z.object({
      package_json: z
        .string()
        .describe("The complete package.json content to write"),
    }),
  }),

  list_files: tool({
    description:
      "List all file paths currently in the project. Returns one path per line, or '(empty)' if no files exist.",
    inputSchema: z.object({}),
  }),

  read_files: tool({
    description:
      "Read and return the full content of multiple files at once. Always prefer this over calling read_file multiple times.",
    inputSchema: z.object({
      paths: z
        .array(z.string())
        .describe("List of file paths relative to project root"),
    }),
  }),

  write_file: tool({
    description:
      "Create a new file or completely overwrite an existing file with the provided content.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to project root"),
      content: z.string().describe("The complete file content to write"),
    }),
  }),

  patch_file: tool({
    description:
      "Apply one or more search-and-replace patches to an existing file. " +
      "Each patch replaces the FIRST occurrence of the search string. " +
      "Include enough surrounding context in 'search' to ensure uniqueness.",
    inputSchema: z.object({
      path: z.string().describe("File path to patch"),
      patches: z
        .array(
          z.object({
            search: z
              .string()
              .describe("Exact text to find (must be unique in the file)"),
            replace: z.string().describe("Text to replace the match with"),
          }),
        )
        .describe("Ordered list of search-and-replace operations"),
    }),
  }),

  search_in_files: tool({
    description: "Search for a regex pattern across all project files",
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern"),
    }),
  }),

  delete_file: tool({
    description: "Delete a file from the project.",
    inputSchema: z.object({
      path: z.string().describe("File path to delete"),
    }),
  }),

  rename_file: tool({
    description:
      "Rename or move a file (or directory prefix) to a new path. " +
      "ALWAYS auto-updates relative-path import references (./, ../) across " +
      ".ts/.tsx/.js/.jsx/.mjs/.cjs/.vue/.svelte/.css/.scss files, so callers do not need " +
      "to follow up with patch_file to fix imports. Path-alias imports (e.g. '@/foo') are NOT updated yet. " +
      "Use this instead of write_file + delete_file when changing a file's location.",
    inputSchema: z.object({
      old_path: z
        .string()
        .describe("Current file path relative to project root"),
      new_path: z.string().describe("New file path relative to project root"),
    }),
  }),

  move_file: tool({
    description:
      "Move a file into another directory, preserving its file name. " +
      "Auto-updates relative-path import references just like rename_file.",
    inputSchema: z.object({
      path: z.string().describe("Source file path"),
      target_dir: z
        .string()
        .describe("Target directory (empty string = project root)"),
    }),
  }),

  read_env_schema: tool({
    description:
      "Inspect the project's environment variable schema. " +
      "Returns the keys declared in .env.example, whether each is set in .env, " +
      "and whether it is public (VITE_*) or private. Values are NOT returned for safety.",
    inputSchema: z.object({}),
  }),

  manage_env: tool({
    description:
      "Read/write the project's .env and .env.example. " +
      "Use this instead of write_file when touching env files — it parses lines safely, " +
      "preserves existing keys, and (by default) auto-generates a typed src/env.ts " +
      "with a Zod schema so the project gets type-safe env access. " +
      "Mark public keys with the VITE_ prefix (vite convention).",
    inputSchema: z.object({
      operations: z
        .array(
          z.object({
            target: z
              .enum(["env", "example"])
              .describe(
                '"env" writes to .env; "example" writes to .env.example',
              ),
            action: z.enum(["set", "unset"]),
            key: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
              .describe("Variable name, e.g. DATABASE_URL"),
            value: z
              .string()
              .max(64 * 1024)
              .optional()
              .describe('Value for "set" actions; ignored for "unset"'),
          }),
        )
        .min(1)
        .max(100)
        .describe("Ordered list of env operations to apply"),
      generate_typed_env: z
        .boolean()
        .optional()
        .describe(
          "Auto-generate src/env.ts (Zod schema + type) after applying ops. Default: true.",
        ),
    }),
  }),

  get_console_logs: tool({
    description:
      "Get the browser console output from the running Sandpack preview. " +
      "Use this after finishing code changes to check for runtime errors, warnings, or syntax errors. " +
      "If errors are found, fix them immediately.",
    inputSchema: z.object({}),
  }),

  compact_context: tool({
    description:
      "Compress the conversation context to reduce token usage. " +
      "Call this when the conversation is getting long and you sense the context may be approaching limits, " +
      "or when earlier messages contain verbose content no longer needed in full detail. " +
      "This summarizes older messages while preserving key information.",
    inputSchema: z.object({}),
  }),

  ask_user_question: tool({
    description:
      "Ask the user 1-4 questions for genuine clarification or a structured stress-test interview. " +
      "Each question must offer 2-4 distinct options; the user can also type a free-text 'Other' answer. " +
      "Do not use this tool for filler confirmations.\n\n" +
      ASK_USER_QUESTION_CONTRACT,
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z
              .string()
              .describe(
                "The full question text the user will read. Should end with '?'.",
              ),
            header: z
              .string()
              .describe(
                "Short tag/label shown on the question card (<=12 chars), e.g. 'Auth method'.",
              ),
            multiSelect: z
              .boolean()
              .describe(
                "If true the user may pick more than one option. Default false.",
              ),
            options: z
              .array(
                z.object({
                  label: z
                    .string()
                    .describe("Short option title (1-5 words) the user picks."),
                  description: z
                    .string()
                    .describe(
                      "One sentence explaining what choosing this option means.",
                    ),
                }),
              )
              .min(2)
              .max(4)
              .describe("2-4 mutually exclusive option choices."),
          }),
        )
        .min(1)
        .max(4)
        .describe("List of 1-4 questions to ask the user in one batch."),
    }),
  }),

  exit_plan_mode: tool({
    description:
      "Present the implementation plan to the user for approval. " +
      "Call this as the FINAL step of planning, only after you have thoroughly explored " +
      "the existing project (list_files / read_files / search_in_files) and resolved " +
      "any ambiguity (ask_user_question if needed). " +
      PLAN_OUTPUT_CONTRACT +
      " " +
      "When this tool returns 'approved', proceed to implementation in the next provider iteration. " +
      "When it returns 'rejected', revise based on the user's feedback and call exit_plan_mode again. " +
      "Do NOT output the plan as a normal text reply - it MUST be delivered via this tool.",
    inputSchema: z.object({
      plan: z
        .string()
        .describe(
          `The complete implementation plan in Markdown. ${PLAN_OUTPUT_CONTRACT}`,
        ),
    }),
  }),
};

export type RuntimePlatform = "web" | "desktop" | "mobile";
export type ExecutionMode = "chat" | "plan" | "auto_qa" | "subagent";
export type ToolProfile = "default" | "design" | "design_review";
export type ToolSource =
  "builtin" | "project" | "network" | "mcp" | "skill" | "registry";
export type ToolEffect =
  | "read_project"
  | "write_project"
  | "read_runtime"
  | "write_runtime"
  | "network"
  | "process"
  | "conversation";
export type ToolApproval = "none" | "session" | "per_call";

/**
 * The single policy record used by both tool presentation and execution.
 * Dynamic MCP entries are evaluated by the MCP runtime, but must still be
 * present in the current run's immutable alias allowlist.
 */
export interface ToolCapability {
  readonly name: string;
  readonly source: ToolSource;
  readonly effects: readonly ToolEffect[];
  readonly platforms: readonly RuntimePlatform[];
  readonly modes: readonly ExecutionMode[];
  readonly approval: ToolApproval;
}

export interface ToolRunContext {
  readonly runId: string;
  readonly conversationId?: string;
  readonly mode: ExecutionMode;
  readonly platform: RuntimePlatform;
  readonly allowedMcpAliases: ReadonlySet<string>;
  readonly activeSkillIds: ReadonlySet<string>;
  readonly approvedSkillScriptHashes: ReadonlySet<string>;
  readonly policyVersion: string;
}

/** Compatibility projection for older callers while they migrate. */
export interface ToolPolicy {
  readonly name: string;
  readonly access: "read" | "write";
  readonly planModeVisible: boolean;
  readonly subagentVisible: boolean;
}

// Tool names that mutate project files or generated project state. This covers
// both BUILTIN_TOOLS and custom tools registered by handler-factory.
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "init_project",
  "manage_dependencies",
  "write_file",
  "patch_file",
  "delete_file",
  "rename_file",
  "move_file",
  "manage_env",
  "install_component",
  "screenshot_to_code",
  "apply_design_style",
  "apply_design_system",
  "execute_skill_script",
]);

export const READONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_files",
  "read_files",
  "search_in_files",
  "read_env_schema",
  "get_console_logs",
  "compact_context",
  "ask_user_question",
  "exit_plan_mode",
  "dispatch_subagent",
  "web_search",
  "web_search_preview",
  "google_search",
  "web_reader",
  "image_search",
  "search_npm_packages",
  "get_npm_package_detail",
  "list_skills",
  "read_skill",
  "memory",
  "project_health_check",
  "submit_design_review",
]);

const ALL_PLATFORMS = ["web", "desktop", "mobile"] as const;
const ALL_READ_MODES = ["chat", "plan", "auto_qa", "subagent"] as const;
const CHAT_ONLY = ["chat"] as const;
const CHAT_AND_PLAN = ["chat", "plan"] as const;

function capability(
  name: string,
  source: ToolSource,
  effects: readonly ToolEffect[],
  modes: readonly ExecutionMode[],
  options: {
    platforms?: readonly RuntimePlatform[];
    approval?: ToolApproval;
  } = {},
): ToolCapability {
  return Object.freeze({
    name,
    source,
    effects,
    modes,
    platforms: options.platforms ?? ALL_PLATFORMS,
    approval: options.approval ?? "none",
  });
}

const STATIC_CAPABILITIES: ToolCapability[] = [
  capability("init_project", "project", ["write_project"], CHAT_ONLY),
  capability("manage_dependencies", "project", ["write_project"], CHAT_ONLY),
  capability("list_files", "project", ["read_project"], ALL_READ_MODES),
  capability("read_files", "project", ["read_project"], ALL_READ_MODES),
  capability("write_file", "project", ["write_project"], ["chat", "auto_qa"]),
  capability("patch_file", "project", ["write_project"], ["chat", "auto_qa"]),
  capability("search_in_files", "project", ["read_project"], ALL_READ_MODES),
  capability("delete_file", "project", ["write_project"], CHAT_ONLY),
  capability("rename_file", "project", ["write_project"], CHAT_ONLY),
  capability("move_file", "project", ["write_project"], CHAT_ONLY),
  capability("read_env_schema", "project", ["read_project"], CHAT_AND_PLAN),
  capability("manage_env", "project", ["write_project"], CHAT_ONLY),
  capability("get_console_logs", "builtin", ["read_runtime"], CHAT_ONLY),
  capability("compact_context", "builtin", ["conversation"], CHAT_AND_PLAN),
  capability("ask_user_question", "builtin", ["conversation"], CHAT_AND_PLAN),
  capability("exit_plan_mode", "builtin", ["conversation"], ["plan"]),
  capability("dispatch_subagent", "builtin", ["conversation"], CHAT_AND_PLAN),
  capability("web_search", "network", ["network"], CHAT_AND_PLAN),
  capability("web_search_preview", "network", ["network"], CHAT_AND_PLAN),
  capability("google_search", "network", ["network"], CHAT_AND_PLAN),
  capability("web_reader", "network", ["network"], CHAT_AND_PLAN),
  capability("image_search", "network", ["network"], CHAT_ONLY),
  capability("search_npm_packages", "network", ["network"], CHAT_AND_PLAN),
  capability("get_npm_package_detail", "network", ["network"], CHAT_AND_PLAN),
  capability("list_skills", "skill", ["read_runtime"], CHAT_AND_PLAN),
  capability("read_skill", "skill", ["read_runtime"], CHAT_AND_PLAN),
  capability(
    "execute_skill_script",
    "skill",
    ["process", "read_runtime"],
    CHAT_ONLY,
    { platforms: ["desktop"], approval: "per_call" },
  ),
  capability("memory", "builtin", ["read_runtime"], CHAT_ONLY),
  capability(
    "project_health_check",
    "project",
    ["read_project", "read_runtime"],
    ALL_READ_MODES,
  ),
  capability(
    "install_component",
    "registry",
    ["network", "write_project"],
    CHAT_ONLY,
  ),
  capability(
    "screenshot_to_code",
    "network",
    ["network", "write_project"],
    CHAT_ONLY,
  ),
  capability(
    "apply_design_style",
    "registry",
    ["network", "write_project"],
    CHAT_ONLY,
  ),
  capability("apply_design_system", "registry", ["write_project"], CHAT_ONLY),
  capability("submit_design_review", "builtin", ["conversation"], CHAT_ONLY),
];

const DESIGN_REVIEW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_files",
  "read_files",
  "search_in_files",
  "submit_design_review",
]);

function isToolAllowedInProfile(
  name: string,
  profile: ToolProfile,
  allowDesignSystemApply: boolean,
): boolean {
  if (profile === "design_review") return DESIGN_REVIEW_TOOL_NAMES.has(name);
  if (name === "submit_design_review") return false;
  if (name === "apply_design_system") {
    return profile === "design" && allowDesignSystemApply;
  }
  if (name === "apply_design_style") return profile !== "design";
  return true;
}

export const TOOL_CAPABILITY_REGISTRY: Readonly<
  Record<string, ToolCapability>
> = Object.freeze(
  Object.fromEntries(STATIC_CAPABILITIES.map((entry) => [entry.name, entry])),
);

export function getToolCapability(name: string): ToolCapability | undefined {
  return TOOL_CAPABILITY_REGISTRY[name];
}

export function isToolAllowedInMode(
  name: string,
  mode: ExecutionMode,
  platform: RuntimePlatform = "web",
): boolean {
  const entry = getToolCapability(name);
  return !!entry?.modes.includes(mode) && entry.platforms.includes(platform);
}

/**
 * Project the complete tool schema for one immutable generator run.
 * Unknown dynamic tools are included only when their MCP alias was copied into
 * this run's allowlist; registered tools must satisfy both mode and platform.
 */
export function buildToolSetForRun({
  custom,
  mode,
  platform,
  allowedDynamicNames = new Set(),
  profile = "default",
  allowDesignSystemApply = false,
}: {
  custom: ToolSet;
  mode: ExecutionMode;
  platform: RuntimePlatform;
  allowedDynamicNames?: ReadonlySet<string>;
  profile?: ToolProfile;
  allowDesignSystemApply?: boolean;
}): ToolSet {
  const isAllowed = (name: string) =>
    isToolAllowedInProfile(name, profile, allowDesignSystemApply) &&
    (isToolAllowedInMode(name, mode, platform) ||
      (!getToolCapability(name) &&
        profile !== "design_review" &&
        allowedDynamicNames.has(name)));

  return Object.fromEntries(
    Object.entries({ ...BUILTIN_TOOLS, ...custom }).filter(([name]) =>
      isAllowed(name),
    ),
  );
}

export const TOOL_POLICIES: Record<string, ToolPolicy> = Object.fromEntries(
  Object.values(TOOL_CAPABILITY_REGISTRY).map((entry) => [
    entry.name,
    {
      name: entry.name,
      access: entry.effects.some((effect) => effect.startsWith("write_"))
        ? "write"
        : "read",
      planModeVisible: entry.modes.includes("plan"),
      subagentVisible: entry.modes.includes("subagent"),
    } satisfies ToolPolicy,
  ]),
);

export function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

export function isPlanModeToolVisible(name: string): boolean {
  return TOOL_CAPABILITY_REGISTRY[name]?.modes.includes("plan") ?? false;
}

// Backward-compatible alias while callers migrate to WRITE_TOOL_NAMES.
export const BUILTIN_WRITE_TOOL_NAMES = WRITE_TOOL_NAMES;
