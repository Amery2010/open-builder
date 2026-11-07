import type { ProjectFiles } from "../generator-types";
import { normalizeProjectPath } from "../../tools/fs-tools";
import {
  hasSensitiveProjectFileContent,
  isAuthorityFilePath,
  isSensitiveProjectPath,
} from "../../utils/project-file-policy";
import { validateProjectFiles } from "../../utils/project-files";

export interface DelegatedEdit {
  path: string;
  before?: string;
  content: string;
}

export const DELEGATED_WRITE_TOOLS = new Set(["write_file", "patch_file"]);

function protectedPath(path: string): boolean {
  return (
    isSensitiveProjectPath(path) ||
    isAuthorityFilePath(path.split("/").at(-1) ?? path) ||
    /(^|\/)\.[^/]+/.test(path) ||
    /(^|\/)(?:[^/]*[.-])?config(?:[.-][^/]+)?$/i.test(path) ||
    !/\.(?:[cm]?[jt]sx?|html?|css|scss|sass|less|vue|svelte|json|mdx?|txt|svg|xml|ya?ml)$/i.test(
      path,
    ) ||
    /(^|\/)(?:package\.json|(?:package-lock|npm-shrinkwrap)\.json|(?:pnpm-lock|yarn|bun)\.(?:yaml|lock|lockb)|design-project\.json|design\.md|tokens\.css|(?:vite|vitest|webpack|rollup|next|postcss|tailwind|svelte|astro)\.config\.[^/]+|(?:ts|js)config(?:\.[^/]+)?\.json)$/i.test(
      path,
    ) ||
    /(^|\/)(?:node_modules|\.git|\.open-builder|generated-assets)(?:\/|$)/i.test(
      path,
    ) ||
    /(^|\/)__open_builder_/i.test(path) ||
    /\.(?:png|jpe?g|webp|gif|ico|avif|woff2?|ttf|otf|pdf|wasm|zip)$/i.test(path)
  );
}

export function validateDelegatedWritePaths(
  value: unknown,
  files: ProjectFiles,
): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("code-writer requires non-empty writePaths.");
  const paths: string[] = [];
  for (const valuePath of value) {
    const checked = normalizeProjectPath(valuePath);
    if (
      !checked.ok ||
      checked.path !== valuePath ||
      /[*?[\]{}]/.test(checked.path)
    ) {
      throw new Error(
        "writePaths must contain exact, normalized project file paths.",
      );
    }
    const path = checked.path;
    if (
      protectedPath(path) ||
      (files[path] !== undefined && hasSensitiveProjectFileContent(files[path]))
    ) {
      throw new Error(
        `Delegated writes cannot modify protected file "${path}".`,
      );
    }
    if (paths.some((other) => other.toLowerCase() === path.toLowerCase()))
      throw new Error(`Duplicate write path "${path}".`);
    paths.push(path);
  }
  return paths;
}

export function delegatedWriteError(
  name: string,
  args: unknown,
  paths: readonly string[],
  files: ProjectFiles,
): string | undefined {
  if (!DELEGATED_WRITE_TOOLS.has(name))
    return `Tool "${name}" is not available to a scoped writer.`;
  const path =
    args && typeof args === "object"
      ? (args as { path?: unknown }).path
      : undefined;
  if (typeof path !== "string" || !paths.includes(path))
    return `Write target "${String(path)}" is outside this subagent's writePaths.`;
  try {
    validateDelegatedWritePaths([path], files);
  } catch (error) {
    return (error as Error).message;
  }
}

export function collectDelegatedEdits(
  before: ProjectFiles,
  after: ProjectFiles,
  paths: readonly string[],
): DelegatedEdit[] {
  const edits: DelegatedEdit[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[path] === after[path]) continue;
    if (!paths.includes(path))
      throw new Error(`Subagent modified unowned file "${path}".`);
    if (after[path] === undefined)
      throw new Error(`Subagents cannot delete "${path}".`);
    validateDelegatedWritePaths([path], after);
    edits.push({ path, before: before[path], content: after[path] });
  }
  return edits;
}

export function mergeDelegatedEdits(
  current: ProjectFiles,
  baseline: ProjectFiles,
  paths: readonly string[],
  edits: readonly DelegatedEdit[],
): ProjectFiles {
  validateDelegatedWritePaths([...paths], current);
  const conflicts: string[] = [];
  const next = { ...current };
  const seen = new Set<string>();
  for (const edit of edits) {
    if (
      !paths.includes(edit.path) ||
      seen.has(edit.path) ||
      edit.before !== baseline[edit.path] ||
      typeof edit.content !== "string"
    )
      throw new Error("Subagent returned invalid delegated edits.");
    seen.add(edit.path);
    if (current[edit.path] !== baseline[edit.path]) conflicts.push(edit.path);
    next[edit.path] = edit.content;
    validateDelegatedWritePaths([edit.path], next);
  }
  if (conflicts.length)
    throw new Error(
      `Delegated edit conflict: ${conflicts.join(", ")}. Reassign this task using the current files.`,
    );
  const validation = validateProjectFiles(next);
  if (!validation.ok) throw new Error(validation.error);
  return next;
}

/** Holds ownership through commit, and serializes commits after async guards. */
export class DelegatedEditCoordinator {
  private active = new Set<{ paths: Set<string>; done: Promise<void> }>();
  private commitTail: Promise<unknown> = Promise.resolve();

  async run<T>(
    paths: readonly string[],
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const owned = new Set(paths.map((path) => path.toLowerCase()));
    for (;;) {
      signal.throwIfAborted();
      const blockers = [...this.active].filter(
        (task) =>
          this.active.size >= 3 ||
          [...owned].some((path) => task.paths.has(path)),
      );
      if (!blockers.length) break;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        void Promise.race(blockers.map((task) => task.done)).then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
        if (signal.aborted) abort();
      });
    }
    let release!: () => void;
    const task = {
      paths: owned,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    this.active.add(task);
    try {
      return await operation();
    } finally {
      this.active.delete(task);
      release();
    }
  }

  commit<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commitTail.then(operation);
    this.commitTail = result.catch(() => undefined);
    return result;
  }
}
