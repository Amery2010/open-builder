import type { FileChange, ProjectFiles } from "./types.js";
import type { DesignSystemPackage } from "./design-validation.js";
import { stripDesignReferenceHeader } from "./reference-header.js";

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
    throw new Error("A Design system requires initialized project files.");
  }
  const designPath = findRootPath(files, "DESIGN.md");
  const tokensPath = findRootPath(files, "tokens.css");
  const design = stripDesignReferenceHeader(pkg.design);
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
