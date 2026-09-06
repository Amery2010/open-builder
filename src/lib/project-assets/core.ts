import localforage from "localforage";
import type {
  ProjectAsset,
  ProjectAssets,
  ProjectAssetMimeType,
  ProjectFiles,
} from "../../types";
import { DEFAULT_ATTACHMENT_CONSTRAINTS } from "../utils/attachments";
import {
  PROJECT_FILE_LIMITS,
  validateProjectFiles,
} from "../utils/project-files";

export const PROJECT_ASSET_LIMITS = {
  maxAssets: 100,
  maxAssetBytes: DEFAULT_ATTACHMENT_CONSTRAINTS.maxImageBytes,
  maxTotalBytes: 64 * 1024 * 1024,
} as const;

export interface StagedProjectAsset {
  path: string;
  blob: Blob;
  mimeType: ProjectAssetMimeType;
  size: number;
  digest: string;
}

const projectAssetBlobs = localforage.createInstance({
  name: "open-builder",
  storeName: "project-assets",
  description: "Content-addressed binary project assets",
});

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const ownedBytes = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    ownedBytes.buffer,
  );
  return bytesToHex(new Uint8Array(digest));
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

export function detectProjectAssetMimeType(
  bytes: Uint8Array,
): ProjectAssetMimeType | null {
  if (isPng(bytes)) return "image/png";
  if (isJpeg(bytes)) return "image/jpeg";
  if (isWebp(bytes)) return "image/webp";
  return null;
}

export function projectAssetMimeTypeForPath(
  path: string,
): ProjectAssetMimeType | null {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return null;
}

export function normalizeProjectAssetPath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (
    !normalized ||
    path.includes("\\") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized) ||
    normalized.length > PROJECT_FILE_LIMITS.maxPathChars ||
    parts.length > PROJECT_FILE_LIMITS.maxPathDepth ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe project asset path: "${path}".`);
  }
  if (!projectAssetMimeTypeForPath(normalized)) {
    throw new Error("Project assets must use a PNG, JPEG, or WebP file name.");
  }
  return normalized;
}

function validateAssetRecord(path: string, asset: ProjectAsset): boolean {
  try {
    const moduleParts = asset.modulePath.split("/");
    return (
      normalizeProjectAssetPath(path) === path &&
      asset.path === path &&
      typeof asset.blobRef === "string" &&
      asset.blobRef === `sha256:${asset.digest}` &&
      /^[a-f0-9]{64}$/.test(asset.digest) &&
      projectAssetMimeTypeForPath(path) === asset.mimeType &&
      Number.isInteger(asset.size) &&
      asset.size > 0 &&
      asset.size <= PROJECT_ASSET_LIMITS.maxAssetBytes &&
      typeof asset.modulePath === "string" &&
      asset.modulePath.startsWith("src/generated-assets/") &&
      asset.modulePath.endsWith(".js") &&
      asset.modulePath.length <= PROJECT_FILE_LIMITS.maxPathChars &&
      !asset.modulePath.includes("\\") &&
      !moduleParts.some((part) => !part || part === "." || part === "..") &&
      typeof asset.publicPath === "string" &&
      asset.publicPath === projectAssetPublicPath(path)
    );
  } catch {
    return false;
  }
}

export function normalizeProjectAssets(value: unknown): ProjectAssets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const assets: ProjectAssets = {};
  let totalBytes = 0;
  let changed = false;
  for (const [path, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== "object") {
      changed = true;
      continue;
    }
    const asset = candidate as ProjectAsset;
    if (!validateAssetRecord(path, asset)) {
      changed = true;
      continue;
    }
    totalBytes += asset.size;
    if (
      Object.keys(assets).length >= PROJECT_ASSET_LIMITS.maxAssets ||
      totalBytes > PROJECT_ASSET_LIMITS.maxTotalBytes
    ) {
      changed = true;
      break;
    }
    assets[path] = asset;
  }
  return !changed && Object.keys(assets).length === Object.keys(value).length
    ? (value as ProjectAssets)
    : assets;
}

export function validateProjectAssets(
  assets: ProjectAssets,
): { ok: true; totalBytes: number } | { ok: false; error: string } {
  const entries = Object.entries(assets);
  if (entries.length > PROJECT_ASSET_LIMITS.maxAssets) {
    return {
      ok: false,
      error: `Project has too many assets (max ${PROJECT_ASSET_LIMITS.maxAssets}).`,
    };
  }
  let totalBytes = 0;
  const modulePaths = new Set<string>();
  for (const [path, asset] of entries) {
    if (!validateAssetRecord(path, asset)) {
      return { ok: false, error: `Project asset "${path}" is invalid.` };
    }
    if (modulePaths.has(asset.modulePath)) {
      return {
        ok: false,
        error: `Multiple project assets use module "${asset.modulePath}".`,
      };
    }
    modulePaths.add(asset.modulePath);
    totalBytes += asset.size;
    if (totalBytes > PROJECT_ASSET_LIMITS.maxTotalBytes) {
      return {
        ok: false,
        error: `Project assets exceed ${PROJECT_ASSET_LIMITS.maxTotalBytes} bytes.`,
      };
    }
  }
  return { ok: true, totalBytes };
}

export async function stageProjectAsset(
  path: string,
  blob: Blob,
  declaredMimeType?: string,
): Promise<StagedProjectAsset> {
  const normalizedPath = normalizeProjectAssetPath(path);
  if (blob.size <= 0 || blob.size > PROJECT_ASSET_LIMITS.maxAssetBytes) {
    throw new Error(
      `Project asset "${normalizedPath}" must be between 1 and ${PROJECT_ASSET_LIMITS.maxAssetBytes} bytes.`,
    );
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const detectedMimeType = detectProjectAssetMimeType(bytes);
  const pathMimeType = projectAssetMimeTypeForPath(normalizedPath);
  if (!detectedMimeType || detectedMimeType !== pathMimeType) {
    throw new Error(
      `Project asset "${normalizedPath}" does not match its image file type.`,
    );
  }
  if (
    declaredMimeType &&
    declaredMimeType !== "application/octet-stream" &&
    declaredMimeType !== detectedMimeType
  ) {
    throw new Error(
      `Project asset "${normalizedPath}" does not match its declared MIME type.`,
    );
  }
  return {
    path: normalizedPath,
    blob: new Blob([Uint8Array.from(bytes).buffer], { type: detectedMimeType }),
    mimeType: detectedMimeType,
    size: bytes.byteLength,
    digest: await sha256(bytes),
  };
}

export async function storeStagedProjectAsset(
  staged: StagedProjectAsset,
): Promise<string> {
  const blobRef = `sha256:${staged.digest}`;
  const existing = await projectAssetBlobs.getItem<Blob>(blobRef);
  let validExisting = false;
  if (existing instanceof Blob && existing.size === staged.size) {
    const bytes = new Uint8Array(await existing.arrayBuffer());
    validExisting =
      detectProjectAssetMimeType(bytes) === staged.mimeType &&
      (await sha256(bytes)) === staged.digest;
  }
  if (!validExisting) await projectAssetBlobs.setItem(blobRef, staged.blob);
  return blobRef;
}

export async function getProjectAssetBlob(
  blobRef: string,
): Promise<Blob | null> {
  return projectAssetBlobs.getItem<Blob>(blobRef);
}

export async function deleteProjectAssetBlob(blobRef: string): Promise<void> {
  await projectAssetBlobs.removeItem(blobRef);
}

export async function clearProjectAssetStorage(): Promise<void> {
  await projectAssetBlobs.clear();
}

export async function estimateProjectAssetStorage(): Promise<{
  count: number;
  bytes: number;
}> {
  let count = 0;
  let bytes = 0;
  await projectAssetBlobs.iterate<Blob, void>((blob) => {
    count += 1;
    bytes += blob.size;
  });
  return { count, bytes };
}

export function collectProjectAssetBlobRefs(
  collections: readonly (ProjectAssets | undefined)[],
): Set<string> {
  return new Set(
    collections.flatMap((assets) =>
      Object.values(assets ?? {}).map((asset) => asset.blobRef),
    ),
  );
}

export async function releaseUnreferencedProjectAssetBlobs(
  candidateRefs: Iterable<string>,
  retainedCollections: readonly (ProjectAssets | undefined)[],
): Promise<void> {
  const retained = collectProjectAssetBlobRefs(retainedCollections);
  await Promise.all(
    [...new Set(candidateRefs)]
      .filter((blobRef) => !retained.has(blobRef))
      .map(deleteProjectAssetBlob),
  );
}

function safeModuleStem(path: string): string {
  const filename = path.split("/").pop() ?? "image";
  const lastDot = filename.lastIndexOf(".");
  const withoutExtension = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const stem = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return stem || "image";
}

export function projectAssetPublicPath(path: string): string {
  return path.startsWith("public/") ? `/${path.slice(7)}` : `/${path}`;
}

export function createProjectAssetRecord(
  staged: StagedProjectAsset,
  blobRef: string,
): ProjectAsset {
  return {
    path: staged.path,
    blobRef,
    mimeType: staged.mimeType,
    size: staged.size,
    digest: staged.digest,
    modulePath: `src/generated-assets/${safeModuleStem(staged.path)}-${staged.digest.slice(0, 8)}.js`,
    publicPath: projectAssetPublicPath(staged.path),
  };
}

export function createProjectAssetModule(asset: ProjectAsset): string {
  return `// Managed by Open Builder for ${asset.path}.\nexport default ${JSON.stringify(asset.publicPath)};\n`;
}

export function addProjectAssetModules(
  files: ProjectFiles,
  assets: ProjectAssets,
): ProjectFiles {
  const nextFiles = { ...files };
  for (const asset of Object.values(assets)) {
    if (nextFiles[asset.path] !== undefined) {
      throw new Error(
        `Project asset path conflicts with text file "${asset.path}".`,
      );
    }
    const content = createProjectAssetModule(asset);
    const existing = nextFiles[asset.modulePath];
    if (existing !== undefined && existing !== content) {
      throw new Error(
        `Project file "${asset.modulePath}" conflicts with a managed asset module.`,
      );
    }
    nextFiles[asset.modulePath] = content;
  }
  const validation = validateProjectFiles(nextFiles);
  if (!validation.ok) throw new Error(validation.error);
  return nextFiles;
}

export function syncProjectAssetModules(
  files: ProjectFiles,
  previousAssets: ProjectAssets,
  nextAssets: ProjectAssets,
): ProjectFiles {
  const nextFiles = { ...files };
  for (const previous of Object.values(previousAssets)) {
    if (
      !Object.values(nextAssets).some(
        (asset) => asset.modulePath === previous.modulePath,
      )
    ) {
      delete nextFiles[previous.modulePath];
    }
  }
  return addProjectAssetModules(nextFiles, nextAssets);
}

function blobToDataUrl(blob: Blob, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read project asset."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to read project asset."));
        return;
      }
      resolve(reader.result.replace(/^data:[^;,]*;/, `data:${mimeType};`));
    };
    reader.readAsDataURL(blob);
  });
}

export async function projectFilesForSandpack(
  files: ProjectFiles,
  assets: ProjectAssets,
): Promise<ProjectFiles> {
  const derived = { ...files };
  await Promise.all(
    Object.values(assets).map(async (asset) => {
      const blob = await getProjectAssetBlob(asset.blobRef);
      if (!blob) {
        throw new Error(
          `Project asset "${asset.path}" is unavailable locally.`,
        );
      }
      const dataUrl = await blobToDataUrl(blob, asset.mimeType);
      derived[asset.modulePath] =
        `// Preview-only project asset.\nexport default ${JSON.stringify(dataUrl)};\n`;
    }),
  );
  return derived;
}

export async function readProjectAssetBytes(
  asset: ProjectAsset,
): Promise<Uint8Array> {
  const blob = await getProjectAssetBlob(asset.blobRef);
  if (!blob) {
    throw new Error(`Project asset "${asset.path}" is unavailable locally.`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (
    bytes.byteLength !== asset.size ||
    detectProjectAssetMimeType(bytes) !== asset.mimeType
  ) {
    throw new Error(`Project asset "${asset.path}" failed integrity checks.`);
  }
  if ((await sha256(bytes)) !== asset.digest) {
    throw new Error(`Project asset "${asset.path}" failed integrity checks.`);
  }
  return bytes;
}
