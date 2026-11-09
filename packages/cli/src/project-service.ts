import path from "node:path";
import { lstat, mkdir, readdir, rmdir } from "node:fs/promises";
import {
  applyDesignSystemPackage,
  runStaticProjectHealthCheck,
  validateSemanticTokensCss,
  type ProjectFiles,
  type ProjectHealthIssue,
  type ProjectHealthReport,
} from "@open-builder/core";
import { loadDesignSystem, listDesignSystems } from "./assets.js";
import { createTemplateFiles, listTemplates } from "./templates.js";
import { ProjectPaths } from "./node/paths.js";
import { scanProject, writeNewFiles, type SkippedFile } from "./node/files.js";
import { ProjectError, projectError, throwIfCancelled } from "./node/errors.js";
import {
  verifyProjectTask,
  type VerifyOptions,
  type VerifyResult,
} from "./node/process.js";

export { ProjectError } from "./node/errors.js";
export type { VerifyOptions, VerifyResult } from "./node/process.js";

export interface ProjectCheckResult {
  report: ProjectHealthReport;
  scope: { scannedFiles: number; skipped: SkippedFile[] };
  design: {
    designFilePresent: boolean;
    tokensFilePresent: boolean;
    tokensValid: boolean | null;
    staticWiringDetected: boolean;
  };
  notRun: string[];
}

function htmlRuntimeReferences(source: string): string[] {
  const references: string[] = [];
  for (const tag of source.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of tag[2].matchAll(
      /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
    )) {
      const name = attribute[1].toLowerCase();
      if (!attributes.has(name))
        attributes.set(
          name,
          attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
        );
    }
    if (tag[1].toLowerCase() === "link") {
      const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("stylesheet") && !attributes.has("disabled")) {
        const href = attributes.get("href");
        if (href) references.push(href);
      }
    } else {
      const type = attributes.get("type") ?? "";
      const executable =
        type === "" ||
        type.toLowerCase() === "module" ||
        /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:javascript1\.[0-5]|jscript|livescript))$/i.test(
          type.trim(),
        );
      const src = attributes.get("src");
      if (executable && src) references.push(src);
    }
  }
  return references;
}

/** Source evidence only: follow local imports from an HTML or conventional source entry. */
function tokensReachable(files: ProjectFiles, tokensPath: string): boolean {
  const visited = new Set<string>();
  const entries =
    files["index.html"] !== undefined
      ? ["index.html"]
      : [
          "src/main.tsx",
          "src/main.ts",
          "src/main.jsx",
          "src/main.js",
          "index.tsx",
          "index.jsx",
        ].filter((name) => files[name] !== undefined);
  function follow(filename: string): boolean {
    if (filename === tokensPath) return true;
    if (visited.has(filename) || files[filename] === undefined) return false;
    visited.add(filename);
    const source = files[filename]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const refs = [
      ...source.matchAll(
        /(?:\b(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?|\bimport\s*\(|\brequire\s*\(|@import\s+(?:url\(\s*)?)["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]);
    if (filename.endsWith(".html")) {
      refs.push(...htmlRuntimeReferences(source));
    }
    for (const reference of refs) {
      if (
        /^(?:[a-z]+:|\/\/|#)/i.test(reference) ||
        (!reference.startsWith(".") &&
          !reference.startsWith("/") &&
          !filename.endsWith(".html"))
      )
        continue;
      const clean = reference.split(/[?#]/)[0];
      const resolved = path.posix.normalize(
        clean.startsWith("/")
          ? clean.slice(1)
          : path.posix.join(path.posix.dirname(filename), clean),
      );
      if (resolved.startsWith("../")) continue;
      const candidates = [
        resolved,
        ...[
          ".tsx",
          ".ts",
          ".jsx",
          ".js",
          ".css",
          "/index.tsx",
          "/index.ts",
          "/index.jsx",
          "/index.js",
        ].map((suffix) => `${resolved}${suffix}`),
      ];
      if (
        candidates.some(
          (candidate) => files[candidate] !== undefined && follow(candidate),
        )
      )
        return true;
    }
    return false;
  }
  return entries.some(follow);
}

export class ProjectService {
  private readonly paths: ProjectPaths;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(options: { root?: string } = {}) {
    this.paths = new ProjectPaths(options.root);
  }

  async ready(): Promise<void> {
    try {
      await this.paths.ready();
    } catch (error) {
      throw projectError(error);
    }
  }

  private async exclusive<T>(
    directory: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfCancelled(signal);
    const previous = this.pending.get(directory) ?? Promise.resolve();
    let started = false;
    const work = previous.then(() => {
      throwIfCancelled(signal);
      started = true;
      return operation();
    });
    const tail = work.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(directory, tail);
    void tail.then(() => {
      if (this.pending.get(directory) === tail) this.pending.delete(directory);
    });
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (!started)
          reject(
            new ProjectError(
              "CANCELLED",
              "Operation cancelled while waiting for the project.",
              130,
            ),
          );
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void work
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  async initialize(
    project: string,
    options: { template: string; design?: string },
  ): Promise<{ directory: string; files: string[] }> {
    try {
      const directory = await this.paths.resolve(project, true);
      return await this.exclusive(directory, async () => {
        if (!listTemplates().some((entry) => entry.id === options.template))
          throw new ProjectError(
            "UNKNOWN_TEMPLATE",
            "Select a template from templates list.",
          );
        if (
          options.design !== undefined &&
          !(await listDesignSystems()).some(
            (entry) => entry.id === options.design,
          )
        )
          throw new ProjectError(
            "UNKNOWN_DESIGN_SYSTEM",
            "Select a design system from design list.",
          );
        const design =
          options.design === undefined
            ? undefined
            : await loadDesignSystem(options.design);
        const files = createTemplateFiles(options.template, design);
        if ((await this.paths.resolve(project, true)) !== directory)
          throw new ProjectError(
            "PATH_CHANGED",
            "Project path changed before initialization.",
          );
        await mkdir(directory);
        const owned = await lstat(directory);
        try {
          await writeNewFiles(directory, files);
        } catch (error) {
          try {
            const current = await lstat(directory);
            if (
              current.isDirectory() &&
              current.ino === owned.ino &&
              current.dev === owned.dev
            )
              await rmdir(directory);
          } catch {
            /* Preserve partial or concurrently edited projects. */
          }
          throw error;
        }
        return { directory, files: Object.keys(files).sort() };
      });
    } catch (error) {
      throw projectError(error);
    }
  }

  async applyDesign(
    project: string,
    id: string,
  ): Promise<{ directory: string; files: string[]; nextSteps: string[] }> {
    try {
      const directory = await this.paths.resolve(project);
      return await this.exclusive(directory, async () => {
        if (!(await listDesignSystems()).some((entry) => entry.id === id))
          throw new ProjectError(
            "UNKNOWN_DESIGN_SYSTEM",
            "Select a design system from design list.",
          );
        const pkg = await loadDesignSystem(id);
        if ((await this.paths.resolve(project)) !== directory)
          throw new ProjectError(
            "PATH_CHANGED",
            "Project path changed before applying the design.",
          );
        const existing = await readdir(directory);
        if (
          existing.some((name) =>
            ["design.md", "tokens.css"].includes(name.toLowerCase()),
          )
        )
          throw new ProjectError(
            "DESIGN_CONFLICT",
            "DESIGN.md or tokens.css already exists. No design files were written; ask the host to migrate the existing design.",
          );
        if (existing.length === 0)
          throw new ProjectError(
            "EMPTY_PROJECT",
            "Initialize the project before applying a design system.",
          );
        // The pure transform retains its Web overwrite semantics; this adapter only writes new files.
        const applied = applyDesignSystemPackage(
          { __existing_project__: "" },
          pkg,
        );
        const files = {
          "DESIGN.md": applied.files["DESIGN.md"],
          "tokens.css": applied.files["tokens.css"],
        };
        await writeNewFiles(directory, files);
        return {
          directory,
          files: Object.keys(files),
          nextSteps: [
            "Read DESIGN.md and import tokens.css from the project's active style entry. Existing entry files were not changed.",
            "Run check and the project's applicable verification tasks; visual verification remains separate.",
          ],
        };
      });
    } catch (error) {
      throw projectError(error);
    }
  }

  async check(project: string): Promise<ProjectCheckResult> {
    try {
      const directory = await this.paths.resolve(project);
      const { files, skipped } = await scanProject(directory);
      const designPath = Object.keys(files).find(
        (name) => name.toLowerCase() === "design.md",
      );
      const tokensPath = Object.keys(files).find(
        (name) => name.toLowerCase() === "tokens.css",
      );
      const additionalIssues: ProjectHealthIssue[] = [];
      let tokensValid: boolean | null = null;
      if (tokensPath) {
        try {
          validateSemanticTokensCss(files[tokensPath]);
          tokensValid = true;
        } catch (error) {
          tokensValid = false;
          additionalIssues.push({
            severity: "error",
            category: "design_system",
            path: tokensPath,
            message:
              error instanceof Error
                ? error.message
                : "Invalid semantic tokens.",
          });
        }
      }
      const staticWiringDetected =
        tokensPath !== undefined && tokensReachable(files, tokensPath);
      if (tokensPath && !staticWiringDetected)
        additionalIssues.push({
          severity: "warning",
          category: "design_system",
          path: tokensPath,
          message:
            "No static path from a recognized entry to tokens.css was detected. Ask the host to verify the actual style entry.",
        });
      if (Boolean(designPath) !== Boolean(tokensPath))
        additionalIssues.push({
          severity: "info",
          category: "design_system",
          message:
            "Only one of DESIGN.md and tokens.css is present; the existing design convention is not a complete bundled contract.",
        });
      const report = runStaticProjectHealthCheck(files, {
        additionalIssues,
        includeEnvironment: false,
      });
      // Node's JSON parser can include source excerpts, which may contain credentials.
      report.issues = report.issues.map((issue) =>
        issue.category === "dependencies" &&
        issue.message.startsWith("package.json is invalid JSON:")
          ? {
              ...issue,
              message:
                "package.json is invalid JSON. Correct its syntax before checking dependencies.",
            }
          : issue,
      );
      return {
        report,
        scope: { scannedFiles: Object.keys(files).length, skipped },
        design: {
          designFilePresent: !!designPath,
          tokensFilePresent: !!tokensPath,
          tokensValid,
          staticWiringDetected,
        },
        notRun: [
          "environment-secret-values",
          "package-installation",
          "build",
          "typecheck",
          "lint",
          "tests",
          "browser-runtime",
          "visual-review",
          "full-design-run-adherence",
          "deployment",
        ],
      };
    } catch (error) {
      throw projectError(error);
    }
  }

  async verify(project: string, options: VerifyOptions): Promise<VerifyResult> {
    try {
      const directory = await this.paths.resolve(project);
      // A running task resolves after its managed process group or job is cleaned up.
      return await this.exclusive(
        directory,
        async () => {
          if ((await this.paths.resolve(project)) !== directory)
            throw new ProjectError(
              "PATH_CHANGED",
              "Project path changed before verification.",
            );
          return verifyProjectTask(directory, options);
        },
        options.signal,
      );
    } catch (error) {
      throw projectError(error);
    }
  }
}
