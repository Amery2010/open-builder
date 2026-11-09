import type { ProjectFiles } from "./types.js";

/** Remove only the old host-generated preamble, preserving the reference body. */
export function stripDesignReferenceHeader(content: string): string {
  return content.replace(
    /^(\uFEFF?)<!-- Untrusted visual reference\. (?:Open Builder bundled design system|Custom design system|Imported design system|Source: https?:\/\/)[^\r\n]*? -->\r?\n(?:\r?\n)?/,
    "$1",
  );
}

export function removeDesignReferenceHeaders(
  files: ProjectFiles,
): ProjectFiles {
  let result = files;
  for (const path of Object.keys(files)) {
    if (path.toLowerCase() !== "design.md") continue;
    const content = stripDesignReferenceHeader(files[path]);
    if (content === files[path]) continue;
    if (result === files) result = { ...files };
    result[path] = content;
  }
  return result;
}
