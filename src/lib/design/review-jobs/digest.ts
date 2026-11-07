import type { ProjectFiles } from "../../ai/generator-types";
import {
  getProjectDesignStructureFingerprint,
  PROJECT_DESIGN_PATH,
  readProjectDesign,
} from "../project-design";

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
  const blueprint = readProjectDesign(source.files);
  // If runtime code consumes the blueprint, even its metadata can change pixels.
  const runtimeReadsBlueprint = Object.entries(source.files).some(
    ([path, content]) =>
      path !== PROJECT_DESIGN_PATH &&
      /\.(?:[cm]?[jt]sx?|html|vue|svelte)$/i.test(path) &&
      content.includes(PROJECT_DESIGN_PATH),
  );
  const files =
    blueprint.status === "ready" && !runtimeReadsBlueprint
      ? {
          ...source.files,
          [PROJECT_DESIGN_PATH]: getProjectDesignStructureFingerprint(
            blueprint.design,
          ),
        }
      : source.files;
  const context = source.designContract;
  const designContext =
    context && typeof context === "object" && "blueprint" in context
      ? {
          ...context,
          blueprint: (() => {
            const binding = context.blueprint;
            if (!binding || typeof binding !== "object") return binding;
            const {
              revision: _revision,
              batch_phase: _phase,
              ...scope
            } = binding as Record<string, unknown>;
            return scope;
          })(),
        }
      : context;
  return JSON.stringify(
    canonicalize({
      files,
      designSystem: source.designSystem ?? null,
      designContract: designContext ?? null,
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
