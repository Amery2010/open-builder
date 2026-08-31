import type { ProjectFiles } from "../../ai/generator-types";

export interface DesignReviewSource {
  files: ProjectFiles;
  designSystem?: unknown;
  designContract?: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function serializeDesignReviewSource(
  source: DesignReviewSource,
): string {
  return JSON.stringify(
    canonicalize({
      files: source.files,
      designSystem: source.designSystem ?? null,
      designContract: source.designContract ?? null,
    }),
  );
}

export async function computeDesignReviewSourceDigest(
  source: DesignReviewSource,
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 is unavailable in this runtime.");
  }
  const bytes = new TextEncoder().encode(serializeDesignReviewSource(source));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
