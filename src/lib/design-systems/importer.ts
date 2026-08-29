import JSZip from "jszip";
import {
  assertSafeDesignSystemPath,
  canonicalDesignSystemFiles,
  DESIGN_SYSTEM_LIMITS,
  validateDesignSystemPackage,
  type DesignSystemInputFile,
  type DesignSystemPackage,
} from "./validation";
import type { DesignSystemSource } from "../../types";

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_BYTES = 22;
const CENTRAL_BYTES = 46;
const MAX_COMMENT_BYTES = 0xffff;

export interface StagedDesignSystemImport {
  package: DesignSystemPackage;
  summary: {
    id: string;
    name: string;
    digest: string;
    designBytes: number;
    tokenBytes: number;
  };
}

function stripCommonPrefix(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const split = paths.map((path) => path.split("/"));
  let common = 0;
  while (
    common < split[0].length - 1 &&
    split.every(
      (segments) =>
        segments.length > common + 1 && segments[common] === split[0][common],
    )
  ) {
    common += 1;
  }
  return split.map((segments) => segments.slice(common).join("/"));
}

function inspectZip(buffer: ArrayBuffer): string[] {
  if (buffer.byteLength > DESIGN_SYSTEM_LIMITS.maxPackageBytes) {
    throw new Error("Design-system ZIP exceeds the 2 MB limit.");
  }
  if (buffer.byteLength < END_BYTES) {
    throw new Error("Invalid design-system ZIP central directory.");
  }
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const searchStart = bytes.byteLength - END_BYTES;
  const searchEnd = Math.max(0, searchStart - MAX_COMMENT_BYTES);
  let endOffset = -1;
  for (let offset = searchStart; offset >= searchEnd; offset -= 1) {
    if (view.getUint32(offset, true) !== END_SIGNATURE) continue;
    const commentBytes = view.getUint16(offset + 20, true);
    if (offset + END_BYTES + commentBytes === bytes.byteLength) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0)
    throw new Error("Invalid design-system ZIP central directory.");
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (disk || centralDisk || diskEntries !== entryCount) {
    throw new Error("Multi-disk design-system ZIPs are unsupported.");
  }
  if (entryCount > DESIGN_SYSTEM_LIMITS.maxEntries) {
    throw new Error("Design-system ZIP contains too many entries.");
  }
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("Invalid design-system ZIP central directory bounds.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  let totalUncompressed = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + CENTRAL_BYTES > endOffset ||
      view.getUint32(offset, true) !== CENTRAL_SIGNATURE
    ) {
      throw new Error("Invalid design-system ZIP entry.");
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    if (flags & 1)
      throw new Error("Encrypted design-system ZIPs are unsupported.");
    if (compression !== 0 && compression !== 8) {
      throw new Error("Unsupported design-system ZIP compression method.");
    }
    if (((externalAttributes >>> 16) & 0o170000) === 0o120000) {
      throw new Error("Design-system ZIPs cannot contain symbolic links.");
    }
    const recordBytes = CENTRAL_BYTES + nameBytes + extraBytes + commentBytes;
    if (offset + recordBytes > endOffset) {
      throw new Error("Invalid design-system ZIP entry bounds.");
    }
    const nameStart = offset + CENTRAL_BYTES;
    const path = decoder.decode(
      bytes.subarray(nameStart, nameStart + nameBytes),
    );
    if (!path.endsWith("/")) {
      assertSafeDesignSystemPath(path);
      paths.push(path);
      totalUncompressed += uncompressed;
      if (totalUncompressed > DESIGN_SYSTEM_LIMITS.maxPackageBytes) {
        throw new Error("Expanded design-system ZIP exceeds the 2 MB limit.");
      }
    }
    offset += recordBytes;
  }
  if (offset !== endOffset)
    throw new Error("Invalid design-system ZIP layout.");
  return paths;
}

export async function stageDesignSystemFiles(
  inputFiles: readonly DesignSystemInputFile[],
  source: Extract<DesignSystemSource, "imported" | "custom"> = "imported",
): Promise<StagedDesignSystemImport> {
  const paths = stripCommonPrefix(inputFiles.map((file) => file.path));
  const normalized = inputFiles.map((file, index) => ({
    path: paths[index],
    content: file.content,
  }));
  const validated = await validateDesignSystemPackage(normalized, {
    source,
    version: source,
  });
  const pkg = await validateDesignSystemPackage(
    canonicalDesignSystemFiles(validated),
    { source, version: source },
  );
  const encoder = new TextEncoder();
  return {
    package: pkg,
    summary: {
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      digest: pkg.digest,
      designBytes: encoder.encode(pkg.design).byteLength,
      tokenBytes: encoder.encode(pkg.tokens).byteLength,
    },
  };
}

export async function stageDesignSystemZip(
  buffer: ArrayBuffer,
): Promise<StagedDesignSystemImport> {
  const inspectedPaths = inspectZip(buffer);
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const files: DesignSystemInputFile[] = [];
  for (const path of inspectedPaths) {
    const entry = zip.file(path);
    if (!entry)
      throw new Error(`ZIP entry "${path}" disappeared during import.`);
    const bytes = await entry.async("uint8array");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Design-system file "${path}" is not valid UTF-8 text.`);
    }
    files.push({ path, content });
  }
  return stageDesignSystemFiles(files);
}

export async function stageDesignSystemDirectory(
  browserFiles: readonly File[],
): Promise<StagedDesignSystemImport> {
  if (browserFiles.length > DESIGN_SYSTEM_LIMITS.maxEntries) {
    throw new Error("Design-system directory contains too many files.");
  }
  let totalBytes = 0;
  const files: DesignSystemInputFile[] = [];
  for (const file of browserFiles) {
    totalBytes += file.size;
    if (totalBytes > DESIGN_SYSTEM_LIMITS.maxPackageBytes) {
      throw new Error("Design-system directory exceeds the 2 MB limit.");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
    } catch {
      throw new Error(
        `Design-system file "${file.name}" is not valid UTF-8 text.`,
      );
    }
    files.push({
      path: file.webkitRelativePath || file.name,
      content,
    });
  }
  return stageDesignSystemFiles(files);
}
