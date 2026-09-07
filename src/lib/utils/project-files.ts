import type { ProjectFiles } from "../../types";
import { hasUnsafeProjectPathCharacters } from "./project-file-policy";

export const PROJECT_FILE_LIMITS = {
  maxFiles: 1_000,
  maxTotalBytes: 12 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxPathChars: 240,
  maxPathDepth: 24,
  maxPromptFiles: 300,
} as const;

export interface ProjectFilesStats {
  fileCount: number;
  totalBytes: number;
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length;
}

export function getProjectFilesStats(files: ProjectFiles): ProjectFilesStats {
  let totalBytes = 0;
  for (const content of Object.values(files)) {
    totalBytes += byteLength(content);
  }
  return { fileCount: Object.keys(files).length, totalBytes };
}

function validateProjectPath(path: string): string | null {
  if (!path) return "file path must not be empty";
  if (hasUnsafeProjectPathCharacters(path)) {
    return "file path must not contain control characters";
  }
  if (path.length > PROJECT_FILE_LIMITS.maxPathChars) {
    return `file path is too long (max ${PROJECT_FILE_LIMITS.maxPathChars} characters): ${path}`;
  }
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    return `absolute project file paths are not allowed: ${path}`;
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length > PROJECT_FILE_LIMITS.maxPathDepth) {
    return `file path is too deep (max ${PROJECT_FILE_LIMITS.maxPathDepth} segments): ${path}`;
  }
  if (parts.some((part) => part === "." || part === "..")) {
    return `unsafe project file path: ${path}`;
  }
  return null;
}

export function validateProjectFiles(files: ProjectFiles):
  | {
      ok: true;
      stats: ProjectFilesStats;
    }
  | {
      ok: false;
      error: string;
      stats: ProjectFilesStats;
    } {
  const entries = Object.entries(files);
  const stats: ProjectFilesStats = { fileCount: entries.length, totalBytes: 0 };

  if (entries.length > PROJECT_FILE_LIMITS.maxFiles) {
    return {
      ok: false,
      error: `Project has too many files (max ${PROJECT_FILE_LIMITS.maxFiles}).`,
      stats,
    };
  }

  for (const [path, content] of entries) {
    const pathError = validateProjectPath(path);
    if (pathError) return { ok: false, error: pathError, stats };
    if (typeof content !== "string") {
      return {
        ok: false,
        error: `Project file "${path}" must contain text content.`,
        stats,
      };
    }
    const size = byteLength(content);
    if (size > PROJECT_FILE_LIMITS.maxFileBytes) {
      return {
        ok: false,
        error: `Project file "${path}" is too large (max ${PROJECT_FILE_LIMITS.maxFileBytes} bytes).`,
        stats,
      };
    }
    stats.totalBytes += size;
    if (stats.totalBytes > PROJECT_FILE_LIMITS.maxTotalBytes) {
      return {
        ok: false,
        error: `Project files are too large in total (max ${PROJECT_FILE_LIMITS.maxTotalBytes} bytes).`,
        stats,
      };
    }
  }

  return { ok: true, stats };
}

/** Discard malformed persisted entries before any renderer or prompt
 * projection can assume that ProjectFiles contains text. Valid records retain
 * their original object identity to avoid unnecessary store updates. */
export function normalizeProjectFiles(value: unknown): ProjectFiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  const files: ProjectFiles = {};
  let totalBytes = 0;
  let changed = false;

  for (const [path, content] of entries) {
    if (
      typeof content !== "string" ||
      validateProjectPath(path) !== null ||
      Object.keys(files).length >= PROJECT_FILE_LIMITS.maxFiles
    ) {
      changed = true;
      continue;
    }
    const size = byteLength(content);
    if (
      size > PROJECT_FILE_LIMITS.maxFileBytes ||
      totalBytes + size > PROJECT_FILE_LIMITS.maxTotalBytes
    ) {
      changed = true;
      continue;
    }
    files[path] = content;
    totalBytes += size;
  }

  return !changed && entries.length === Object.keys(files).length
    ? (value as ProjectFiles)
    : files;
}

export function buildProjectFilesPromptListing(files: ProjectFiles): string {
  const paths = Object.keys(files).sort();
  if (paths.length === 0) return "\n\nThe project is empty - no files yet.";

  const shown = paths.slice(0, PROJECT_FILE_LIMITS.maxPromptFiles);
  const hidden = paths.length - shown.length;
  const header =
    hidden > 0
      ? `\n\nCurrent project files (${paths.length}, showing first ${shown.length}):\n`
      : "\n\nCurrent project files:\n";
  const suffix =
    hidden > 0
      ? `\n- ... ${hidden} more files omitted from prompt; use list_files/search_in_files for the full tree.`
      : "";
  const quotedPaths = shown.map((path) => {
    const quoted = JSON.stringify(path);
    return quoted.replace(
      /[\u007f-\u009f\u2028\u2029]/gu,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  });
  return header + quotedPaths.map((path) => `- ${path}`).join("\n") + suffix;
}
