import type {
  Conversation,
  ConversationDesignState,
  ProjectFiles,
  ProjectTemplate,
} from "../../types";
import { inspectDesignTokenContract } from "../design/tokens";
import { isOpenBuilderTemplateName } from "../tools/sandpack-template-manifest";
import {
  isSensitiveProjectPath,
  redactProjectFileSecrets,
} from "./project-file-policy";
import { validateProjectFiles } from "./project-files";

export interface TemplateMetadataInput {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  now: number;
}

export interface TemplateStats {
  fileCount: number;
  totalBytes: number;
}

export interface PreparedProjectTemplate {
  template: ProjectTemplate;
  report: {
    excludedPaths: string[];
    redactedPaths: string[];
  };
}

export type ProjectTemplateUnusableReason =
  | "unsupported-runtime"
  | "legacy-pending-upgrade"
  | "unsafe-status"
  | "invalid-digest"
  | "invalid-files"
  | "sensitive-content";

export type ProjectTemplateUsability =
  { ok: true } | { ok: false; reason: ProjectTemplateUnusableReason };

interface ProjectTemplateSource {
  files: ProjectFiles;
  template: string;
  previewMode?: Conversation["previewMode"];
  activeFile?: string;
  designState?: ConversationDesignState;
  sourceConversationId?: string;
  sourceUpdatedAt?: number;
}

const MAX_TAGS = 8;
export const PROJECT_TEMPLATE_LIMITS = {
  maxFiles: 300,
  maxTotalBytes: 5 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
} as const;

/**
 * Builds the exact safe copy shown in the confirmation preview. The source
 * conversation is never mutated and no project content leaves the browser.
 */
export async function prepareProjectTemplateFromConversation(
  conversation: Conversation,
  input: TemplateMetadataInput,
): Promise<PreparedProjectTemplate> {
  return prepareProjectTemplateSource(
    {
      files: conversation.files,
      template: conversation.template,
      previewMode: conversation.previewMode,
      activeFile: conversation.activeFile,
      designState: conversation.designState,
      sourceConversationId: conversation.id,
      sourceUpdatedAt: conversation.updatedAt,
    },
    input,
  );
}

/** Safely upgrades a retained v1 record from its own files. */
export async function prepareProjectTemplateUpgrade(
  template: ProjectTemplate,
  now: number,
): Promise<PreparedProjectTemplate> {
  return prepareProjectTemplateSource(
    {
      files: template.files,
      template: template.template,
      previewMode: template.previewMode,
      activeFile: template.activeFile,
      designState: template.designState,
      sourceConversationId: template.sourceConversationId,
      sourceUpdatedAt: template.sourceUpdatedAt ?? template.updatedAt,
    },
    {
      id: template.id,
      name: template.name,
      description: template.description,
      tags: template.tags,
      now,
    },
  );
}

async function prepareProjectTemplateSource(
  source: ProjectTemplateSource,
  input: TemplateMetadataInput,
): Promise<PreparedProjectTemplate> {
  const sourceValidation = validateProjectFiles(source.files);
  if (!sourceValidation.ok) throw new Error(sourceValidation.error);
  if (Object.keys(source.files).length === 0) {
    throw new Error("Cannot create a template from an empty project.");
  }
  if (!isOpenBuilderTemplateName(source.template)) {
    throw new Error(`Unsupported project runtime: ${source.template}`);
  }

  const excludedPaths: string[] = [];
  const redactedPaths: string[] = [];
  const files: ProjectFiles = {};
  for (const path of Object.keys(source.files).sort()) {
    if (isSensitiveProjectPath(path)) {
      excludedPaths.push(path);
      continue;
    }
    const content = source.files[path];
    const redacted = redactProjectFileSecrets(content);
    if (redacted !== content) redactedPaths.push(path);
    files[path] = redacted;
  }

  const validation = validateProjectTemplateFiles(files);
  if (!validation.ok) throw new Error(validation.error);
  if (Object.keys(files).length === 0) {
    throw new Error(
      "The project contains no files safe to save as a template.",
    );
  }

  const activeFile =
    source.activeFile && source.activeFile in files
      ? source.activeFile
      : Object.keys(files)[0];
  const designState = getVerifiedTemplateDesignState(source.designState, files);
  const analysis = analyzeProjectTemplate(files, designState);
  const previewMode = source.previewMode ?? "sandpack";
  const contentDigest = await digestTemplateContent({
    files,
    template: source.template,
    previewMode,
    activeFile,
    designState,
  });

  return {
    report: { excludedPaths, redactedPaths },
    template: {
      id: input.id,
      name: sanitizeTemplateName(input.name),
      description: normalizeOptionalText(input.description),
      files,
      template: source.template,
      previewMode,
      sourceConversationId: source.sourceConversationId,
      sourceUpdatedAt: source.sourceUpdatedAt,
      tags: normalizeTemplateTags(input.tags ?? []),
      schemaVersion: 2,
      contentDigest,
      activeFile,
      designState,
      analysis,
      safety: {
        status: "safe",
        excludedPaths,
        redactedPaths,
        preparedAt: input.now,
      },
      useCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export async function createConversationFromProjectTemplate(
  template: ProjectTemplate,
  input: { id: string; now: number },
): Promise<Conversation> {
  if (!isProjectTemplateUsable(template)) {
    throw new Error(
      "This template must be safely upgraded before it can be used.",
    );
  }
  const verifiedDigest = await digestTemplateContent({
    files: template.files,
    template: template.template,
    previewMode: template.previewMode ?? "sandpack",
    activeFile: template.activeFile,
    designState: template.designState,
  });
  if (verifiedDigest !== template.contentDigest) {
    throw new Error(
      "Project template content digest does not match its files.",
    );
  }
  return {
    id: input.id,
    title: template.name,
    messages: [],
    files: cloneProjectFiles(template.files),
    template: template.template,
    previewMode: template.previewMode ?? "sandpack",
    workspaceMode: "auto",
    activeFile:
      template.activeFile && template.activeFile in template.files
        ? template.activeFile
        : Object.keys(template.files)[0],
    designState: cloneTemplateDesignState(template.designState),
    templateOrigin:
      template.contentDigest && template.schemaVersion === 2
        ? {
            templateId: template.id,
            templateName: template.name,
            contentDigest: template.contentDigest,
            createdAt: input.now,
          }
        : undefined,
    isProjectInitialized: Object.keys(template.files).length > 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function isProjectTemplateUsable(template: ProjectTemplate): boolean {
  return getProjectTemplateUsability(template).ok;
}

export function getProjectTemplateUsability(
  template: ProjectTemplate,
): ProjectTemplateUsability {
  if (!isOpenBuilderTemplateName(template.template)) {
    return { ok: false, reason: "unsupported-runtime" };
  }
  if (template.schemaVersion !== 2) {
    return { ok: false, reason: "legacy-pending-upgrade" };
  }
  if (template.safety?.status !== "safe") {
    return { ok: false, reason: "unsafe-status" };
  }
  if (
    typeof template.contentDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(template.contentDigest)
  ) {
    return { ok: false, reason: "invalid-digest" };
  }
  if (
    !validateProjectFiles(template.files).ok ||
    !validateProjectTemplateFiles(template.files).ok
  ) {
    return { ok: false, reason: "invalid-files" };
  }
  if (
    Object.entries(template.files).some(
      ([path, content]) =>
        isSensitiveProjectPath(path) ||
        redactProjectFileSecrets(content) !== content,
    )
  ) {
    return { ok: false, reason: "sensitive-content" };
  }
  return { ok: true };
}

export function projectTemplateSearchText(template: ProjectTemplate): string {
  const analysis = getProjectTemplateAnalysis(template);
  return [
    template.name,
    template.description,
    ...template.tags,
    analysis.framework,
    analysis.language,
    ...analysis.tests,
    analysis.designSystem,
    ...analysis.autoTags,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

/** Computes display metadata for retained v1 records without rewriting them. */
export function getProjectTemplateAnalysis(
  template: ProjectTemplate,
): NonNullable<ProjectTemplate["analysis"]> {
  return (
    template.analysis ??
    analyzeProjectTemplate(template.files, template.designState)
  );
}

export function getProjectTemplateStats(
  template: Pick<ProjectTemplate, "files">,
): TemplateStats {
  const files = Object.values(template.files);
  return {
    fileCount: files.length,
    totalBytes: files.reduce(
      (total, content) => total + byteLength(content),
      0,
    ),
  };
}

export function validateProjectTemplateFiles(
  files: ProjectFiles,
): { ok: true } | { ok: false; error: string } {
  const entries = Object.entries(files);
  if (entries.length > PROJECT_TEMPLATE_LIMITS.maxFiles) {
    return {
      ok: false,
      error: `Project template has too many files (max ${PROJECT_TEMPLATE_LIMITS.maxFiles}).`,
    };
  }

  let totalBytes = 0;
  for (const [path, content] of entries) {
    const size = byteLength(content);
    if (size > PROJECT_TEMPLATE_LIMITS.maxFileBytes) {
      return {
        ok: false,
        error: `Project template file "${path}" is too large (max ${PROJECT_TEMPLATE_LIMITS.maxFileBytes} bytes).`,
      };
    }
    totalBytes += size;
    if (totalBytes > PROJECT_TEMPLATE_LIMITS.maxTotalBytes) {
      return {
        ok: false,
        error: `Project template is too large (max ${PROJECT_TEMPLATE_LIMITS.maxTotalBytes} bytes).`,
      };
    }
  }
  return { ok: true };
}

export function normalizeTemplateTags(tags: string[]): string[] {
  const normalized = tags
    .map((tag) => tag.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  return Array.from(new Set(normalized)).slice(0, MAX_TAGS);
}

export function sanitizeTemplateName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed || "Untitled Template";
}

export function cloneProjectFiles(files: ProjectFiles): ProjectFiles {
  return { ...files };
}

function normalizeOptionalText(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getVerifiedTemplateDesignState(
  designState: ConversationDesignState | undefined,
  files: ProjectFiles,
): ConversationDesignState | undefined {
  const inspection = inspectDesignTokenContract(files, designState);
  if (inspection.status !== "ready") return undefined;
  const appliedSystem = { ...inspection.appliedSystem };
  return {
    selectedSystem: { ...appliedSystem },
    appliedSystem,
  };
}

function cloneTemplateDesignState(
  state: ConversationDesignState | undefined,
): ConversationDesignState | undefined {
  if (!state?.appliedSystem || !state.selectedSystem) return undefined;
  return {
    selectedSystem: { ...state.selectedSystem },
    appliedSystem: { ...state.appliedSystem },
  };
}

function analyzeProjectTemplate(
  files: ProjectFiles,
  designState: ConversationDesignState | undefined,
): NonNullable<ProjectTemplate["analysis"]> {
  const paths = Object.keys(files);
  const packageJson = parsePackageJson(files["package.json"]);
  const dependencies = new Set<string>();
  for (const section of ["dependencies", "devDependencies"] as const) {
    const values = packageJson?.[section];
    if (!values || typeof values !== "object" || Array.isArray(values))
      continue;
    Object.keys(values).forEach((name) => dependencies.add(name));
  }
  const has = (name: string) => dependencies.has(name);
  const framework = has("next")
    ? "Next.js"
    : has("astro")
      ? "Astro"
      : has("@angular/core")
        ? "Angular"
        : has("svelte")
          ? "Svelte"
          : has("vue")
            ? "Vue"
            : has("preact")
              ? "Preact"
              : has("solid-js")
                ? "Solid"
                : has("react")
                  ? "React"
                  : has("vite")
                    ? "Vite"
                    : paths.some((path) => path.toLowerCase() === "index.html")
                      ? "Static"
                      : "Node.js";
  const language = paths.some((path) => /\.tsx?$/i.test(path))
    ? "TypeScript"
    : paths.some((path) => /\.(?:jsx?|mjs|cjs)$/i.test(path))
      ? "JavaScript"
      : "HTML/CSS";
  const tests = [
    ["vitest", "Vitest"],
    ["jest", "Jest"],
    ["@playwright/test", "Playwright"],
    ["cypress", "Cypress"],
  ]
    .filter(([dependency]) => has(dependency))
    .map(([, label]) => label);
  const designSystem = designState?.appliedSystem?.name;
  const autoTags = normalizeTemplateTags([
    framework.toLowerCase(),
    language.toLowerCase(),
    ...tests.map((test) => test.toLowerCase()),
    ...(designSystem ? [designSystem.toLowerCase()] : []),
  ]);
  return { framework, language, tests, designSystem, autoTags };
}

function parsePackageJson(
  content: string | undefined,
): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function digestTemplateContent(value: {
  files: ProjectFiles;
  template: string;
  previewMode: string;
  activeFile?: string;
  designState?: ConversationDesignState;
}): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to prepare a project template.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [key, stableValue(record[key])]),
  );
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}
