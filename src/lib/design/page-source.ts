import type { ProjectFiles } from "../../types";

/** Resolve to the canonical key: sandbox paths are presentation only. */
export function resolvePageSource(
  filePaths: readonly string[],
  files: ProjectFiles,
  editableFiles: ProjectFiles,
  currentFile: string,
): string | undefined {
  const normalize = (path: string) => path.replace(/^\/+/, "");
  const declared = new Set(filePaths.map(normalize));
  const editable = new Set(Object.keys(editableFiles).map(normalize));
  const candidates = Object.keys(files)
    .filter(
      (path) =>
        !path.endsWith("/") &&
        declared.has(normalize(path)) &&
        editable.has(normalize(path)),
    )
    .sort();
  return (
    candidates.find((path) => normalize(path) === normalize(currentFile)) ??
    candidates[0]
  );
}
