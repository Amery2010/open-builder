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
  /** SHA-256 of the normalized path and content digest. */
  moduleDigest: string;
}

const projectAssetBlobs = localforage.createInstance({
  name: "open-builder",
  storeName: "project-assets",
  description: "Content-addressed binary project assets",
});

let projectAssetOwnershipTail: Promise<void> = Promise.resolve();

/** Serializes same-context durable owner changes and explicit global clearing.
 * This does not claim cross-tab exclusion; opportunistic Blob reclamation is
 * deliberately disabled below because it needs a durable multi-store lock. */
export function withProjectAssetOwnershipLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = projectAssetOwnershipTail.then(operation, operation);
  projectAssetOwnershipTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (
    bytes.length >= 6 &&
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 1 &&
    bytes[3] === 0 &&
    (bytes[4] !== 0 || bytes[5] !== 0)
  )
    return "image/x-icon";
  if (
    bytes.length >= 16 &&
    String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp"
  ) {
    const boxSize = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint32(0);
    if (boxSize >= 16 && boxSize <= bytes.length) {
      for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
        if (offset === 12) continue;
        const brand = String.fromCharCode(
          ...bytes.subarray(offset, offset + 4),
        );
        if (brand === "avif" || brand === "avis") return "image/avif";
      }
    }
  }
  if (bytes.length >= 12) {
    const fontSignature = signature.slice(0, 4);
    if (fontSignature === "wOFF" && bytes.length >= 44) return "font/woff";
    if (fontSignature === "wOF2" && bytes.length >= 48) return "font/woff2";
    if (fontSignature === "OTTO") return "font/otf";
    if (
      fontSignature === "true" ||
      (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
    )
      return "font/ttf";
  }
  return null;
}

export function projectAssetMimeTypeForPath(
  path: string,
): ProjectAssetMimeType | null {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "ico") return "image/x-icon";
  if (extension === "avif") return "image/avif";
  if (extension === "woff") return "font/woff";
  if (extension === "woff2") return "font/woff2";
  if (extension === "ttf") return "font/ttf";
  if (extension === "otf") return "font/otf";
  return null;
}

export function normalizeProjectAssetPath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (
    !normalized ||
    path.includes("\\") ||
    /[?#]/.test(normalized) ||
    /^[a-zA-Z]:\//.test(normalized) ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized) ||
    normalized.length > PROJECT_FILE_LIMITS.maxPathChars ||
    parts.length > PROJECT_FILE_LIMITS.maxPathDepth ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe project asset path: "${path}".`);
  }
  if (!projectAssetMimeTypeForPath(normalized)) {
    throw new Error(
      "Project asset must use a supported image or web font file name.",
    );
  }
  return normalized;
}

function validateAssetRecordForPublicPath(
  path: string,
  asset: ProjectAsset,
  expectedPublicPath: string,
): boolean {
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
      asset.publicPath === expectedPublicPath
    );
  } catch {
    return false;
  }
}

function validateAssetRecord(path: string, asset: ProjectAsset): boolean {
  return validateAssetRecordForPublicPath(
    path,
    asset,
    projectAssetPublicPath(path),
  );
}

function normalizeAssetRecord(
  path: string,
  asset: ProjectAsset,
): ProjectAsset | null {
  if (validateAssetRecord(path, asset)) return asset;
  // Pre-v3 source assets used an absolute URL even though their exported file
  // lived outside public/. Preserve their stable module path and ownership,
  // then upgrade only the URL contract used by the managed module.
  if (
    !path.startsWith("public/") &&
    validateAssetRecordForPublicPath(path, asset, `/${path}`)
  ) {
    return { ...asset, publicPath: "" };
  }
  return null;
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
    const asset = normalizeAssetRecord(path, candidate as ProjectAsset);
    if (!asset) {
      changed = true;
      continue;
    }
    if (asset !== candidate) changed = true;
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
  const publicPaths = new Set<string>();
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
    if (asset.publicPath) {
      if (publicPaths.has(asset.publicPath)) {
        return {
          ok: false,
          error: `Multiple project assets use public URL "${asset.publicPath}".`,
        };
      }
      publicPaths.add(asset.publicPath);
    }
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
      `Project asset "${normalizedPath}" does not match its file type.`,
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
  const digest = await sha256(bytes);
  return {
    path: normalizedPath,
    blob: new Blob([Uint8Array.from(bytes).buffer], { type: detectedMimeType }),
    mimeType: detectedMimeType,
    size: bytes.byteLength,
    digest,
    moduleDigest: await sha256(
      new TextEncoder().encode(`${normalizedPath}\u0000${digest}`),
    ),
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
  invalid: number;
}> {
  let count = 0;
  let bytes = 0;
  let invalid = 0;
  await projectAssetBlobs.iterate<unknown, void>((value) => {
    count += 1;
    if (value instanceof Blob && Number.isFinite(value.size)) {
      bytes += value.size;
    } else {
      invalid += 1;
    }
  });
  return { count, bytes, invalid };
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

export function releaseUnreferencedProjectAssetBlobs(
  candidateRefs: Iterable<string>,
  retainedCollections:
    | readonly (ProjectAssets | undefined)[]
    | (() => readonly (ProjectAssets | undefined)[] | null),
): Promise<void> {
  // Conversation, snapshot, and Starter owners live in separate durable
  // stores and may be open in another tab. A memory-only reference snapshot
  // cannot prove that a Blob is unowned without racing an owner commit. Keep
  // candidates until the explicit Clear All flow has durably removed every
  // owner domain; storage estimation makes the retained bytes visible.
  void candidateRefs;
  void retainedCollections;
  return Promise.resolve();
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
  return path.startsWith("public/") ? `/${path.slice(7)}` : "";
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
    modulePath: `src/generated-assets/${safeModuleStem(staged.path)}-${staged.moduleDigest}.js`,
    publicPath: projectAssetPublicPath(staged.path),
  };
}

export function createProjectAssetModule(asset: ProjectAsset): string {
  const body = asset.publicPath
    ? `export default ${JSON.stringify(asset.publicPath)};`
    : `export { default } from ${JSON.stringify(relativeModuleSpecifier(asset.modulePath, asset.path))};`;
  return `// Managed by Open Builder for ${asset.path}.\n${body}\n`;
}

function createLegacySourceAssetModule(asset: ProjectAsset): string {
  return (
    `// Managed by Open Builder for ${asset.path}.\n` +
    `export default ${JSON.stringify(`/${asset.path}`)};\n`
  );
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
    if (
      existing !== undefined &&
      existing !== content &&
      !(!asset.publicPath && existing === createLegacySourceAssetModule(asset))
    ) {
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

interface PreviewAssetProjection {
  asset: ProjectAsset;
  dataUrl: string;
}

interface SourceReplacement {
  start: number;
  end: number;
  value: string;
}

interface JavaScriptToken {
  kind: "word" | "punctuation" | "string";
  value: string;
  start: number;
  end: number;
  escaped?: boolean;
}

function normalizeRelativePath(
  fromPath: string,
  reference: string,
): string | null {
  const base = fromPath.split("/").slice(0, -1);
  for (const part of reference.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(part);
  }
  return base.join("/");
}

function resolvePreviewAsset(
  sourcePath: string,
  reference: string,
  projections: readonly PreviewAssetProjection[],
): PreviewAssetProjection | undefined {
  if (!reference || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(reference)) {
    return undefined;
  }
  const withoutSuffix = reference.replace(/[?#].*$/, "");
  if (!withoutSuffix) return undefined;

  if (withoutSuffix.startsWith("/")) {
    return projections.find(
      ({ asset }) => asset.publicPath && asset.publicPath === withoutSuffix,
    );
  }

  const candidate = withoutSuffix.startsWith("@/")
    ? `src/${withoutSuffix.slice(2)}`
    : withoutSuffix.startsWith("./") || withoutSuffix.startsWith("../")
      ? normalizeRelativePath(sourcePath, withoutSuffix)
      : withoutSuffix;
  if (!candidate) return undefined;
  return (
    projections.find(({ asset }) => asset.path === candidate) ??
    projections.find(
      ({ asset }) =>
        asset.publicPath && asset.publicPath.slice(1) === candidate,
    )
  );
}

function relativeModuleSpecifier(fromPath: string, modulePath: string): string {
  const from = fromPath.split("/").slice(0, -1);
  const to = modulePath.split("/");
  let shared = 0;
  while (
    shared < from.length &&
    shared < to.length &&
    from[shared] === to[shared]
  ) {
    shared += 1;
  }
  const relative = [
    ...Array.from({ length: from.length - shared }, () => ".."),
    ...to.slice(shared),
  ].join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function applySourceReplacements(
  source: string,
  replacements: readonly SourceReplacement[],
): string {
  let output = source;
  for (const replacement of [...replacements].sort(
    (left, right) => right.start - left.start,
  )) {
    output =
      output.slice(0, replacement.start) +
      replacement.value +
      output.slice(replacement.end);
  }
  return output;
}

function scanJavaScriptTokens(
  source: string,
  recognizeComments = true,
): JavaScriptToken[] {
  const tokens: JavaScriptToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (recognizeComments && character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (recognizeComments && character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      const start = index + 1;
      let escaped = false;
      let dynamicTemplate = false;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          escaped = true;
          index += 2;
          continue;
        }
        if (
          quote === "`" &&
          source[index] === "$" &&
          source[index + 1] === "{"
        ) {
          dynamicTemplate = true;
        }
        if (source[index] === quote) break;
        index += 1;
      }
      const end = index;
      if (index < source.length) index += 1;
      tokens.push({
        kind: "string",
        value: source.slice(start, end),
        start,
        end,
        escaped: escaped || dynamicTemplate,
      });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) {
        index += 1;
      }
      tokens.push({
        kind: "word",
        value: source.slice(start, index),
        start,
        end: index,
      });
      continue;
    }
    tokens.push({
      kind: "punctuation",
      value: character,
      start: index,
      end: index + 1,
    });
    index += 1;
  }
  return tokens;
}

function isModuleSpecifier(tokens: readonly JavaScriptToken[], index: number) {
  const previous = tokens[index - 1];
  const beforePrevious = tokens[index - 2];
  return (
    previous?.value === "from" ||
    previous?.value === "import" ||
    (previous?.value === "(" &&
      (beforePrevious?.value === "import" ||
        beforePrevious?.value === "require"))
  );
}

function rewriteJavaScriptAssetReferences(
  sourcePath: string,
  source: string,
  projections: readonly PreviewAssetProjection[],
  recognizeComments = true,
): string {
  const tokens = scanJavaScriptTokens(source, recognizeComments);
  const replacements: SourceReplacement[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "string" || token.escaped) return;
    const projection = resolvePreviewAsset(
      sourcePath,
      token.value,
      projections,
    );
    if (!projection) return;
    replacements.push({
      start: token.start,
      end: token.end,
      value: isModuleSpecifier(tokens, index)
        ? relativeModuleSpecifier(sourcePath, projection.asset.modulePath)
        : projection.dataUrl,
    });
  });
  return applySourceReplacements(source, replacements);
}

function rewriteCssAssetReferences(
  sourcePath: string,
  source: string,
  projections: readonly PreviewAssetProjection[],
): string {
  const replacements: SourceReplacement[] = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === '"' || source[index] === "'") {
      const quote = source[index++];
      while (index < source.length && source[index] !== quote) {
        index += source[index] === "\\" ? 2 : 1;
      }
      if (index < source.length) index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (
      source.slice(index, index + 3).toLowerCase() !== "url" ||
      /[A-Za-z0-9_-]/.test(source[index - 1] ?? "")
    ) {
      index += 1;
      continue;
    }
    let cursor = index + 3;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "(") {
      index += 3;
      continue;
    }
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    const quote =
      source[cursor] === '"' || source[cursor] === "'"
        ? source[cursor++]
        : undefined;
    const valueStart = cursor;
    if (quote) {
      while (cursor < source.length && source[cursor] !== quote) {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
    } else {
      while (cursor < source.length && source[cursor] !== ")") cursor += 1;
    }
    const rawEnd = cursor;
    const raw = source.slice(valueStart, rawEnd);
    const leadingWhitespace = raw.length - raw.trimStart().length;
    const trailingWhitespace = raw.length - raw.trimEnd().length;
    const reference = raw.trim();
    const projection = resolvePreviewAsset(sourcePath, reference, projections);
    if (projection && !reference.includes("\\")) {
      replacements.push({
        start: valueStart + leadingWhitespace,
        end: rawEnd - trailingWhitespace,
        value: projection.dataUrl,
      });
    }
    index = cursor < source.length ? cursor + 1 : cursor;
  }
  return applySourceReplacements(source, replacements);
}

function rewriteMarkupSrcsetReferences(
  sourcePath: string,
  source: string,
  projections: readonly PreviewAssetProjection[],
): string {
  return source.replace(
    /(\bsrcset\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (match, prefix: string, quote: string, value: string) => {
      const rewritten = value
        .split(",")
        .map((candidate) => {
          const parts = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate);
          if (!parts) return candidate;
          const projection = resolvePreviewAsset(
            sourcePath,
            parts[2],
            projections,
          );
          return projection
            ? `${parts[1]}${projection.dataUrl}${parts[3]}`
            : candidate;
        })
        .join(",");
      return rewritten === value
        ? match
        : `${prefix}${quote}${rewritten}${quote}`;
    },
  );
}

function rewriteUnquotedMarkupAssetReferences(
  sourcePath: string,
  source: string,
  projections: readonly PreviewAssetProjection[],
): string {
  return source.replace(
    /(\b(?:src|href|poster)\s*=\s*)([^\s"'`=<>]+)/gi,
    (match, prefix: string, reference: string) => {
      const projection = resolvePreviewAsset(
        sourcePath,
        reference,
        projections,
      );
      return projection ? `${prefix}${projection.dataUrl}` : match;
    },
  );
}

function rewriteMarkupAssetReferences(
  sourcePath: string,
  source: string,
  projections: readonly PreviewAssetProjection[],
): string {
  const srcsetProjected = rewriteMarkupSrcsetReferences(
    sourcePath,
    source,
    projections,
  );
  const unquotedProjected = rewriteUnquotedMarkupAssetReferences(
    sourcePath,
    srcsetProjected,
    projections,
  );
  // Markup is not JavaScript lexical space: `//` can occur in plain URL text.
  // Reuse only the bounded literal/module replacement pass with comment
  // recognition disabled.
  return rewriteJavaScriptAssetReferences(
    sourcePath,
    unquotedProjected,
    projections,
    false,
  );
}

function projectSourceForPreview(
  sourcePath: string,
  source: string,
  projections: readonly PreviewAssetProjection[],
): string {
  const extension = sourcePath.split(".").pop()?.toLowerCase();
  if (["css", "scss", "sass", "less"].includes(extension ?? "")) {
    return rewriteCssAssetReferences(sourcePath, source, projections);
  }
  if (["html", "vue", "svelte", "astro", "mdx"].includes(extension ?? "")) {
    return rewriteMarkupAssetReferences(sourcePath, source, projections);
  }
  if (
    ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"].includes(
      extension ?? "",
    )
  ) {
    return rewriteJavaScriptAssetReferences(sourcePath, source, projections);
  }
  return source;
}

export async function projectFilesForSandpack(
  files: ProjectFiles,
  assets: ProjectAssets,
  readBytes: (
    asset: ProjectAsset,
  ) => Promise<Uint8Array> = readProjectAssetBytes,
): Promise<ProjectFiles> {
  const validation = validateProjectAssets(assets);
  if (!validation.ok) throw new Error(validation.error);
  const dataUrls = new Map<string, Promise<string>>();
  const projections = await Promise.all(
    Object.values(assets).map(async (asset) => {
      const cacheKey = [asset.blobRef, asset.mimeType, String(asset.size)].join(
        ":",
      );
      let dataUrl = dataUrls.get(cacheKey);
      if (!dataUrl) {
        dataUrl = readBytes(asset).then((bytes) =>
          blobToDataUrl(
            new Blob([Uint8Array.from(bytes).buffer], {
              type: asset.mimeType,
            }),
            asset.mimeType,
          ),
        );
        dataUrls.set(cacheKey, dataUrl);
      }
      return { asset, dataUrl: await dataUrl };
    }),
  );
  const derived = Object.fromEntries(
    Object.entries(files).map(([path, source]) => [
      path,
      projectSourceForPreview(path, source, projections),
    ]),
  );
  for (const { asset, dataUrl } of projections) {
    derived[asset.modulePath] =
      `// Preview-only project asset.\nexport default ${JSON.stringify(dataUrl)};\n`;
  }
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

export async function verifyProjectAssetBlobs(
  assets: ProjectAssets,
): Promise<void> {
  const validation = validateProjectAssets(assets);
  if (!validation.ok) throw new Error(validation.error);
  await Promise.all(Object.values(assets).map(readProjectAssetBytes));
}
