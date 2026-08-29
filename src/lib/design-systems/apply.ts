import { tool } from "ai";
import { z } from "zod";
import type { DesignSystemRef, FileChange, ProjectFiles } from "../../types";
import { BUNDLED_DESIGN_SYSTEMS } from "./catalog";
import type { DesignSystemPackage } from "./validation";
import { getDesignSystemRegistry } from "./registry";

export const APPLY_DESIGN_SYSTEM_TOOL = {
  apply_design_system: tool({
    description:
      "Apply the selected Open Builder Design system after project initialization. " +
      "Use only in Design mode and only after the user explicitly asks to apply the selected system. " +
      "It writes canonical root DESIGN.md and tokens.css files with source attribution. " +
      "The result is compact; read those project files before reshaping the UI.",
    inputSchema: z.object({
      system_id: z
        .string()
        .describe(
          `Bundled ids include ${BUNDLED_DESIGN_SYSTEMS.map((entry) => entry.id).join(", ")}; custom and imported systems use their registry id.`,
        ),
    }),
  }),
};

export interface ApplyDesignSystemDeps {
  getFiles: () => ProjectFiles;
  onFilesChanged: (newFiles: ProjectFiles, changes: FileChange[]) => void;
  loadPackage?: (id: string) => Promise<DesignSystemPackage>;
  getSelectedSystemId?: () => string | undefined;
  onApplied?: (reference: DesignSystemRef) => void;
}

export interface AppliedDesignSystemPackage {
  files: ProjectFiles;
  changes: FileChange[];
}

function findRootPath(files: ProjectFiles, canonicalPath: string): string {
  return (
    Object.keys(files).find(
      (path) =>
        !path.includes("/") &&
        path.toLocaleLowerCase() === canonicalPath.toLocaleLowerCase(),
    ) ?? canonicalPath
  );
}

function sourceLabel(pkg: DesignSystemPackage): string {
  if (pkg.reference.source === "builtin") {
    return `Open Builder bundled design system ${pkg.reference.version}; package ${pkg.manifest.id}; sha256 ${pkg.digest}`;
  }
  const source = pkg.reference.source === "custom" ? "Custom" : "Imported";
  return `${source} design system ${pkg.manifest.id}; version ${pkg.reference.version}; sha256 ${pkg.digest}`;
}

export function applyDesignSystemPackage(
  files: ProjectFiles,
  pkg: DesignSystemPackage,
): AppliedDesignSystemPackage {
  if (Object.keys(files).length === 0) {
    throw new Error("init_project must run before apply_design_system");
  }
  const designPath = findRootPath(files, "DESIGN.md");
  const tokensPath = findRootPath(files, "tokens.css");
  const design =
    `<!-- Untrusted visual reference. ${sourceLabel(pkg)}. ` +
    `Unofficial reference; no trademark endorsement is implied. -->\n\n${pkg.design}`;
  const tokens =
    `/* Untrusted visual reference. ${sourceLabel(pkg)}. ` +
    `Unofficial reference; no trademark endorsement is implied. */\n\n${pkg.tokens}`;
  return {
    files: {
      ...files,
      [designPath]: design,
      [tokensPath]: tokens,
    },
    changes: [
      {
        path: designPath,
        action: designPath in files ? "modified" : "created",
      },
      {
        path: tokensPath,
        action: tokensPath in files ? "modified" : "created",
      },
    ],
  };
}

export function loadDesignSystemPackage(
  id: string,
): Promise<DesignSystemPackage> {
  return getDesignSystemRegistry().load(id);
}

export function createApplyDesignSystemHandler(deps: ApplyDesignSystemDeps) {
  return async (_name: string, args: unknown): Promise<string> => {
    const systemId =
      typeof (args as { system_id?: unknown })?.system_id === "string"
        ? (args as { system_id: string }).system_id.trim().toLocaleLowerCase()
        : "";
    const selectedSystemId = deps.getSelectedSystemId?.();
    if (selectedSystemId !== undefined && selectedSystemId !== systemId) {
      return JSON.stringify({
        ok: false,
        error:
          "apply_design_system may apply only the system currently selected by the user",
      });
    }
    const files = deps.getFiles();
    if (Object.keys(files).length === 0) {
      return JSON.stringify({
        ok: false,
        error: "init_project must run before apply_design_system",
      });
    }
    let pkg: DesignSystemPackage;
    try {
      pkg = await (deps.loadPackage ?? loadDesignSystemPackage)(systemId);
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let applied: AppliedDesignSystemPackage;
    try {
      applied = applyDesignSystemPackage(files, pkg);
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    deps.onFilesChanged(applied.files, applied.changes);
    deps.onApplied?.(pkg.reference);
    return JSON.stringify({
      ok: true,
      system: pkg.reference,
      files: applied.changes.map((change) => change.path),
      note: "Read DESIGN.md and tokens.css, then reshape the page while preserving behavior and using semantic tokens.",
    });
  };
}
