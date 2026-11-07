import JSZip from "jszip";
import type { ProjectFiles, ProjectPreviewMode } from "../../types";
import {
  hasSensitiveProjectFileContent,
  isSensitiveProjectPath,
  redactProjectFileSecrets,
} from "./project-file-policy";
import {
  getProjectFilesStats,
  PROJECT_FILE_LIMITS,
  validateProjectFiles,
} from "./project-files";
import {
  PROJECT_ASSET_LIMITS,
  projectAssetMimeTypeForPath,
  stageProjectAsset,
  type StagedProjectAsset,
} from "../project-assets/core";
import type { ProjectRuntimeValidation } from "../project-runtime";
import { assessProjectRuntime } from "../project-runtime/capabilities";

export const PROJECT_IMPORT_LIMITS = {
  maxArchiveBytes: 16 * 1024 * 1024,
  maxArchiveEntries: 4_096,
  maxCompressionRatio: 200,
} as const;

export type ProjectImportSkipReason =
  "ignored" | "sensitive" | "binary" | "symlink";

export interface ProjectImportReport {
  importedFiles: number;
  totalBytes: number;
  redactedFiles: number;
  skipped: Record<ProjectImportSkipReason, number>;
}

export interface StagedProjectImport {
  name: string;
  files: ProjectFiles;
  assets?: StagedProjectAsset[];
  template: string;
  previewMode: ProjectPreviewMode;
  activeFile?: string;
  report: ProjectImportReport;
  /** Present only after the staged files and assets pass isolated compilation. */
  validation?: ProjectRuntimeValidation;
}

export type ProjectImportCommitResult =
  { ok: true } | { ok: false; error: string };

interface SourceEntry {
  path: string;
  size: number;
  read: () => Promise<Uint8Array>;
  lastModified?: number;
  symlink?: boolean;
}

interface ZipEntryMetadata {
  archivePath: string;
  compressedBytes: number;
  uncompressedBytes: number;
  directory: boolean;
  symlink: boolean;
}

const IGNORED_PATH_SEGMENTS = new Set([
  "__macosx",
  "node_module",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".vite",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);

const SAFE_ROOT_DOTFILES = new Set([
  ".gitignore",
  ".editorconfig",
  ".prettierignore",
  ".eslintignore",
  ".stylelintignore",
  ".browserslistrc",
  ".env.example",
  ".env.sample",
  ".env.template",
]);

const SAFE_ROOT_DOTFILE_PATTERNS = [
  /^\.prettierrc(?:\.(?:json|ya?ml|js|cjs|mjs))?$/i,
  /^\.eslintrc(?:\.(?:json|ya?ml|js|cjs|mjs))?$/i,
  /^\.stylelintrc(?:\.(?:json|ya?ml|js|cjs|mjs))?$/i,
];

const BINARY_EXTENSIONS = new Set([
  "7z",
  "a",
  "avi",
  "bin",
  "bmp",
  "bz2",
  "class",
  "db",
  "dmg",
  "doc",
  "docx",
  "eot",
  "exe",
  "flac",
  "gif",
  "gz",
  "ico",
  "jar",
  "jpeg",
  "jpg",
  "lockb",
  "mov",
  "mp3",
  "mp4",
  "otf",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "rar",
  "sqlite",
  "sqlite3",
  "tar",
  "tgz",
  "ttf",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "zip",
]);

const ZIP32_END_SIGNATURE = 0x06054b50;
const ZIP32_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP32_END_BYTES = 22;
const ZIP32_CENTRAL_BYTES = 46;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP16_SENTINEL = 0xffff;
const ZIP32_SENTINEL = 0xffffffff;

function createReport(): ProjectImportReport {
  return {
    importedFiles: 0,
    totalBytes: 0,
    redactedFiles: 0,
    skipped: { ignored: 0, sensitive: 0, binary: 0, symlink: 0 },
  };
}

function incrementSkip(
  report: ProjectImportReport,
  reason: ProjectImportSkipReason,
): void {
  report.skipped[reason] += 1;
}

function normalizeProjectPath(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:\//.test(path) ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(path)
  ) {
    throw new Error(`Unsafe project path: "${path}".`);
  }
  const parts = path.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    path.length > PROJECT_FILE_LIMITS.maxPathChars ||
    parts.length > PROJECT_FILE_LIMITS.maxPathDepth
  ) {
    throw new Error(`Unsafe project path: "${path}".`);
  }
  return parts.join("/");
}

function extension(path: string): string {
  const name = path.split("/").pop() ?? "";
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

function isSafeRootDotfile(path: string): boolean {
  if (path.includes("/")) return false;
  const name = path.toLowerCase();
  return (
    SAFE_ROOT_DOTFILES.has(name) ||
    SAFE_ROOT_DOTFILE_PATTERNS.some((pattern) => pattern.test(name))
  );
}

function classifyProjectPath(
  rawPath: string,
  directory = false,
): ProjectImportSkipReason | null {
  const path = normalizeProjectPath(rawPath);
  const segments = path.toLowerCase().split("/");
  if (isSensitiveProjectPath(path)) return "sensitive";
  if (segments.some((segment) => IGNORED_PATH_SEGMENTS.has(segment))) {
    return "ignored";
  }
  if (
    segments.some((segment) => segment.startsWith(".")) &&
    (directory || !isSafeRootDotfile(path))
  ) {
    return "ignored";
  }
  if (!directory && BINARY_EXTENSIONS.has(extension(path))) return "binary";
  return null;
}

export function shouldSkipProjectDirectory(
  path: string,
): ProjectImportSkipReason | null {
  return classifyProjectPath(path, true);
}

function stripCommonRoot(paths: string[]): {
  name: string | undefined;
  paths: string[];
} {
  if (paths.length === 0) return { name: undefined, paths: [] };
  const split = paths.map((path) => path.split("/"));
  const candidate = split[0][0];
  if (
    !candidate ||
    split.some((parts) => parts.length < 2 || parts[0] !== candidate) ||
    classifyProjectPath(candidate, true) !== null
  ) {
    return { name: undefined, paths };
  }
  return {
    name: candidate,
    paths: split.map((parts) => parts.slice(1).join("/")),
  };
}

function containsBinaryBytes(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  return sample.includes(0);
}

function decodeText(bytes: Uint8Array): string | null {
  if (containsBinaryBytes(bytes)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function inferProjectPreview(files: ProjectFiles): {
  template: string;
  previewMode: ProjectPreviewMode;
} {
  const { template, previewMode } = assessProjectRuntime(files);
  return { template, previewMode };
}

function chooseActiveFile(files: ProjectFiles): string | undefined {
  const preferred = [
    "src/App.tsx",
    "src/App.jsx",
    "src/main.tsx",
    "src/main.jsx",
    "App.tsx",
    "App.jsx",
    "index.html",
    "package.json",
  ];
  return (
    preferred.find((path) => path in files) ?? Object.keys(files).sort()[0]
  );
}

function cleanProjectName(name: string): string {
  return (
    name
      .trim()
      .replace(/\.zip$/i, "")
      .slice(0, 120) || "Imported project"
  );
}

async function stageSourceEntries(
  name: string,
  entries: SourceEntry[],
  report = createReport(),
): Promise<StagedProjectImport> {
  const accepted: SourceEntry[] = [];
  const acceptedAssets: SourceEntry[] = [];
  const seen = new Set<string>();
  let declaredBytes = 0;

  for (const entry of entries) {
    const path = normalizeProjectPath(entry.path);
    if (entry.symlink) {
      incrementSkip(report, "symlink");
      continue;
    }
    const reason = classifyProjectPath(path);
    const assetMimeType = projectAssetMimeTypeForPath(path);
    if (reason && !(reason === "binary" && assetMimeType)) {
      incrementSkip(report, reason);
      continue;
    }
    if (seen.has(path)) throw new Error(`Duplicate project path: "${path}".`);
    seen.add(path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Project file "${path}" has an invalid size.`);
    }
    const maxEntryBytes = assetMimeType
      ? PROJECT_ASSET_LIMITS.maxAssetBytes
      : PROJECT_FILE_LIMITS.maxFileBytes;
    if (entry.size > maxEntryBytes) {
      throw new Error(
        `Project file "${path}" is too large (max ${maxEntryBytes} bytes).`,
      );
    }
    if (
      (!assetMimeType && accepted.length + 1 > PROJECT_FILE_LIMITS.maxFiles) ||
      (assetMimeType &&
        acceptedAssets.length + 1 > PROJECT_ASSET_LIMITS.maxAssets)
    ) {
      throw new Error(
        assetMimeType
          ? `Project has too many assets (max ${PROJECT_ASSET_LIMITS.maxAssets}).`
          : `Project has too many files (max ${PROJECT_FILE_LIMITS.maxFiles}).`,
      );
    }
    declaredBytes += entry.size;
    if (declaredBytes > PROJECT_FILE_LIMITS.maxTotalBytes) {
      throw new Error(
        `Project files are too large in total (max ${PROJECT_FILE_LIMITS.maxTotalBytes} bytes).`,
      );
    }
    (assetMimeType ? acceptedAssets : accepted).push({ ...entry, path });
  }

  const files: ProjectFiles = {};
  for (const entry of accepted) {
    const bytes = await entry.read();
    if (bytes.byteLength !== entry.size) {
      throw new Error(`Project file "${entry.path}" changed while importing.`);
    }
    const text = decodeText(bytes);
    if (text === null) {
      incrementSkip(report, "binary");
      continue;
    }
    const redacted = redactProjectFileSecrets(text);
    if (hasSensitiveProjectFileContent(text)) report.redactedFiles += 1;
    files[entry.path] = redacted;
  }

  const assets: StagedProjectAsset[] = [];
  for (const entry of acceptedAssets) {
    const bytes = await entry.read();
    if (bytes.byteLength !== entry.size) {
      throw new Error(`Project asset "${entry.path}" changed while importing.`);
    }
    const mimeType = projectAssetMimeTypeForPath(entry.path);
    const blob = new Blob([Uint8Array.from(bytes).buffer], {
      type: mimeType ?? undefined,
    });
    assets.push(
      await stageProjectAsset(entry.path, blob, mimeType ?? undefined),
    );
  }

  if (Object.keys(files).length === 0) {
    throw new Error("The selected project contains no importable text files.");
  }
  const validation = validateProjectFiles(files);
  if (!validation.ok) throw new Error(validation.error);
  const preview = inferProjectPreview(files);
  const stats = getProjectFilesStats(files);
  report.importedFiles = stats.fileCount + assets.length;
  report.totalBytes =
    stats.totalBytes + assets.reduce((sum, asset) => sum + asset.size, 0);
  return {
    name: cleanProjectName(name),
    files,
    assets,
    template: preview.template,
    previewMode: preview.previewMode,
    activeFile: chooseActiveFile(files),
    report,
  };
}

function parseZipCentralDirectory(buffer: ArrayBuffer): ZipEntryMetadata[] {
  if (buffer.byteLength > PROJECT_IMPORT_LIMITS.maxArchiveBytes) {
    throw new Error(
      `Project ZIP exceeds ${PROJECT_IMPORT_LIMITS.maxArchiveBytes} byte limit.`,
    );
  }
  if (buffer.byteLength < ZIP32_END_BYTES) {
    throw new Error("Project ZIP has an invalid central directory.");
  }
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const searchStart = bytes.byteLength - ZIP32_END_BYTES;
  const searchEnd = Math.max(0, searchStart - ZIP_MAX_COMMENT_BYTES);
  let endOffset = -1;
  for (let offset = searchStart; offset >= searchEnd; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP32_END_SIGNATURE) continue;
    const commentBytes = view.getUint16(offset + 20, true);
    if (offset + ZIP32_END_BYTES + commentBytes === bytes.byteLength) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("Project ZIP has an invalid central directory.");
  }

  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralBytes = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === ZIP16_SENTINEL ||
    centralBytes === ZIP32_SENTINEL ||
    centralOffset === ZIP32_SENTINEL
  ) {
    throw new Error("Multi-disk and ZIP64 project archives are not supported.");
  }
  if (totalEntries > PROJECT_IMPORT_LIMITS.maxArchiveEntries) {
    throw new Error(
      `Project ZIP contains too many entries (max ${PROJECT_IMPORT_LIMITS.maxArchiveEntries}).`,
    );
  }
  if (centralOffset + centralBytes !== endOffset) {
    throw new Error("Project ZIP has an invalid central directory.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntryMetadata[] = [];
  let declaredBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + ZIP32_CENTRAL_BYTES > endOffset ||
      view.getUint32(offset, true) !== ZIP32_CENTRAL_SIGNATURE
    ) {
      throw new Error("Project ZIP has an invalid central directory.");
    }
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const recordBytes =
      ZIP32_CENTRAL_BYTES + nameBytes + extraBytes + commentBytes;
    if (offset + recordBytes > endOffset) {
      throw new Error("Project ZIP has an invalid central directory.");
    }
    if (
      compressedBytes === ZIP32_SENTINEL ||
      uncompressedBytes === ZIP32_SENTINEL
    ) {
      throw new Error("ZIP64 project entries are not supported.");
    }
    let archivePath: string;
    try {
      const start = offset + ZIP32_CENTRAL_BYTES;
      archivePath = decoder.decode(bytes.subarray(start, start + nameBytes));
    } catch {
      throw new Error("Project ZIP contains an invalid UTF-8 path.");
    }
    const directory = archivePath.endsWith("/");
    if (!directory) normalizeProjectPath(archivePath);
    if (directory && (compressedBytes !== 0 || uncompressedBytes !== 0)) {
      throw new Error(
        `Project ZIP directory "${archivePath}" declares file data.`,
      );
    }
    if (
      !directory &&
      uncompressedBytes > 0 &&
      (compressedBytes === 0 ||
        uncompressedBytes / compressedBytes >
          PROJECT_IMPORT_LIMITS.maxCompressionRatio)
    ) {
      throw new Error(
        `Project ZIP entry "${archivePath}" exceeds the ${PROJECT_IMPORT_LIMITS.maxCompressionRatio}:1 compression ratio limit.`,
      );
    }
    if (!directory) {
      declaredBytes += uncompressedBytes;
      if (declaredBytes > PROJECT_FILE_LIMITS.maxTotalBytes) {
        throw new Error(
          `Project ZIP declares more than ${PROJECT_FILE_LIMITS.maxTotalBytes} uncompressed bytes.`,
        );
      }
    }
    const unixMode = externalAttributes >>> 16;
    entries.push({
      archivePath,
      compressedBytes,
      uncompressedBytes,
      directory,
      symlink: (unixMode & 0o170000) === 0o120000,
    });
    offset += recordBytes;
  }
  if (offset !== endOffset) {
    throw new Error("Project ZIP has an invalid central directory.");
  }
  return entries;
}

export async function stageProjectFromZip(
  file: Pick<File, "name" | "size" | "arrayBuffer">,
): Promise<StagedProjectImport> {
  if (file.size > PROJECT_IMPORT_LIMITS.maxArchiveBytes) {
    throw new Error(
      `Project ZIP exceeds ${PROJECT_IMPORT_LIMITS.maxArchiveBytes} byte limit.`,
    );
  }
  const buffer = await file.arrayBuffer();
  const allMetadata = parseZipCentralDirectory(buffer);
  const report = createReport();
  const metadata = allMetadata.filter((entry) => {
    if (entry.directory) return false;
    if (entry.archivePath.toLowerCase().startsWith("__macosx/")) {
      incrementSkip(report, "ignored");
      return false;
    }
    return true;
  });
  if (metadata.length === 0) throw new Error("Project ZIP contains no files.");
  const stripped = stripCommonRoot(metadata.map((entry) => entry.archivePath));
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const entries: SourceEntry[] = metadata.map((entry, index) => {
    const object = zip.file(entry.archivePath);
    if (!object) {
      throw new Error(`Project ZIP entry "${entry.archivePath}" is missing.`);
    }
    return {
      path: stripped.paths[index],
      size: entry.uncompressedBytes,
      symlink: entry.symlink,
      read: () => object.async("uint8array"),
    };
  });
  return stageSourceEntries(stripped.name ?? file.name, entries, report);
}

export async function stageProjectFromFileList(
  fileList: FileList | readonly File[],
): Promise<StagedProjectImport> {
  const files = Array.from(fileList);
  if (files.length === 0) throw new Error("No project files were selected.");
  const rawPaths = files.map((file) => file.webkitRelativePath || file.name);
  const stripped = stripCommonRoot(rawPaths);
  const entries: SourceEntry[] = files.map((file, index) => ({
    path: stripped.paths[index],
    size: file.size,
    lastModified: file.lastModified,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  }));
  return stageSourceEntries(stripped.name ?? "Imported project", entries);
}

export async function stageProjectFromDirectoryHandle(
  root: FileSystemDirectoryHandle,
): Promise<StagedProjectImport> {
  const report = createReport();
  const entries: SourceEntry[] = [];
  const rootReason = classifyProjectPath(root.name, true);
  if (rootReason) {
    incrementSkip(report, rootReason);
    return stageSourceEntries(root.name, entries, report);
  }
  async function walk(
    handle: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> {
    for await (const [name, child] of (
      handle as unknown as {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "directory") {
        const reason = classifyProjectPath(path, true);
        if (reason) {
          incrementSkip(report, reason);
          continue;
        }
        await walk(child as FileSystemDirectoryHandle, path);
        continue;
      }
      const reason = classifyProjectPath(path);
      if (
        reason &&
        !(reason === "binary" && projectAssetMimeTypeForPath(path))
      ) {
        incrementSkip(report, reason);
        continue;
      }
      const file = await (child as FileSystemFileHandle).getFile();
      entries.push({
        path,
        size: file.size,
        lastModified: file.lastModified,
        read: async () => new Uint8Array(await file.arrayBuffer()),
      });
    }
  }
  await walk(root, "");
  return stageSourceEntries(root.name, entries, report);
}

export async function stageProjectFromTauriDirectory(): Promise<StagedProjectImport | null> {
  const [dialog, fs, pathModule] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ]);
  const selection = await dialog.open({ directory: true, multiple: false });
  if (typeof selection !== "string") return null;

  const report = createReport();
  const entries: SourceEntry[] = [];
  const projectName = await pathModule.basename(selection);
  const rootReason = classifyProjectPath(projectName, true);
  if (rootReason) {
    incrementSkip(report, rootReason);
    return stageSourceEntries(projectName, entries, report);
  }
  async function walk(absolute: string, prefix: string): Promise<void> {
    for (const entry of await fs.readDir(absolute)) {
      const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymlink) {
        incrementSkip(report, "symlink");
        continue;
      }
      const childAbsolute = await pathModule.join(absolute, entry.name);
      if (entry.isDirectory) {
        const reason = classifyProjectPath(childPath, true);
        if (reason) {
          incrementSkip(report, reason);
          continue;
        }
        await walk(childAbsolute, childPath);
      } else if (entry.isFile) {
        const reason = classifyProjectPath(childPath);
        if (
          reason &&
          !(reason === "binary" && projectAssetMimeTypeForPath(childPath))
        ) {
          incrementSkip(report, reason);
          continue;
        }
        const stat = await fs.stat(childAbsolute);
        entries.push({
          path: childPath,
          size: stat.size,
          read: () => fs.readFile(childAbsolute),
        });
      }
    }
  }
  await walk(selection, "");
  return stageSourceEntries(projectName, entries, report);
}
