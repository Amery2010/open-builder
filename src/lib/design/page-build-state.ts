import type { ProjectFiles } from "../../types";
import type { ProjectDesign, ProjectDesignPage } from "./project-design";

/** Implementation declarations and visual verification are separate evidence. */
export function derivePageBuildState(
  design: ProjectDesign,
  page: ProjectDesignPage,
  files: ProjectFiles,
) {
  const paths = new Set(page.filePaths);
  const changed = (design.journal ?? []).some((entry) =>
    entry.changedPaths.some((path) => paths.has(path) && path in files),
  );
  const done = (design.tasks ?? []).some(
    (task) =>
      task.status === "done" &&
      (task.pageIds?.includes(page.id) ||
        task.filePaths?.some((path) => paths.has(path))),
  );
  if (changed && done)
    return { buildProgress: 100, buildStatus: "complete" as const };
  if (changed) return { buildProgress: 0, buildStatus: "in-progress" as const };
  if (design.buildProgress.completedPageIds.includes(page.id))
    return { buildProgress: 100, buildStatus: "recorded" as const };
  return { buildProgress: 0, buildStatus: "not-started" as const };
}
