// ============================================================================
//  ai-tools.ts
//  Zod-based 工具定义 —— 使用 AI SDK tool() + Zod schema 定义所有内置工具
// ============================================================================

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { ASK_USER_QUESTION_CONTRACT } from "./ask-user-question-contract";
import { PLAN_OUTPUT_CONTRACT } from "./plan-mode";
import { SEARCH_TOOLS, WEB_READER_TOOL } from "../tools/search";
import { ASSET_SEARCH_TOOLS } from "../tools/asset-search";
import { NPM_SEARCH_TOOLS } from "../tools/npm-search";
import { MEMORY_TOOLS } from "../tools/memory";
import { DISPATCH_SUBAGENT_TOOL } from "../tools/subagent-tool";
import { INSTALL_COMPONENT_TOOL } from "../tools/install-component";
import { SCREENSHOT_TO_CODE_TOOL } from "../tools/screenshot-to-code";
import { APPLY_DESIGN_STYLE_TOOL } from "../tools/design-styles";
import { PROJECT_HEALTH_CHECK_TOOL } from "../tools/project-health-tool";
import { SUBMIT_DESIGN_REVIEW_TOOL } from "../design/review-tool";
import { SUBMIT_DESIGN_CONTRACT_TOOL } from "../design/run-contract-tool";
import { projectDesignSchema } from "../design/project-design";
import { BASE_SKILL_TOOLS, SCRIPT_SKILL_TOOL } from "../skills/tools";
import { HostToolCatalog, type HostToolRecord } from "./host-tool-catalog";
import { HOST_TOOL_DESCRIPTORS } from "./host-tool-catalog-data";
import { TOOL_POLICY_VERSION } from "./tool-policy-version";

export { TOOL_POLICY_VERSION };

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
      "vite-react-ts-prototype (Vite + React TypeScript multi-page prototype starter), " +
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
export type ToolRuntime = "api" | "local_cli";
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

export interface ToolRunContext {
  readonly runId: string;
  readonly conversationId?: string;
  readonly mode: ExecutionMode;
  readonly platform: RuntimePlatform;
  readonly runtime: ToolRuntime;
  readonly allowedMcpAliases: ReadonlySet<string>;
  readonly activeSkillIds: ReadonlySet<string>;
  readonly approvedSkillScriptHashes: ReadonlySet<string>;
  readonly policyVersion: string;
}

const EDITABLE_TOKEN_NAMES = [
  "--bg",
  "--surface",
  "--fg",
  "--muted",
  "--border",
  "--accent",
  "--accent-on",
  "--success",
  "--warn",
  "--danger",
  "--font-display",
  "--font-body",
  "--radius-md",
  "--section-y-desktop",
  "--container-max",
  "--motion-base",
] as const;

const previewViewportsSchema = z
  .array(z.enum(["desktop", "tablet", "mobile"]))
  .min(1)
  .max(3)
  .superRefine((viewports, context) => {
    if (new Set(viewports).size !== viewports.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Preview viewports must be unique.",
      });
    }
  });

export const DESIGN_DIAGNOSTIC_TOOLS = {
  inspect_design_consistency: tool({
    description:
      "Inspect Design-system state, semantic Token use, runtime Token resolution, and sampled component style variants. Omit viewports for a static-only inspection.",
    inputSchema: z
      .object({
        viewports: previewViewportsSchema.optional(),
      })
      .strict(),
  }),
  measure_preview_layout: tool({
    description:
      "Measure bounded layout evidence for explicit preview viewports, including document overflow, capture height, sampled off-canvas elements, and sampled control target sizes.",
    inputSchema: z.object({ viewports: previewViewportsSchema }).strict(),
  }),
  audit_accessibility_tree: tool({
    description:
      "Audit bounded DOM-derived accessibility evidence for explicit preview viewports. Reports labels, keyboard reachability, headings, landmarks, image alt state, and target size; it is not a WCAG conformance claim.",
    inputSchema: z.object({ viewports: previewViewportsSchema }).strict(),
  }),
  compare_preview_states: tool({
    description:
      "Compare current preview image digests and bounded metadata with a prior capture_preview_evidence result in this Conversation. Omit baseline_generation to use the latest baseline.",
    inputSchema: z
      .object({
        baseline_generation: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        viewports: previewViewportsSchema,
      })
      .strict(),
  }),
  trace_design_provenance: tool({
    description:
      "Trace the current Design-system selection and digest markers through the Token contract and static Token usage sites. Historical actors and runtime-element source mapping are not inferred.",
    inputSchema: z.object({}).strict(),
  }),
};

/** Definitions are exported so runtime adapters can attach an implementation
 * without re-declaring a parallel schema. */
export const DESIGN_HOST_TOOLS = {
  set_default_preview_view: tool({
    description:
      "Set the project's preferred preview device for future preview mounts. Use only when a project type clearly benefits from a tablet or mobile-first default.",
    inputSchema: z.object({
      view: z.enum(["desktop", "tablet", "mobile"]),
    }),
  }),
  update_design_tokens: tool({
    description:
      "Atomically update one or more editable semantic design tokens. Prefer this over directly editing tokens.css during an accepted Design run.",
    inputSchema: z.object({
      changes: z
        .array(
          z.object({
            token: z.enum(EDITABLE_TOKEN_NAMES),
            value: z.string(),
          }),
        )
        .min(1)
        .max(16)
        .superRefine((changes, context) => {
          const seen = new Set<string>();
          for (const change of changes) {
            if (seen.has(change.token)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Duplicate token "${change.token}".`,
              });
            }
            seen.add(change.token);
          }
        }),
    }),
  }),
  update_project_design: tool({
    description:
      "Validate and atomically write the root design-project.json blueprint. Provide the complete blueprint document, including a non-empty responsibility for every page. Provide expected_revision when updating an existing blueprint so stale writes fail closed.",
    inputSchema: z
      .object({
        document: projectDesignSchema,
        expected_revision: z
          .union([
            z.number().int().nonnegative(),
            z.string().trim().min(1).max(128),
          ])
          .optional(),
      })
      .strict(),
  }),
  capture_preview_evidence: tool({
    description:
      "Capture bounded screenshot and semantic evidence for explicitly selected preview viewports. For a complete prototype, provide a validated page, route, and scenario target from design-project.json.",
    inputSchema: z.object({
      viewports: previewViewportsSchema,
      target: z
        .object({
          pageId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
          route: z.string().trim().min(1).max(256),
          scenarioId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        })
        .strict()
        .optional(),
    }),
  }),
  ...DESIGN_DIAGNOSTIC_TOOLS,
};

export const STATIC_TOOL_DEFINITIONS: ToolSet = {
  ...BUILTIN_TOOLS,
  ...SEARCH_TOOLS,
  ...WEB_READER_TOOL,
  ...ASSET_SEARCH_TOOLS,
  ...NPM_SEARCH_TOOLS,
  ...MEMORY_TOOLS,
  ...DISPATCH_SUBAGENT_TOOL,
  ...INSTALL_COMPONENT_TOOL,
  ...SCREENSHOT_TO_CODE_TOOL,
  ...APPLY_DESIGN_STYLE_TOOL,
  ...PROJECT_HEALTH_CHECK_TOOL,
  ...SUBMIT_DESIGN_REVIEW_TOOL,
  ...SUBMIT_DESIGN_CONTRACT_TOOL,
  ...BASE_SKILL_TOOLS,
  ...SCRIPT_SKILL_TOOL,
  ...DESIGN_HOST_TOOLS,
};

function attachStaticDefinitions(
  descriptors: readonly HostToolRecord[],
  definitions: ToolSet,
): readonly HostToolRecord[] {
  return Object.freeze(
    descriptors.map((record) => {
      const definition = definitions[record.name];
      if (!definition && record.implementation.kind !== "provider") {
        throw new Error(
          `Missing executable definition for Host tool "${record.name}".`,
        );
      }
      return Object.freeze(
        definition ? { ...record, definition } : { ...record },
      );
    }),
  );
}

export const HOST_TOOL_RECORDS: readonly HostToolRecord[] =
  attachStaticDefinitions(HOST_TOOL_DESCRIPTORS, STATIC_TOOL_DEFINITIONS);

export type ToolCapability = HostToolRecord;

export const HOST_TOOL_CATALOG = new HostToolCatalog(HOST_TOOL_RECORDS);

export function getToolCapability(name: string): ToolCapability | undefined {
  return HOST_TOOL_CATALOG.get(name);
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
  providerOwnedNames = new Set(),
}: {
  custom: ToolSet;
  mode: ExecutionMode;
  platform: RuntimePlatform;
  allowedDynamicNames?: ReadonlySet<string>;
  profile?: ToolProfile;
  providerOwnedNames?: ReadonlySet<string>;
}): ToolSet {
  const requested: ToolSet = { ...BUILTIN_TOOLS };
  for (const [name, definition] of Object.entries(custom)) {
    if (
      name in BUILTIN_TOOLS &&
      (BUILTIN_TOOLS as ToolSet)[name] !== definition
    ) {
      throw new Error(
        `Host tool name collision for "${name}": custom tools cannot replace a builtin.`,
      );
    }
    requested[name] = definition;
  }
  return HOST_TOOL_CATALOG.openRun({
    tools: requested,
    context: Object.freeze({
      runId: "projection",
      mode,
      platform,
      runtime: "api",
      allowedMcpAliases: new Set(allowedDynamicNames),
      activeSkillIds: new Set<string>(),
      approvedSkillScriptHashes: new Set<string>(),
      policyVersion: TOOL_POLICY_VERSION,
    }),
    profile,
    allowedDynamicNames,
    providerOwnedNames,
  }).modelTools;
}

// Compatibility projections. They are derived from the Catalog rather than
// maintained as independent policy/name tables.
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(
  HOST_TOOL_RECORDS.filter((record) =>
    record.effects.some(
      (effect) => effect === "write_project" || effect === "process",
    ),
  ).map((record) => record.name),
);

export function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

export function isPlanModeToolVisible(name: string): boolean {
  const record = HOST_TOOL_CATALOG.get(name);
  return (
    (record?.modes.includes("plan") && record.profiles.includes("default")) ??
    false
  );
}

// Backward-compatible alias while callers migrate to WRITE_TOOL_NAMES.
export const BUILTIN_WRITE_TOOL_NAMES = WRITE_TOOL_NAMES;
