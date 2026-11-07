import { isSensitiveProjectPath } from "../utils/project-file-policy";
import { HOST_TOOL_DESCRIPTORS } from "../ai/host-tool-catalog-data";
import type { ProjectFiles } from "../../types";
import type {
  DesignChangeMode,
  DesignContract,
  DesignSurfaceMode,
} from "./run-contract";
import {
  appendProjectDesignJournal,
  upsertProjectDesign,
  readProjectDesign,
  PROJECT_DESIGN_PATH,
} from "./project-design";

/** Host-owned design context. Unknown descriptive values remain empty. */
export type DesignRunContext = DesignContract;
export type DesignPassDecision = {
  status:
    "complete" | "continue" | "needs-information" | "paused" | "cancelled";
  taskIds: string[];
};

export function designRunSkillIds(
  surface: DesignSurfaceMode = "mixed",
): Array<"design-product-ui" | "art-direct-web"> {
  return surface === "operate"
    ? ["design-product-ui"]
    : surface === "mixed"
      ? ["design-product-ui", "art-direct-web"]
      : ["art-direct-web"];
}

export function prepareDesignRun(input: {
  requestId: string;
  goal: string;
  files: ProjectFiles;
  systemId?: string | null;
  changeMode?: DesignChangeMode;
  surfaceMode?: DesignSurfaceMode;
  pageIds?: readonly string[];
  filePaths?: readonly string[];
  resume?: boolean;
}) {
  const initial = readProjectDesign(input.files);
  const initialTasks = new Map(
    (initial.status === "ready" ? (initial.design.tasks ?? []) : []).map(
      (task) => [task.id, JSON.stringify(task)],
    ),
  );
  let currentFiles = input.files;
  const resumeOwner =
    input.resume && initial.status === "ready"
      ? initial.design.journal?.at(-1)?.requestId
      : undefined;
  const selectedIds = new Set(input.pageIds ?? []);
  const explicitPaths = new Set(input.filePaths ?? []);

  function context(files = currentFiles): DesignRunContext {
    currentFiles = files;
    const blueprint = readProjectDesign(files);
    const design = blueprint.status === "ready" ? blueprint.design : undefined;
    return {
      surface_mode: input.surfaceMode ?? "mixed",
      change_mode:
        input.changeMode ??
        (Object.keys(input.files).length ? "extend" : "create"),
      target: input.goal,
      audience: design?.audience ?? "",
      primary_goal: design?.productGoal ?? input.goal,
      concept: "",
      system_id: input.systemId ?? null,
      translation: { foundations: "", composition: "", components: "" },
      preserve: [],
      acceptance: [],
    };
  }

  function declaredPaths(files: ProjectFiles): Set<string> | undefined {
    if (!selectedIds.size && !explicitPaths.size) return undefined;
    const allowed = new Set(explicitPaths);
    const result = readProjectDesign(files);
    if (result.status !== "ready") return allowed;
    for (const page of result.design.pages) {
      if (!selectedIds.has(page.id)) continue;
      for (const path of page.filePaths) allowed.add(path);
      const layout = result.design.layouts.find(
        (item) => item.id === page.layoutId,
      );
      for (const path of layout?.filePaths ?? []) allowed.add(path);
      const refs = new Set([
        ...page.sharedUiRefs,
        ...(layout?.sharedUiRefs ?? []),
      ]);
      for (const ref of result.design.sharedUiRefs)
        if (refs.has(ref.id))
          for (const path of ref.filePaths) allowed.add(path);
    }
    return allowed;
  }

  const trustedPaths = declaredPaths(input.files);
  function allowedPaths(files: ProjectFiles) {
    const current = declaredPaths(files);
    return trustedPaths && current
      ? new Set([...current].filter((path) => trustedPaths.has(path)))
      : trustedPaths;
  }

  return {
    context,
    authorize(
      name: string,
      args: unknown,
      files: ProjectFiles,
    ): string | undefined {
      if (
        name === "update_project_design" ||
        !HOST_TOOL_DESCRIPTORS.find(
          (record) => record.name === name,
        )?.effects.includes("write_project")
      )
        return;
      const allowed = allowedPaths(files);
      if (!allowed || !args || typeof args !== "object") return;
      const record = args as Record<string, unknown>;
      const paths = [
        record.path,
        record.from,
        record.to,
        record.source,
        record.destination,
        record.old_path,
        record.new_path,
        ...(Array.isArray(record.write_paths) ? record.write_paths : []),
      ].filter((path): path is string => typeof path === "string");
      const outside = paths.find(
        (path) => !allowed.has(path.replace(/^\/+/, "")),
      );
      return outside
        ? `The selected design scope does not include "${outside}". Keep this task within the selected page and its declared shared files.`
        : undefined;
    },
    prepareCommit(
      before: ProjectFiles,
      proposed: ProjectFiles,
      operationId: string,
    ): ProjectFiles {
      const changed = [
        ...new Set([...Object.keys(before), ...Object.keys(proposed)]),
      ].filter((path) => before[path] !== proposed[path]);
      if (!changed.length) return proposed;
      const allowed = allowedPaths(before);
      const outside =
        allowed &&
        changed.find(
          (path) => path !== PROJECT_DESIGN_PATH && !allowed.has(path),
        );
      if (outside)
        throw new Error(
          `The selected design scope does not include "${outside}".`,
        );
      const previous = readProjectDesign(before);
      const nextDesign = readProjectDesign(proposed);
      if (nextDesign.status === "ready" && nextDesign.design.tasks) {
        const previousTasks = new Map(
          (previous.status === "ready"
            ? (previous.design.tasks ?? [])
            : []
          ).map((task) => [task.id, JSON.stringify(task)]),
        );
        const tasks = nextDesign.design.tasks.map((task) =>
          previousTasks.get(task.id) !== JSON.stringify(task)
            ? { ...task, requestId: input.requestId }
            : task,
        );
        if (JSON.stringify(tasks) !== JSON.stringify(nextDesign.design.tasks))
          proposed = upsertProjectDesign(proposed, {
            ...nextDesign.design,
            tasks,
          });
      }
      const next = appendProjectDesignJournal(
        proposed,
        {
          operationId,
          requestId: input.requestId,
          changedPaths: changed.filter((path) => !isSensitiveProjectPath(path)),
          recordedAt: new Date().toISOString(),
        },
        before,
      );
      return next;
    },
    finishPass(
      before: ProjectFiles,
      after: ProjectFiles,
      result: { aborted: boolean; maxIterationsReached: boolean },
    ): DesignPassDecision {
      currentFiles = after;
      if (result.aborted) return { status: "cancelled", taskIds: [] };
      if (result.maxIterationsReached) return { status: "paused", taskIds: [] };
      const read = readProjectDesign(after);
      const tasks =
        read.status === "ready"
          ? (read.design.tasks ?? []).filter(
              (task) =>
                task.requestId === input.requestId ||
                initialTasks.get(task.id) !== JSON.stringify(task) ||
                (resumeOwner !== undefined && task.requestId === resumeOwner),
            )
          : [];
      const pending = tasks.filter(
        (task) => task.status === "pending" || task.status === "running",
      );
      const taskIds = pending.map((task) => task.id);
      if (!pending.length)
        return {
          status: tasks.some(
            (task) =>
              task.status === "needs-information" || task.status === "failed",
          )
            ? "needs-information"
            : "complete",
          taskIds: tasks
            .filter(
              (task) =>
                task.status === "needs-information" || task.status === "failed",
            )
            .map((task) => task.id),
        };
      const advanced =
        Object.keys(after).some(
          (path) =>
            path !== PROJECT_DESIGN_PATH && before[path] !== after[path],
        ) ||
        Object.keys(before).some(
          (path) => path !== PROJECT_DESIGN_PATH && !(path in after),
        );
      const scope = allowedPaths(after);
      const executable = pending.filter((task) => {
        const pages =
          read.status === "ready"
            ? read.design.pages.filter((page) =>
                task.pageIds?.includes(page.id),
              )
            : [];
        const paths = [
          ...(task.filePaths ?? []),
          ...pages.flatMap((page) => page.filePaths),
        ];
        return (
          paths.length > 0 && (!scope || paths.every((path) => scope.has(path)))
        );
      });
      return {
        status:
          executable.length && advanced ? "continue" : "needs-information",
        taskIds: executable.length
          ? executable.map((task) => task.id)
          : taskIds,
      };
    },
    affectedPaths: () => {
      const read = readProjectDesign(currentFiles);
      return read.status === "ready"
        ? [
            ...new Set(
              (read.design.journal ?? [])
                .filter((entry) => entry.requestId === input.requestId)
                .flatMap((entry) => entry.changedPaths)
                .filter((path) => path !== PROJECT_DESIGN_PATH),
            ),
          ]
        : [];
    },
  };
}
export type DesignRun = ReturnType<typeof prepareDesignRun>;
