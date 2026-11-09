import { z } from "zod";
import type { DesignSystemRef, DesignSystemSource } from "./types.js";

export const DESIGN_SYSTEM_LIMITS = Object.freeze({
  maxPackageBytes: 2 * 1024 * 1024,
  maxManifestBytes: 64 * 1024,
  maxDesignBytes: 256 * 1024,
  maxTokensBytes: 256 * 1024,
  maxEntries: 16,
  maxPathChars: 240,
});

export const REQUIRED_SEMANTIC_TOKENS = Object.freeze([
  "--bg",
  "--surface",
  "--fg",
  "--muted",
  "--border",
  "--accent",
  "--accent-on",
  "--font-display",
  "--font-body",
  "--radius-md",
  "--section-y-desktop",
  "--container-max",
  "--motion-base",
] as const);

const manifestSchema = z.object({
  schemaVersion: z.literal("open-builder-design-system/v1"),
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(100),
  category: z.string().trim().max(100).optional(),
  description: z.string().max(2_000).optional(),
  source: z.unknown().optional(),
  files: z.object({
    design: z.string(),
    tokens: z.string(),
  }),
});

export type DesignSystemManifest = z.infer<typeof manifestSchema>;

export interface DesignSystemPackage {
  manifest: DesignSystemManifest;
  manifestText: string;
  design: string;
  tokens: string;
  digest: string;
  reference: DesignSystemRef;
}

export interface DesignSystemInputFile {
  path: string;
  content: string;
}

export function canonicalDesignSystemFiles(
  pkg: DesignSystemPackage,
): DesignSystemInputFile[] {
  const manifest = {
    ...pkg.manifest,
    files: { design: "DESIGN.md", tokens: "tokens.css" },
  };
  return [
    {
      path: "manifest.json",
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    { path: "DESIGN.md", content: pkg.design },
    { path: "tokens.css", content: pkg.tokens },
  ];
}

export function assertDesignSystemId(id: string): void {
  if (
    id.length === 0 ||
    id.length > 100 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
  ) {
    throw new Error(`Invalid design-system registry id: "${id}".`);
  }
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertSafeDesignSystemPath(path: string): void {
  if (
    !path ||
    path.length > DESIGN_SYSTEM_LIMITS.maxPathChars ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe design-system path: "${path}".`);
  }
  if (!/^[\p{L}\p{N}._/@+ -]+$/u.test(path)) {
    throw new Error(`Unsupported characters in design-system path: "${path}".`);
  }
}

function assertTextFile(path: string): void {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  if (!["json", "md", "css", "txt"].includes(extension)) {
    throw new Error(
      `Design-system packages cannot contain scripts or binary files: "${path}".`,
    );
  }
}

export function validateSemanticTokensCss(tokens: string): void {
  const withoutComments = tokens.replace(/\/\*[\s\S]*?\*\//g, "");
  if (
    /@(?:import|charset|namespace|supports|media|layer|keyframes)\b/i.test(
      withoutComments,
    ) ||
    /(?:url\s*\(|expression\s*\(|javascript\s*:|<\/?style\b|behavior\s*:|-moz-binding)/i.test(
      withoutComments,
    )
  ) {
    throw new Error(
      "tokens.css contains unsupported executable or external CSS.",
    );
  }
  const rootStart = withoutComments.search(/:root\s*\{/);
  if (rootStart < 0) throw new Error("tokens.css must contain a :root block.");
  const openBrace = withoutComments.indexOf("{", rootStart);
  let depth = 0;
  let closeBrace = -1;
  for (let index = openBrace; index < withoutComments.length; index += 1) {
    if (withoutComments[index] === "{") depth += 1;
    if (withoutComments[index] === "}") depth -= 1;
    if (depth === 0) {
      closeBrace = index;
      break;
    }
  }
  if (closeBrace < 0)
    throw new Error("tokens.css has an unclosed :root block.");
  if (
    withoutComments.slice(0, rootStart).trim() ||
    withoutComments.slice(closeBrace + 1).trim()
  ) {
    throw new Error(
      "tokens.css may contain only comments and one :root block.",
    );
  }
  const body = withoutComments.slice(openBrace + 1, closeBrace);
  const found = new Set<string>();
  const declarationPattern = /(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = declarationPattern.exec(body))) {
    if (match[2].trim().length > 2_048) {
      throw new Error(`CSS token ${match[1]} exceeds the value limit.`);
    }
    found.add(match[1].toLowerCase());
  }
  for (const token of REQUIRED_SEMANTIC_TOKENS) {
    if (!found.has(token)) throw new Error(`tokens.css is missing ${token}.`);
  }
  const remainder = body.replace(declarationPattern, "").trim();
  if (remainder) {
    throw new Error("tokens.css contains invalid declarations.");
  }
}

async function sha256Package(
  manifestText: string,
  design: string,
  tokens: string,
): Promise<string> {
  const content = `${manifestText}\0${design}\0${tokens}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function validateDesignSystemPackage(
  inputFiles: readonly DesignSystemInputFile[],
  options: {
    source: DesignSystemSource;
    version: string;
    expectedDigest?: string;
  },
): Promise<DesignSystemPackage> {
  if (inputFiles.length === 0)
    throw new Error("Design-system package is empty.");
  if (inputFiles.length > DESIGN_SYSTEM_LIMITS.maxEntries) {
    throw new Error("Design-system package contains too many files.");
  }
  let totalBytes = 0;
  const files = new Map<string, string>();
  for (const file of inputFiles) {
    assertSafeDesignSystemPath(file.path);
    assertTextFile(file.path);
    if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(file.content)) {
      throw new Error(`Design-system file "${file.path}" is not plain text.`);
    }
    if (files.has(file.path))
      throw new Error(`Duplicate path: "${file.path}".`);
    totalBytes += textBytes(file.content);
    if (totalBytes > DESIGN_SYSTEM_LIMITS.maxPackageBytes) {
      throw new Error("Design-system package exceeds the 2 MB limit.");
    }
    files.set(file.path, file.content);
  }
  const manifestText = files.get("manifest.json");
  if (!manifestText)
    throw new Error("Design-system package is missing manifest.json.");
  if (textBytes(manifestText) > DESIGN_SYSTEM_LIMITS.maxManifestBytes) {
    throw new Error("manifest.json exceeds the 64 KB limit.");
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestText);
  } catch {
    throw new Error("manifest.json is not valid JSON.");
  }
  const parsed = manifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    throw new Error(
      `Invalid design-system manifest: ${parsed.error.issues[0]?.message}.`,
    );
  }
  const manifest = parsed.data;
  assertDesignSystemId(manifest.id);
  assertSafeDesignSystemPath(manifest.files.design);
  assertSafeDesignSystemPath(manifest.files.tokens);
  const design = files.get(manifest.files.design);
  const tokens = files.get(manifest.files.tokens);
  if (design === undefined || tokens === undefined) {
    throw new Error("Manifest-declared DESIGN.md or tokens.css is missing.");
  }
  if (textBytes(design) > DESIGN_SYSTEM_LIMITS.maxDesignBytes) {
    throw new Error("DESIGN.md exceeds the 256 KB limit.");
  }
  if (textBytes(tokens) > DESIGN_SYSTEM_LIMITS.maxTokensBytes) {
    throw new Error("tokens.css exceeds the 256 KB limit.");
  }
  validateSemanticTokensCss(tokens);
  const digest = await sha256Package(manifestText, design, tokens);
  if (options.expectedDigest && digest !== options.expectedDigest) {
    throw new Error(`Design-system digest mismatch for "${manifest.id}".`);
  }
  return {
    manifest,
    manifestText,
    design,
    tokens,
    digest,
    reference: {
      id: manifest.id,
      name: manifest.name,
      source: options.source,
      version: options.version,
      digest,
    },
  };
}
