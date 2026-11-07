import { resolveProjectPermissionImpact } from "../tools/fs-tools";
import type {
  ExecutionMode,
  RuntimePlatform,
  ToolApproval,
  ToolEffect,
  ToolProfile,
  ToolSource,
} from "./tools-schema";
import type {
  HostToolProjectPermission,
  HostToolRecord,
} from "./host-tool-catalog";

const ALL_PLATFORMS = ["web", "desktop", "mobile"] as const;
const ALL_READ_MODES = ["chat", "plan", "auto_qa", "subagent"] as const;
const CHAT_ONLY = ["chat"] as const;
const CHAT_AND_PLAN = ["chat", "plan"] as const;
const STANDARD_PROFILES = ["default", "design"] as const;

const TOOL_ZH_NAMES: Readonly<Record<string, string>> = Object.freeze({
  init_project: "初始化项目",
  manage_dependencies: "管理依赖",
  list_files: "列出文件",
  read_files: "读取文件",
  write_file: "写入文件",
  patch_file: "修改文件",
  search_in_files: "搜索文件",
  delete_file: "删除文件",
  rename_file: "重命名文件",
  move_file: "移动文件",
  read_env_schema: "读取环境变量结构",
  manage_env: "管理环境变量",
  get_console_logs: "读取控制台日志",
  compact_context: "压缩上下文",
  ask_user_question: "询问用户",
  exit_plan_mode: "提交计划",
  dispatch_subagent: "委派子代理",
  web_search: "网页搜索",
  web_search_preview: "网页搜索",
  google_search: "谷歌搜索",
  web_reader: "读取网页",
  image_search: "图片搜索",
  search_npm_packages: "搜索 NPM 包",
  get_npm_package_detail: "读取 NPM 包信息",
  list_skills: "列出技能",
  read_skill: "读取技能",
  execute_skill_script: "执行技能脚本",
  manage_memories: "管理记忆",
  project_health_check: "项目健康检查",
  install_component: "安装组件",
  screenshot_to_code: "截图转代码",
  apply_design_style: "应用设计风格",
  submit_design_review: "提交设计审查",
  set_default_preview_view: "设置默认预览视图",
  update_design_tokens: "更新设计令牌",
  update_project_design: "更新项目设计蓝图",
  capture_preview_evidence: "捕获预览证据",
  capture_preview_sequence: "连续捕捉当前预览",
  inspect_design_consistency: "检查设计一致性",
  measure_preview_layout: "测量预览布局",
  audit_accessibility_tree: "审计无障碍语义树",
  compare_preview_states: "比较预览状态",
  trace_design_provenance: "追踪设计来源",
});

const TOOL_ICON_KEYS: Readonly<Record<string, string>> = Object.freeze({
  list_files: "folder-open",
  read_files: "files",
  write_file: "file-pen",
  patch_file: "patch",
  delete_file: "delete",
  search_in_files: "project-search",
  web_search: "web-search",
  web_search_preview: "web-search",
  google_search: "web-search",
  web_reader: "web-reader",
  image_search: "image-search",
  search_npm_packages: "package",
  get_npm_package_detail: "package",
  get_console_logs: "terminal",
  list_skills: "skill",
  read_skill: "skill",
  execute_skill_script: "skill-run",
  rename_file: "file-move",
  move_file: "file-move",
  install_component: "component",
  screenshot_to_code: "screenshot",
  apply_design_style: "design-style",
  submit_design_review: "design",
  set_default_preview_view: "preview",
  update_design_tokens: "design",
  update_project_design: "design-contract",
  capture_preview_evidence: "evidence",
  capture_preview_sequence: "evidence",
  inspect_design_consistency: "design",
  measure_preview_layout: "preview",
  audit_accessibility_tree: "accessibility",
  compare_preview_states: "evidence",
  trace_design_provenance: "design-contract",
  read_env_schema: "env-read",
  manage_env: "env-write",
});

function englishName(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

interface RecordOptions {
  profiles?: readonly ToolProfile[];
  platforms?: readonly RuntimePlatform[];
  approval?: ToolApproval;
  retention?: HostToolRecord["outputRetention"];
  providerOwned?: boolean;
  providerAlternative?: boolean;
  iconKey?: string;
  projectPermission?: HostToolProjectPermission;
}

function hostRecord(
  name: string,
  source: ToolSource,
  effects: readonly ToolEffect[],
  modes: readonly ExecutionMode[],
  options: RecordOptions = {},
): HostToolRecord {
  const writes = effects.some(
    (effect) =>
      effect === "write_project" ||
      effect === "write_runtime" ||
      effect === "process",
  );
  return Object.freeze({
    name,
    source,
    effects,
    modes,
    profiles: options.profiles ?? STANDARD_PROFILES,
    platforms: options.platforms ?? ALL_PLATFORMS,
    approval: options.approval ?? (writes ? "session" : "none"),
    outputRetention: options.retention ?? "full",
    presentation: Object.freeze({
      name: Object.freeze({
        en: englishName(name),
        zh: TOOL_ZH_NAMES[name] ?? name,
      }),
      iconKey: options.iconKey ?? TOOL_ICON_KEYS[name] ?? source,
      // Retain the catalog field for compatibility; card titles no longer
      // derive any text from tool arguments.
      summarizeArguments: () => "",
    }),
    implementation: Object.freeze(
      options.providerOwned
        ? { kind: "provider" as const }
        : {
            kind: "host" as const,
            key: name,
            ...(options.providerAlternative
              ? { providerAlternative: true }
              : {}),
          },
    ),
    projectPermission: options.projectPermission,
  });
}

/**
 * Light, declarative Host Tool authority shared by presentation and runtime.
 * Runtime schema definitions are attached by tools-schema.ts after its
 * executable AI tool modules have loaded.
 */
export const HOST_TOOL_DESCRIPTORS: readonly HostToolRecord[] = Object.freeze([
  hostRecord("init_project", "project", ["write_project"], CHAT_ONLY, {
    projectPermission: {
      operation: "replace_project",
      sessionEligible: false,
      resolve: (input, files) =>
        resolveProjectPermissionImpact("init_project", input, files),
    },
  }),
  hostRecord("manage_dependencies", "project", ["write_project"], CHAT_ONLY),
  hostRecord("list_files", "project", ["read_project"], ALL_READ_MODES, {
    profiles: ["default", "design", "design_review"],
  }),
  hostRecord("read_files", "project", ["read_project"], ALL_READ_MODES, {
    profiles: ["default", "design", "design_review"],
  }),
  hostRecord(
    "write_file",
    "project",
    ["write_project"],
    ["chat", "auto_qa", "subagent"],
  ),
  hostRecord(
    "patch_file",
    "project",
    ["write_project"],
    ["chat", "auto_qa", "subagent"],
  ),
  hostRecord("search_in_files", "project", ["read_project"], ALL_READ_MODES, {
    profiles: ["default", "design", "design_review"],
  }),
  hostRecord("delete_file", "project", ["write_project"], CHAT_ONLY, {
    projectPermission: {
      operation: "delete",
      sessionEligible: true,
      resolve: (input, files) =>
        resolveProjectPermissionImpact("delete_file", input, files),
    },
  }),
  hostRecord("rename_file", "project", ["write_project"], CHAT_ONLY, {
    projectPermission: {
      operation: "move",
      sessionEligible: true,
      resolve: (input, files) =>
        resolveProjectPermissionImpact("rename_file", input, files),
    },
  }),
  hostRecord("move_file", "project", ["write_project"], CHAT_ONLY, {
    projectPermission: {
      operation: "move",
      sessionEligible: true,
      resolve: (input, files) =>
        resolveProjectPermissionImpact("move_file", input, files),
    },
  }),
  hostRecord("read_env_schema", "project", ["read_project"], CHAT_AND_PLAN),
  hostRecord("manage_env", "project", ["write_project"], CHAT_ONLY),
  hostRecord("get_console_logs", "builtin", ["read_runtime"], CHAT_ONLY),
  hostRecord("compact_context", "builtin", ["conversation"], CHAT_AND_PLAN),
  hostRecord("ask_user_question", "builtin", ["conversation"], CHAT_AND_PLAN),
  hostRecord("exit_plan_mode", "builtin", ["conversation"], ["plan"]),
  hostRecord("dispatch_subagent", "builtin", ["conversation"], CHAT_AND_PLAN),
  hostRecord(
    "capture_preview_sequence",
    "builtin",
    ["read_runtime"],
    CHAT_AND_PLAN,
    {
      retention: "summary-only",
      approval: "none",
    },
  ),
  hostRecord("web_search", "network", ["network"], CHAT_AND_PLAN, {
    providerAlternative: true,
  }),
  hostRecord("web_search_preview", "network", ["network"], CHAT_AND_PLAN, {
    providerOwned: true,
    retention: "full",
  }),
  hostRecord("google_search", "network", ["network"], CHAT_AND_PLAN, {
    providerOwned: true,
    retention: "full",
  }),
  hostRecord("web_reader", "network", ["network"], CHAT_AND_PLAN),
  hostRecord("image_search", "network", ["network"], CHAT_ONLY),
  hostRecord("search_npm_packages", "network", ["network"], CHAT_AND_PLAN),
  hostRecord("get_npm_package_detail", "network", ["network"], CHAT_AND_PLAN),
  hostRecord("list_skills", "skill", ["read_runtime"], CHAT_AND_PLAN),
  hostRecord("read_skill", "skill", ["read_runtime"], CHAT_AND_PLAN),
  hostRecord(
    "execute_skill_script",
    "skill",
    ["process", "read_runtime"],
    CHAT_ONLY,
    { platforms: ["desktop"], approval: "per_call" },
  ),
  hostRecord(
    "manage_memories",
    "builtin",
    ["read_runtime", "write_runtime"],
    CHAT_ONLY,
  ),
  hostRecord(
    "project_health_check",
    "project",
    ["read_project", "read_runtime"],
    ALL_READ_MODES,
  ),
  hostRecord(
    "install_component",
    "registry",
    ["network", "write_project"],
    CHAT_ONLY,
  ),
  hostRecord(
    "screenshot_to_code",
    "network",
    ["network", "write_project"],
    CHAT_ONLY,
  ),
  hostRecord(
    "apply_design_style",
    "registry",
    ["network", "write_project"],
    CHAT_ONLY,
    { profiles: ["default"] },
  ),
  hostRecord("submit_design_review", "builtin", ["conversation"], CHAT_ONLY, {
    profiles: ["design_review"],
  }),
  hostRecord(
    "set_default_preview_view",
    "project",
    ["write_runtime", "conversation"],
    CHAT_ONLY,
  ),
  hostRecord(
    "update_design_tokens",
    "project",
    ["write_project", "conversation"],
    CHAT_ONLY,
    { profiles: ["design"], retention: "summary-only" },
  ),
  hostRecord(
    "update_project_design",
    "project",
    ["write_project", "conversation"],
    CHAT_ONLY,
    { profiles: ["design"], retention: "summary-only" },
  ),
  hostRecord(
    "capture_preview_evidence",
    "builtin",
    ["read_runtime"],
    CHAT_ONLY,
    { profiles: ["design"], retention: "summary-only" },
  ),
  hostRecord(
    "inspect_design_consistency",
    "project",
    ["read_project", "read_runtime"],
    CHAT_ONLY,
    { profiles: ["design"], retention: "summary-only" },
  ),
  hostRecord(
    "measure_preview_layout",
    "builtin",
    ["read_project", "read_runtime"],
    CHAT_ONLY,
    { profiles: ["design"], retention: "summary-only" },
  ),
  hostRecord(
    "audit_accessibility_tree",
    "builtin",
    ["read_project", "read_runtime"],
    CHAT_ONLY,
    { profiles: ["design"], retention: "summary-only" },
  ),
  hostRecord(
    "compare_preview_states",
    "builtin",
    ["read_project", "read_runtime"],
    CHAT_ONLY,
    { profiles: ["design"], retention: "summary-only" },
  ),
  hostRecord(
    "trace_design_provenance",
    "project",
    ["read_project", "read_runtime"],
    CHAT_ONLY,
    { profiles: ["design"], retention: "summary-only" },
  ),
]);
