import type { ProjectFiles, FileChange } from "../ai/generator-types";
import type { HostToolProjectPermissionResolution } from "../ai/host-tool-catalog";
import { truncate } from "../utils/truncate";
import { renamePathInProject, basename } from "./file-refs";
import { fsReadEnvSchema, fsManageEnv, type ManageEnvOp } from "./env-tools";
import {
  hasUnsafeProjectPathCharacters,
  isEnvironmentSecretPath,
  isSensitiveProjectPath,
  projectFilesForModel,
  redactProjectFileSecrets,
} from "../utils/project-file-policy";
import {
  applyOpenBuilderTemplateProfile,
  isOpenBuilderTemplateName,
  OPEN_BUILDER_TEMPLATE_MANIFEST_VERSION,
  OPEN_BUILDER_TEMPLATE_NAMES,
  preserveTemplateRuntimeDependencies,
} from "./sandpack-template-manifest";
import {
  applyPrototypeStarter,
  PROTOTYPE_RUNTIME_TEMPLATE,
  PROTOTYPE_TEMPLATE_NAME,
} from "../design/prototype-starter";

type SandboxTemplateFile = string | { code: string };
type SandboxTemplate = {
  files: Record<string, SandboxTemplateFile>;
};
type SandboxTemplates = Record<string, SandboxTemplate>;

export const FS_TOOL_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxReadFiles: 20,
  maxReadOutputChars: 120_000,
  maxSearchMatches: 200,
  maxSearchPatternChars: 200,
  maxSearchFiles: 1_000,
  maxSearchScannedChars: 1_000_000,
  maxSearchLineChars: 5_000,
  maxPatchCount: 100,
} as const;
const SENSITIVE_HIDDEN_PATHS = [
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".kube/",
  ".docker/",
  ".config/gh/",
];

function textBytes(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
}

export function validateProjectFileContent(content: unknown):
  | {
      ok: true;
      content: string;
    }
  | {
      ok: false;
      error: string;
    } {
  if (typeof content !== "string") {
    return { ok: false, error: "content must be a string" };
  }
  if (textBytes(content) > FS_TOOL_LIMITS.maxFileBytes) {
    return {
      ok: false,
      error: `file content exceeds ${FS_TOOL_LIMITS.maxFileBytes} bytes`,
    };
  }
  return { ok: true, content };
}

function truncateToolOutput(output: string): {
  output: string;
  truncated: boolean;
} {
  if (output.length <= FS_TOOL_LIMITS.maxReadOutputChars) {
    return { output, truncated: false };
  }
  return {
    output:
      output.slice(0, FS_TOOL_LIMITS.maxReadOutputChars) +
      `\n\n[truncated after ${FS_TOOL_LIMITS.maxReadOutputChars} chars]`,
    truncated: true,
  };
}

export function normalizeProjectPath(path: unknown):
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      error: string;
    } {
  if (typeof path !== "string") {
    return { ok: false, error: "path must be a string" };
  }
  if (hasUnsafeProjectPathCharacters(path)) {
    return { ok: false, error: "path must not contain control characters" };
  }
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed) return { ok: false, error: "path must not be empty" };
  if (trimmed.startsWith("/") || /^[a-zA-Z]:\//.test(trimmed)) {
    return { ok: false, error: `absolute paths are not allowed — "${path}"` };
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    return { ok: false, error: `path traversal is not allowed — "${path}"` };
  }
  if (parts.some((part) => part === ".")) {
    return {
      ok: false,
      error: `dot path segments are not allowed — "${path}"`,
    };
  }
  const normalized = parts.join("/");
  if (!normalized) return { ok: false, error: "path must not be empty" };
  if (
    SENSITIVE_HIDDEN_PATHS.some(
      (prefix) =>
        normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
    )
  ) {
    return {
      ok: false,
      error: `sensitive hidden paths are not allowed — "${path}"`,
    };
  }
  return { ok: true, path: normalized };
}

function normalizePathList(paths: unknown):
  | {
      ok: true;
      paths: string[];
    }
  | {
      ok: false;
      error: string;
    } {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: "no paths provided" };
  }
  const normalized: string[] = [];
  for (const path of paths) {
    const result = normalizeProjectPath(path);
    if (!result.ok) return { ok: false, error: result.error };
    normalized.push(result.path);
  }
  return { ok: true, paths: normalized };
}

function rejectProtectedGenericPath(path: string): FsToolResult | null {
  if (isEnvironmentSecretPath(path)) {
    return {
      result: `Error: "${path}" is managed by manage_env. Use manage_env instead of generic file tools.`,
      changes: [],
    };
  }
  if (isSensitiveProjectPath(path)) {
    return {
      result: `Error: "${path}" is protected and cannot be accessed by generic model file tools.`,
      changes: [],
    };
  }
  return null;
}

function rejectProtectedGenericMutationPath(path: string): FsToolResult | null {
  const protectedPath = rejectProtectedGenericPath(path);
  if (protectedPath) return protectedPath;
  if (path.toLowerCase() === "design-project.json") {
    return {
      result:
        'Error: "design-project.json" is managed by update_project_design. Generic file tools may read it but cannot modify it.',
      changes: [],
    };
  }
  return null;
}

function validateSearchPattern(pattern: unknown):
  | {
      ok: true;
      pattern: string;
    }
  | {
      ok: false;
      error: string;
    } {
  if (typeof pattern !== "string") {
    return { ok: false, error: "pattern must be a string" };
  }
  if (!pattern) return { ok: false, error: "pattern must not be empty" };
  if (pattern.length > FS_TOOL_LIMITS.maxSearchPatternChars) {
    return {
      ok: false,
      error: `pattern is too long (max ${FS_TOOL_LIMITS.maxSearchPatternChars} characters)`,
    };
  }
  // Avoid common catastrophic backtracking shapes such as (a+)+ or (.*){2,}.
  if (
    /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/.test(pattern)
  ) {
    return {
      ok: false,
      error:
        "pattern contains nested quantifiers that are unsafe for project-wide search",
    };
  }
  return { ok: true, pattern };
}

let sandboxTemplatesPromise: Promise<SandboxTemplates> | null = null;

async function loadSandboxTemplates(): Promise<SandboxTemplates> {
  sandboxTemplatesPromise ??= import("@codesandbox/sandpack-react").then(
    (mod) => mod.SANDBOX_TEMPLATES as SandboxTemplates,
  );
  return sandboxTemplatesPromise;
}

function isPackageJsonRecord(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return Boolean(
      parsed && typeof parsed === "object" && !Array.isArray(parsed),
    );
  } catch {
    return false;
  }
}

export interface FsToolResult {
  result: string;
  changes: FileChange[];
  /** When set, the generator replaces its entire files map with this object
   *  (init_project semantics). */
  newFiles?: ProjectFiles;
  /** When true, signal a full project template change (with the template name). */
  templateChange?: { template: string };
  /** When true, signal a dependency change (manage_dependencies semantics). */
  dependenciesChanged?: boolean;
}

export async function fsInitProject(template: string): Promise<FsToolResult> {
  const runtimeTemplate =
    template === PROTOTYPE_TEMPLATE_NAME
      ? PROTOTYPE_RUNTIME_TEMPLATE
      : template;
  if (!isOpenBuilderTemplateName(runtimeTemplate)) {
    return {
      result: `Error: unknown template "${template}". Use one of: ${[
        ...OPEN_BUILDER_TEMPLATE_NAMES,
        PROTOTYPE_TEMPLATE_NAME,
      ].join(", ")}`,
      changes: [],
    };
  }
  const templates = await loadSandboxTemplates();
  const tmpl = templates[runtimeTemplate];
  if (!tmpl) {
    return {
      result: `Error: template "${template}" is unavailable in the installed Sandpack runtime`,
      changes: [],
    };
  }
  const newFiles: ProjectFiles = {};
  const changes: FileChange[] = [];
  for (const [path, file] of Object.entries(tmpl.files)) {
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    const code =
      typeof file === "string" ? file : (file as { code: string }).code;
    newFiles[normalizedPath] = code;
    changes.push({ path: normalizedPath, action: "created" });
  }
  const appliedProfile = applyOpenBuilderTemplateProfile(
    runtimeTemplate,
    newFiles,
  );
  if (!appliedProfile.ok) {
    return {
      result: `Error: ${appliedProfile.error}`,
      changes: [],
    };
  }
  const initializedFiles =
    template === PROTOTYPE_TEMPLATE_NAME
      ? applyPrototypeStarter(newFiles)
      : newFiles;
  if (initializedFiles !== newFiles) {
    changes.length = 0;
    for (const path of Object.keys(initializedFiles)) {
      changes.push({ path, action: "created" });
    }
  }
  return {
    result:
      `OK — initialized project with template "${template}" (${Object.keys(initializedFiles).length} files); ` +
      `applied Open Builder ${appliedProfile.status} dependency profile v${OPEN_BUILDER_TEMPLATE_MANIFEST_VERSION}`,
    changes,
    newFiles: initializedFiles,
    templateChange: { template: runtimeTemplate },
  };
}

export function fsManageDependencies(
  packageJson: string,
  files: ProjectFiles,
): FsToolResult {
  const checkedContent = validateProjectFileContent(packageJson);
  if (!checkedContent.ok) {
    return {
      result: `Error: package_json ${checkedContent.error}`,
      changes: [],
    };
  }
  if (!isPackageJsonRecord(checkedContent.content)) {
    return { result: "Error: invalid JSON in package_json", changes: [] };
  }
  const pkgPath =
    Object.keys(files).find((p) => p.endsWith("package.json")) ||
    "package.json";
  const guarded = preserveTemplateRuntimeDependencies(
    files[pkgPath],
    checkedContent.content,
  );
  const action: FileChange["action"] =
    pkgPath in files ? "modified" : "created";
  return {
    result:
      `OK — ${action} ${pkgPath}, dependencies updated. Sandpack will restart.` +
      (guarded.preservedDependencies.length > 0
        ? ` Preserved Sandpack/Nodebox-compatible runtime dependencies: ${guarded.preservedDependencies.join(", ")}.`
        : ""),
    changes: [{ path: pkgPath, action }],
    newFiles: { ...files, [pkgPath]: guarded.content },
    dependenciesChanged: true,
  };
}

export function fsListFiles(files: ProjectFiles): FsToolResult {
  const paths = Object.keys(projectFilesForModel(files)).sort();
  return {
    result:
      paths.length === 0 ? "(empty project — no files)" : paths.join("\n"),
    changes: [],
  };
}

export function fsReadFiles(
  paths: string[],
  files: ProjectFiles,
): FsToolResult {
  const checked = normalizePathList(paths);
  if (!checked.ok) return { result: `Error: ${checked.error}`, changes: [] };
  if (checked.paths.length > FS_TOOL_LIMITS.maxReadFiles) {
    return {
      result: `Error: read_files can read at most ${FS_TOOL_LIMITS.maxReadFiles} files at once`,
      changes: [],
    };
  }
  const out = checked.paths
    .map((path) => {
      const protectedPath = rejectProtectedGenericPath(path);
      if (protectedPath) {
        return `=== ${path} ===\n${protectedPath.result}`;
      }
      if (!(path in files)) {
        return `=== ${path} ===\nError: file not found`;
      }
      return `=== ${path} ===\n${redactProjectFileSecrets(files[path])}`;
    })
    .join("\n\n");
  const truncated = truncateToolOutput(out);
  return { result: truncated.output, changes: [] };
}

export function fsWriteFile(
  path: string,
  content: string,
  files: ProjectFiles,
): FsToolResult {
  const checked = normalizeProjectPath(path);
  if (!checked.ok) return { result: `Error: ${checked.error}`, changes: [] };
  const checkedContent = validateProjectFileContent(content);
  if (!checkedContent.ok) {
    return { result: `Error: ${checkedContent.error}`, changes: [] };
  }
  const envRejected = rejectProtectedGenericMutationPath(checked.path);
  if (envRejected) return envRejected;
  const action: FileChange["action"] =
    checked.path in files ? "modified" : "created";
  return {
    result: `OK — ${action}: ${checked.path} (${checkedContent.content.length} chars)`,
    changes: [{ path: checked.path, action }],
    newFiles: { ...files, [checked.path]: checkedContent.content },
  };
}

export function fsPatchFile(
  path: string,
  patches: Array<{ search: string; replace: string }>,
  files: ProjectFiles,
): FsToolResult {
  const checked = normalizeProjectPath(path);
  if (!checked.ok) return { result: `Error: ${checked.error}`, changes: [] };
  const envRejected = rejectProtectedGenericMutationPath(checked.path);
  if (envRejected) return envRejected;
  if (!(checked.path in files)) {
    return { result: `Error: file not found — "${checked.path}"`, changes: [] };
  }
  if (!Array.isArray(patches) || patches.length === 0) {
    return { result: "Error: no patches provided", changes: [] };
  }
  if (patches.length > FS_TOOL_LIMITS.maxPatchCount) {
    return {
      result: `Error: patch_file supports at most ${FS_TOOL_LIMITS.maxPatchCount} patches at once`,
      changes: [],
    };
  }

  let content = files[checked.path];
  const log: string[] = [];
  let applied = 0;
  let failed = 0;

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (!patch || typeof patch !== "object") {
      return {
        result: `Error: patch #${i + 1} requires search and replace`,
        changes: [],
      };
    }
    const { search, replace } = patch;
    if (typeof search !== "string" || typeof replace !== "string") {
      return {
        result: `Error: patch #${i + 1} requires string search and replace`,
        changes: [],
      };
    }
    if (search.length === 0) {
      return {
        result: `Error: patch #${i + 1} search must not be empty`,
        changes: [],
      };
    }
    const idx = content.indexOf(search);

    if (idx >= 0) {
      content =
        content.slice(0, idx) + replace + content.slice(idx + search.length);
      log.push(`patch #${i + 1}: applied`);
      applied++;
    } else {
      log.push(`patch #${i + 1}: not found — "${truncate(search, 60)}"`);
      failed++;
    }
  }

  if (applied === 0) {
    return {
      result:
        `Error: none of ${patches.length} patches matched in "${checked.path}" — file was not modified.\n` +
        log.join("\n") +
        `\nTip: re-read the file to verify its current content, then retry with an exact search string.`,
      changes: [],
    };
  }
  const checkedContent = validateProjectFileContent(content);
  if (!checkedContent.ok) {
    return {
      result: `Error: patched file ${checkedContent.error}`,
      changes: [],
    };
  }

  const header =
    failed > 0
      ? `Warning: ${failed} of ${patches.length} patches did not match — those edits were skipped. Re-read the file and retry the failed patches if needed.\n`
      : "";

  return {
    result: header + log.join("\n"),
    changes: [{ path: checked.path, action: "modified" }],
    newFiles: { ...files, [checked.path]: checkedContent.content },
  };
}

export function fsSearchInFiles(
  pattern: string,
  files: ProjectFiles,
): FsToolResult {
  const checkedPattern = validateSearchPattern(pattern);
  if (!checkedPattern.ok) {
    return { result: `Error: ${checkedPattern.error}`, changes: [] };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(checkedPattern.pattern, "g");
  } catch {
    return {
      result: `Error: invalid regex pattern — "${checkedPattern.pattern}"`,
      changes: [],
    };
  }
  const results: string[] = [];
  let truncated = false;
  let scannedChars = 0;
  const modelFiles = projectFilesForModel(files);
  const entries = Object.entries(modelFiles).slice(
    0,
    FS_TOOL_LIMITS.maxSearchFiles,
  );
  if (Object.keys(modelFiles).length > entries.length) truncated = true;
  for (const [path, content] of entries) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].slice(0, FS_TOOL_LIMITS.maxSearchLineChars);
      scannedChars += line.length;
      if (scannedChars > FS_TOOL_LIMITS.maxSearchScannedChars) {
        truncated = true;
        break;
      }
      if (regex.test(line)) {
        results.push(`${path}:${i + 1}: ${line.trim()}`);
        if (results.length >= FS_TOOL_LIMITS.maxSearchMatches) {
          truncated = true;
          break;
        }
      }
      regex.lastIndex = 0;
    }
    if (truncated) break;
  }
  return {
    result:
      results.length > 0
        ? results.join("\n") +
          (truncated
            ? `\n[truncated after ${FS_TOOL_LIMITS.maxSearchMatches} matches or search budget]`
            : "")
        : truncated
          ? `(no matches found before search budget was exhausted)\n[truncated after ${FS_TOOL_LIMITS.maxSearchScannedChars} scanned chars or ${FS_TOOL_LIMITS.maxSearchFiles} files]`
          : "(no matches found)",
    changes: [],
  };
}

export function fsDeleteFile(path: string, files: ProjectFiles): FsToolResult {
  const checked = normalizeProjectPath(path);
  if (!checked.ok) return { result: `Error: ${checked.error}`, changes: [] };
  const envRejected = rejectProtectedGenericMutationPath(checked.path);
  if (envRejected) return envRejected;
  if (!(checked.path in files)) {
    return { result: `Error: file not found — "${checked.path}"`, changes: [] };
  }
  const newFiles = { ...files };
  delete newFiles[checked.path];
  return {
    result: `OK — deleted: ${checked.path}`,
    changes: [{ path: checked.path, action: "deleted" }],
    newFiles,
  };
}

export function fsRenameFile(
  oldPath: string,
  newPath: string,
  files: ProjectFiles,
): FsToolResult {
  const checkedOld = normalizeProjectPath(oldPath);
  if (!checkedOld.ok)
    return { result: `Error: old_path ${checkedOld.error}`, changes: [] };
  const checkedNew = normalizeProjectPath(newPath);
  if (!checkedNew.ok)
    return { result: `Error: new_path ${checkedNew.error}`, changes: [] };
  const envRejected =
    rejectProtectedGenericMutationPath(checkedOld.path) ??
    rejectProtectedGenericMutationPath(checkedNew.path);
  if (envRejected) return envRejected;
  if (checkedOld.path === checkedNew.path) {
    return {
      result: "Error: old_path and new_path are identical",
      changes: [],
    };
  }
  const prefix = checkedOld.path + "/";
  const exists =
    checkedOld.path in files ||
    Object.keys(files).some((k) => k.startsWith(prefix));
  if (!exists) {
    return {
      result: `Error: path not found — "${checkedOld.path}"`,
      changes: [],
    };
  }
  const newPrefix = checkedNew.path + "/";
  if (
    checkedNew.path in files ||
    Object.keys(files).some((k) => k.startsWith(newPrefix))
  ) {
    return {
      result: `Error: destination already exists — "${checkedNew.path}"`,
      changes: [],
    };
  }

  const { newFiles, movedPaths, refCount, fileCount } = renamePathInProject(
    files,
    checkedOld.path,
    checkedNew.path,
  );

  const changes: FileChange[] = [];
  const movedDests = new Set<string>();
  for (const [from, to] of movedPaths) {
    changes.push({ path: from, action: "deleted" });
    changes.push({ path: to, action: "created" });
    movedDests.add(to);
  }
  for (const path of Object.keys(newFiles)) {
    if (
      path in files &&
      files[path] !== newFiles[path] &&
      !movedDests.has(path)
    ) {
      changes.push({ path, action: "modified" });
    }
  }

  const movedCount = movedPaths.length;
  const movedSummary =
    movedCount === 1
      ? `${movedPaths[0][0]} → ${movedPaths[0][1]}`
      : `${checkedOld.path}/ → ${checkedNew.path}/ (${movedCount} files)`;
  return {
    result:
      `OK — renamed ${movedSummary}, ` +
      `updated ${refCount} ${refCount === 1 ? "ref" : "refs"} ` +
      `in ${fileCount} ${fileCount === 1 ? "file" : "files"}`,
    changes,
    newFiles,
  };
}

export function fsMoveFile(
  path: string,
  targetDir: string,
  files: ProjectFiles,
): FsToolResult {
  const checkedPath = normalizeProjectPath(path);
  if (!checkedPath.ok)
    return { result: `Error: path ${checkedPath.error}`, changes: [] };
  const checkedDir =
    targetDir && targetDir.trim()
      ? normalizeProjectPath(targetDir)
      : ({ ok: true, path: "" } as const);
  if (!checkedDir.ok)
    return { result: `Error: target_dir ${checkedDir.error}`, changes: [] };
  const base = basename(checkedPath.path);
  const dir = checkedDir.path.replace(/\/+$/, "");
  const newPath = dir ? `${dir}/${base}` : base;
  return fsRenameFile(checkedPath.path, newPath, files);
}

/** Dispatch a file-system tool call. Returns null if the tool is not a recognized fs tool. */
export async function dispatchFsTool(
  name: string,
  args: any,
  files: ProjectFiles,
): Promise<FsToolResult | null> {
  switch (name) {
    case "init_project":
      return fsInitProject(args.template);
    case "manage_dependencies":
      return fsManageDependencies(args.package_json, files);
    case "list_files":
      return fsListFiles(files);
    case "read_files":
      return fsReadFiles(args.paths, files);
    case "write_file":
      return fsWriteFile(args.path, args.content, files);
    case "patch_file": {
      const patches = Array.isArray(args.patches)
        ? args.patches
        : [args.patches];
      return fsPatchFile(args.path, patches, files);
    }
    case "delete_file":
      return fsDeleteFile(args.path, files);
    case "search_in_files":
      return fsSearchInFiles(args.pattern, files);
    case "rename_file":
      return fsRenameFile(args.old_path, args.new_path, files);
    case "move_file":
      return fsMoveFile(args.path, args.target_dir ?? "", files);
    case "read_env_schema":
      return fsReadEnvSchema(files);
    case "manage_env": {
      const ops = Array.isArray(args.operations)
        ? (args.operations as ManageEnvOp[])
        : [];
      const gen = args.generate_typed_env !== false;
      return fsManageEnv(ops, gen, files);
    }
    default:
      return null;
  }
}

/** Resolve the real ProjectFiles impact of a destructive call by running the
 * same pure file transform used by execution. Invalid and otherwise failing
 * calls deliberately return undefined so the normal tool error is preserved
 * without opening a permission prompt. */
export async function resolveProjectPermissionImpact(
  name: "delete_file" | "rename_file" | "move_file" | "init_project",
  args: unknown,
  files: Readonly<ProjectFiles>,
): Promise<HostToolProjectPermissionResolution | undefined> {
  const outcome = await dispatchFsTool(name, args as any, { ...files });
  if (!outcome?.newFiles || outcome.result.startsWith("Error:")) {
    return undefined;
  }

  if (name === "init_project") {
    if (Object.keys(files).length === 0) return undefined;
    const affectedPaths = [
      ...new Set([...Object.keys(files), ...Object.keys(outcome.newFiles)]),
    ].sort((left, right) => left.localeCompare(right));
    return Object.freeze({
      scope: Object.freeze({ kind: "project" as const }),
      affectedPaths: Object.freeze(affectedPaths),
      affectedCount: affectedPaths.length,
    });
  }

  const affectedPaths = [
    ...new Set(outcome.changes.map((change) => change.path)),
  ].sort((left, right) => left.localeCompare(right));
  if (affectedPaths.length === 0) return undefined;
  return Object.freeze({
    scope: Object.freeze({
      kind: "exact" as const,
      paths: Object.freeze(affectedPaths),
    }),
    affectedPaths: Object.freeze(affectedPaths),
    affectedCount: affectedPaths.length,
  });
}
