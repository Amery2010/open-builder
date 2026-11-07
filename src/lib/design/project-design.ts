import { z } from "zod";
import type { ProjectFiles } from "../../types";
import { normalizeProjectPath } from "../tools/fs-tools";
import { isSensitiveProjectPath } from "../utils/project-file-policy";
import { validateProjectFiles } from "../utils/project-files";
import { type PrototypePreviewTarget } from "./preview-runtime";
import {
  PROTOTYPE_ROUTE_MAX_LENGTH,
  normalizePrototypeRoute,
  resolvePrototypeRoute,
  resolveObservedPrototypeRoute,
  type PrototypeRouteResolution,
} from "./prototype-route";

/** The only ProjectFiles path that can carry a project design contract. */
export const PROJECT_DESIGN_PATH = "design-project.json" as const;
export const PROJECT_DESIGN_FILE = PROJECT_DESIGN_PATH;
export const PROJECT_DESIGN_SCHEMA_VERSION =
  "open-builder-design-project/v3" as const;
export const LEGACY_PROJECT_DESIGN_SCHEMA_VERSION =
  "open-builder-design-project/v1" as const;

/** Bounds protect parsers and derived indexes from untrusted project content. */
export const PROJECT_DESIGN_LIMITS = Object.freeze({
  maxJsonBytes: 512 * 1024,
  maxIdChars: 80,
  maxRouteChars: PROTOTYPE_ROUTE_MAX_LENGTH,
  maxTextChars: 2_000,
  maxPages: 200,
  maxLayouts: 100,
  maxSharedUiRefs: 200,
  maxFlows: 200,
  maxRefsPerEntity: 40,
  maxChangedIds: 200,
  maxTreeDepth: 24,
} as const);

const PAGE_KINDS = [
  "landing",
  "home",
  "marketing",
  "dashboard",
  "list",
  "detail",
  "form",
  "settings",
  "auth",
  "error",
  "search",
  "profile",
  "checkout",
  "article",
  "table",
  "wizard",
  "modal",
  "custom",
] as const;

const LAYOUT_KINDS = [
  "app-shell",
  "marketing",
  "dashboard",
  "split",
  "grid",
  "stack",
  "modal",
  "custom",
] as const;

const SHARED_UI_KINDS = [
  "navigation",
  "header",
  "footer",
  "sidebar",
  "toolbar",
  "component",
  "overlay",
  "custom",
] as const;

const LEGACY_SCENARIO_KINDS = [
  "default",
  "happy-path",
  "smoke",
  "regression",
  "empty",
  "loading",
  "validation",
  "success",
  "error",
  "failure",
  "edge-case",
  "responsive",
  "authenticated",
  "unauthenticated",
  "custom",
] as const;

const BUILD_PROGRESS_STATUSES = [
  "not-started",
  "in-progress",
  "blocked",
  "complete",
] as const;

export const PROJECT_DESIGN_BATCH_PHASES = [
  "foundation",
  "core_flow",
  "remaining_flows",
  "final_review",
] as const;

export type PageKind = (typeof PAGE_KINDS)[number];
export type LayoutKind = (typeof LAYOUT_KINDS)[number];
export type SharedUiKind = (typeof SHARED_UI_KINDS)[number];
export type BuildProgressStatus = (typeof BUILD_PROGRESS_STATUSES)[number];
export type ProjectDesignRevision = string | number;

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROJECT_DESIGN_LIMITS.maxIdChars)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, "must be a stable kebab-case id");

const textSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROJECT_DESIGN_LIMITS.maxTextChars);

const revisionSchema: z.ZodType<ProjectDesignRevision> = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .trim()
    .min(1)
    .max(PROJECT_DESIGN_LIMITS.maxIdChars)
    .refine((revision) => !/[\u0000-\u001f\u007f-\u009f]/u.test(revision), {
      message: "must not contain control characters",
    }),
]);

const routeSchema = z
  .string()
  .trim()
  .max(PROJECT_DESIGN_LIMITS.maxRouteChars)
  .transform((value) => {
    const normalized = normalizePrototypeRoute(value);
    return normalized.ok ? normalized.route : value;
  });
const draftTextSchema = z
  .string()
  .trim()
  .max(PROJECT_DESIGN_LIMITS.maxTextChars);

const filePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .transform((path, ctx) => {
    const normalized = normalizeProjectPath(path);
    if (!normalized.ok) {
      ctx.addIssue({ code: "custom", message: normalized.error });
      return z.NEVER;
    }
    if (isSensitiveProjectPath(normalized.path)) {
      ctx.addIssue({
        code: "custom",
        message: "sensitive project paths cannot belong to a design scope",
      });
      return z.NEVER;
    }
    return normalized.path;
  });

const idListSchema = z
  .array(stableIdSchema)
  .max(PROJECT_DESIGN_LIMITS.maxRefsPerEntity)
  .default([])
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate reference "${id}"`,
          path: [index],
        });
      }
      seen.add(id);
    });
  });

const filePathListSchema = z
  .array(filePathSchema)
  .max(PROJECT_DESIGN_LIMITS.maxRefsPerEntity)
  .default([])
  .superRefine((paths, ctx) => {
    const seen = new Set<string>();
    paths.forEach((path, index) => {
      const key = path.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate file path "${path}"`,
          path: [index],
        });
      }
      seen.add(key);
    });
  });

const legacyScenarioSchema = z
  .object({
    id: stableIdSchema,
    name: textSchema,
    kind: z.enum(LEGACY_SCENARIO_KINDS),
  })
  .strict();

const pageShape = {
  id: stableIdSchema,
  name: textSchema.optional(),
  responsibility: draftTextSchema.optional(),
  route: routeSchema.optional(),
  previewPath: routeSchema.optional(),
  kind: z.enum(PAGE_KINDS).optional(),
  parentId: stableIdSchema.nullable().optional(),
  layoutId: stableIdSchema.nullable().optional(),
  filePaths: filePathListSchema,
  sharedUiRefs: idListSchema,
  flowIds: idListSchema,
};
const pageSchema = z
  .object(pageShape)
  .strict()
  .transform((page) => ({
    ...page,
    name: page.name ?? page.id,
    parentId: page.parentId ?? null,
    layoutId: page.layoutId ?? null,
  }));

const layoutSchema = z
  .object({
    id: stableIdSchema,
    name: textSchema,
    kind: z.enum(LAYOUT_KINDS),
    filePaths: filePathListSchema,
    pageIds: idListSchema,
    sharedUiRefs: idListSchema,
  })
  .strict();

const sharedUiRefSchema = z
  .object({
    id: stableIdSchema,
    name: textSchema,
    kind: z.enum(SHARED_UI_KINDS),
    filePaths: filePathListSchema,
  })
  .strict();

const flowSchema = z
  .object({
    id: stableIdSchema,
    name: textSchema,
    pageIds: idListSchema,
  })
  .strict();

const buildCheckpointSchema = z
  .object({
    phase: textSchema,
    status: z.enum(["completed", "failed"]),
    pageIds: idListSchema,
    flowIds: idListSchema,
    artifactPaths: filePathListSchema,
    validation: z
      .object({
        status: z.enum(["passed", "failed", "not-run"]),
        summary: textSchema,
      })
      .strict(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const buildProgressSchema = z
  .object({
    status: z
      .union([z.enum(BUILD_PROGRESS_STATUSES), z.literal("planned")])
      .transform((status) => (status === "planned" ? "not-started" : status))
      .default("not-started"),
    percent: z.number().int().min(0).max(100).default(0),
    completedPageIds: idListSchema,
    completedFlowIds: idListSchema,
    checkpoints: z.array(buildCheckpointSchema).max(50).default([]),
  })
  .strict();

const taskSchema = z
  .object({
    id: stableIdSchema,
    description: draftTextSchema.optional(),
    requestId: z.string().min(1).max(200).optional(),
    pageIds: idListSchema.removeDefault().optional(),
    filePaths: filePathListSchema.removeDefault().optional(),
    status: z.enum([
      "pending",
      "running",
      "done",
      "needs-information",
      "failed",
    ]),
  })
  .strict();
const journalEntrySchema = z
  .object({
    operationId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    changedPaths: z
      .array(filePathSchema)
      .max(PROJECT_DESIGN_LIMITS.maxChangedIds),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProjectDesignTask = z.output<typeof taskSchema>;
export type ProjectDesignJournalEntry = z.output<typeof journalEntrySchema>;

const rawProjectDesignSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_DESIGN_SCHEMA_VERSION),
    productGoal: draftTextSchema.optional(),
    audience: draftTextSchema.optional(),
    revision: revisionSchema,
    pages: z.array(pageSchema).max(PROJECT_DESIGN_LIMITS.maxPages).default([]),
    layouts: z
      .array(layoutSchema)
      .max(PROJECT_DESIGN_LIMITS.maxLayouts)
      .default([]),
    sharedUiRefs: z
      .array(sharedUiRefSchema)
      .max(PROJECT_DESIGN_LIMITS.maxSharedUiRefs)
      .default([]),
    flows: z.array(flowSchema).max(PROJECT_DESIGN_LIMITS.maxFlows).default([]),
    buildProgress: buildProgressSchema.prefault({}),
    tasks: z.array(taskSchema).max(200).optional(),
    journal: z.array(journalEntrySchema).optional(),
  })
  .strict();

/** Read-only compatibility boundary. New writes never accept these fields. */
const legacyProjectDesignSchema = rawProjectDesignSchema
  .extend({
    schemaVersion: z.union([
      z.literal(LEGACY_PROJECT_DESIGN_SCHEMA_VERSION),
      z.literal("open-builder-design-project/v2"),
      z.literal(1),
    ]),
    pages: z
      .array(
        z
          .object({
            ...pageShape,
            defaultScenario: stableIdSchema.optional(),
            scenarioIds: idListSchema,
          })
          .strict()
          .transform((page) => ({
            ...page,
            name: page.name ?? page.id,
            parentId: page.parentId ?? null,
            layoutId: page.layoutId ?? null,
          })),
      )
      .max(PROJECT_DESIGN_LIMITS.maxPages)
      .default([]),
    flows: z
      .array(flowSchema.extend({ scenarioIds: idListSchema }))
      .max(PROJECT_DESIGN_LIMITS.maxFlows)
      .default([]),
    scenarios: z.array(legacyScenarioSchema).max(200).default([]),
  })
  .superRefine((design, ctx) => {
    validateStructure(
      { ...design, schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION },
      ctx,
    );
    addDuplicateIssues(design.scenarios, "scenarios", ctx);
  });

/** Preserve the exact old default URL before forgetting the legacy state model. */
function migrateLegacyProjectDesign(
  input: unknown,
  ctx: z.RefinementCtx,
): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const version = (input as Record<string, unknown>).schemaVersion;
  if (
    version !== 1 &&
    version !== LEGACY_PROJECT_DESIGN_SCHEMA_VERSION &&
    version !== "open-builder-design-project/v2"
  )
    return input;
  const parsed = legacyProjectDesignSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    return z.NEVER;
  }
  const { scenarios, ...legacy } = parsed.data;
  let failed = false;
  const pages = legacy.pages.map(
    ({ defaultScenario, scenarioIds, ...page }, index) => {
      const resolution = resolvePrototypeRoute({ pages: [page] }, page.id);
      // Incomplete declarations remain editable drafts, without inventing a route.
      if (resolution.status !== "ready") return page;
      const fail = (message: string) => {
        failed = true;
        ctx.addIssue({
          code: "custom",
          path: ["pages", index, "route"],
          message: `Cannot migrate page "${page.id}": ${message}`,
        });
      };
      const selected = defaultScenario ?? "default";
      const baseline =
        selected === "default" &&
        !defaultScenario &&
        !scenarioIds.includes("default");
      if (
        !baseline &&
        !scenarios.some((scenario) => scenario.id === selected)
      ) {
        fail(`the default scenario "${selected}" is not defined.`);
        return page;
      }
      const route = page.route!;
      const queryAt = route.indexOf("?");
      const query = queryAt < 0 ? "" : route.slice(queryAt + 1);
      const values = new URLSearchParams(query).getAll("scenario");
      if (
        values.length > 1 ||
        (values.length === 1 && values[0] !== selected)
      ) {
        fail("the declared URL conflicts with its default scenario.");
        return page;
      }
      const suffix = values.length
        ? ""
        : `${queryAt < 0 ? "?" : query ? "&" : ""}scenario=${encodeURIComponent(selected)}`;
      const next = { ...page, route: route + suffix };
      const expected = resolution.target.route + suffix;
      const migrated = resolvePrototypeRoute({ pages: [next] }, page.id);
      if (migrated.status !== "ready" || migrated.target.route !== expected) {
        fail("the original default preview URL cannot be preserved safely.");
      }
      return next;
    },
  );
  if (failed) return z.NEVER;
  return {
    ...legacy,
    schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION,
    pages,
    flows: legacy.flows.map((flow) => {
      const next = { ...flow };
      Reflect.deleteProperty(next, "scenarioIds");
      return next;
    }),
  };
}

/** Input schemas deliberately omit read-time defaults so omission preserves data. */
const progressPatchSchema = z
  .object({
    status: buildProgressSchema.shape.status.removeDefault().optional(),
    percent: buildProgressSchema.shape.percent.removeDefault().optional(),
    completedPageIds: idListSchema.removeDefault().optional(),
    completedFlowIds: idListSchema.removeDefault().optional(),
    checkpoints: buildProgressSchema.shape.checkpoints
      .removeDefault()
      .optional(),
  })
  .strict();
export const projectDesignUpdateSchema = rawProjectDesignSchema
  .omit({
    buildProgress: true,
    pages: true,
    layouts: true,
    sharedUiRefs: true,
    flows: true,
    journal: true,
  })
  .partial()
  .extend({
    pages: rawProjectDesignSchema.shape.pages.removeDefault().optional(),
    layouts: rawProjectDesignSchema.shape.layouts.removeDefault().optional(),
    sharedUiRefs: rawProjectDesignSchema.shape.sharedUiRefs
      .removeDefault()
      .optional(),
    flows: rawProjectDesignSchema.shape.flows.removeDefault().optional(),
    buildProgress: progressPatchSchema.optional(),
    journal: rawProjectDesignSchema.shape.journal,
    pageCount: z.number().int().nonnegative().optional(),
    flowCount: z.number().int().nonnegative().optional(),
  });
const pagePatchSchema = z
  .object({
    ...pageShape,
    filePaths: filePathListSchema.removeDefault(),
    sharedUiRefs: idListSchema.removeDefault(),
    flowIds: idListSchema.removeDefault(),
  })
  .partial()
  .required({ id: true })
  .strict();
// Nested defaults must also stay absent when an entity is patched by ID.
const layoutPatchSchema = layoutSchema
  .extend({
    filePaths: filePathListSchema.removeDefault(),
    pageIds: idListSchema.removeDefault(),
    sharedUiRefs: idListSchema.removeDefault(),
  })
  .partial()
  .required({ id: true });
const sharedUiPatchSchema = sharedUiRefSchema
  .extend({ filePaths: filePathListSchema.removeDefault() })
  .partial()
  .required({ id: true });
const flowPatchSchema = flowSchema
  .extend({
    pageIds: idListSchema.removeDefault(),
  })
  .partial()
  .required({ id: true });
export const projectDesignPatchSchema = projectDesignUpdateSchema.extend({
  pages: z
    .array(pagePatchSchema)
    .max(PROJECT_DESIGN_LIMITS.maxPages)
    .optional(),
  layouts: z
    .array(layoutPatchSchema)
    .max(PROJECT_DESIGN_LIMITS.maxLayouts)
    .optional(),
  sharedUiRefs: z
    .array(sharedUiPatchSchema)
    .max(PROJECT_DESIGN_LIMITS.maxSharedUiRefs)
    .optional(),
  flows: z
    .array(flowPatchSchema)
    .max(PROJECT_DESIGN_LIMITS.maxFlows)
    .optional(),
  tasks: z
    .array(taskSchema.partial().required({ id: true }))
    .max(200)
    .optional(),
});
const entityCollections = [
  "pages",
  "layouts",
  "sharedUiRefs",
  "flows",
  "tasks",
] as const;
export const projectDesignRemoveSchema = z
  .object({
    pages: idListSchema.removeDefault().optional(),
    layouts: idListSchema.removeDefault().optional(),
    sharedUiRefs: idListSchema.removeDefault().optional(),
    flows: idListSchema.removeDefault().optional(),
    tasks: idListSchema.removeDefault().optional(),
  })
  .strict();
export const projectDesignToolInputSchema = z
  .object({
    patch: projectDesignPatchSchema.optional(),
    document: projectDesignUpdateSchema.optional(),
    remove: projectDesignRemoveSchema.optional(),
    expected_revision: revisionSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.patch === undefined) === (input.document === undefined))
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of patch or document.",
      });
    if (input.document && input.remove)
      ctx.addIssue({
        code: "custom",
        message: "remove is only supported with patch.",
      });
  });

export type ProjectDesignPage = z.output<typeof pageSchema>;
export type ProjectDesignLayout = z.infer<typeof layoutSchema>;
export type ProjectDesignSharedUiRef = z.infer<typeof sharedUiRefSchema>;
export type ProjectDesignFlow = z.infer<typeof flowSchema>;
export type ProjectDesignBuildProgress = z.infer<typeof buildProgressSchema>;
export type ProjectDesignBuildCheckpoint = z.infer<
  typeof buildCheckpointSchema
>;

export interface ProjectDesign extends Omit<
  z.output<typeof rawProjectDesignSchema>,
  "schemaVersion"
> {
  schemaVersion: typeof PROJECT_DESIGN_SCHEMA_VERSION;
}

function addDuplicateIssues<T extends { id: string }>(
  entries: readonly T[],
  path: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate ${path} id "${entry.id}"`,
        path: [path, index, "id"],
      });
    }
    seen.add(entry.id);
  });
}

function hasCycle(pages: readonly ProjectDesignPage[]): string | undefined {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, depth: number): string | undefined => {
    if (depth > PROJECT_DESIGN_LIMITS.maxTreeDepth) {
      return `page tree exceeds ${PROJECT_DESIGN_LIMITS.maxTreeDepth} levels`;
    }
    if (visiting.has(id)) return `page parent cycle includes "${id}"`;
    if (visited.has(id)) return undefined;
    const page = byId.get(id);
    if (!page) return undefined;
    visiting.add(id);
    if (page.parentId) {
      const cycle = visit(page.parentId, depth + 1);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };

  for (const page of pages) {
    const cycle = visit(page.id, 0);
    if (cycle) return cycle;
  }
  return undefined;
}

function validateStructure(
  design: z.output<typeof rawProjectDesignSchema>,
  ctx: z.RefinementCtx,
): void {
  for (const key of entityCollections)
    addDuplicateIssues<{ id: string }>(design[key] ?? [], key, ctx);
  const cycle = hasCycle(design.pages);
  if (cycle) ctx.addIssue({ code: "custom", message: cycle, path: ["pages"] });
}

function validateReferences(
  design: z.output<typeof rawProjectDesignSchema>,
  ctx: z.RefinementCtx,
): void {
  if (!design.productGoal)
    ctx.addIssue({
      code: "custom",
      message: "Product goal is not defined yet.",
      path: ["productGoal"],
    });
  if (!design.audience)
    ctx.addIssue({
      code: "custom",
      message: "Audience is not defined yet.",
      path: ["audience"],
    });
  const pageIds = new Set(design.pages.map((page) => page.id));
  const layoutIds = new Set(design.layouts.map((layout) => layout.id));
  const sharedUiIds = new Set(design.sharedUiRefs.map((ref) => ref.id));
  const flowIds = new Set(design.flows.map((flow) => flow.id));

  const checkIds = (
    ids: readonly string[],
    valid: ReadonlySet<string>,
    path: (string | number)[],
  ): void => {
    ids.forEach((id, index) => {
      if (!valid.has(id)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown reference "${id}"`,
          path: [...path, index],
        });
      }
    });
  };

  design.pages.forEach((page, index) => {
    if (!page.responsibility)
      ctx.addIssue({
        code: "custom",
        message: "Page responsibility is not defined yet.",
        path: ["pages", index, "responsibility"],
      });
    if (page.parentId && !pageIds.has(page.parentId)) {
      ctx.addIssue({
        code: "custom",
        message: `unknown parent page "${page.parentId}"`,
        path: ["pages", index, "parentId"],
      });
    }
    if (page.layoutId && !layoutIds.has(page.layoutId)) {
      ctx.addIssue({
        code: "custom",
        message: `unknown layout "${page.layoutId}"`,
        path: ["pages", index, "layoutId"],
      });
    }
    checkIds(page.sharedUiRefs, sharedUiIds, ["pages", index, "sharedUiRefs"]);
    checkIds(page.flowIds, flowIds, ["pages", index, "flowIds"]);
  });

  design.layouts.forEach((layout, index) => {
    checkIds(layout.pageIds, pageIds, ["layouts", index, "pageIds"]);
    checkIds(layout.sharedUiRefs, sharedUiIds, [
      "layouts",
      index,
      "sharedUiRefs",
    ]);
  });

  design.flows.forEach((flow, index) => {
    checkIds(flow.pageIds, pageIds, ["flows", index, "pageIds"]);
  });

  checkIds(design.buildProgress.completedPageIds, pageIds, [
    "buildProgress",
    "completedPageIds",
  ]);
  checkIds(design.buildProgress.completedFlowIds, flowIds, [
    "buildProgress",
    "completedFlowIds",
  ]);
  design.buildProgress.checkpoints.forEach((checkpoint, index) => {
    checkIds(checkpoint.pageIds, pageIds, [
      "buildProgress",
      "checkpoints",
      index,
      "pageIds",
    ]);
    checkIds(checkpoint.flowIds, flowIds, [
      "buildProgress",
      "checkpoints",
      index,
      "flowIds",
    ]);
  });

  const routes = new Set<string>();
  design.pages.forEach((page, index) => {
    if (!page.route) return;
    if (routes.has(page.route)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate page route "${page.route}"`,
        path: ["pages", index, "route"],
      });
    }
    routes.add(page.route);
  });
}

/** Structurally validated draft; semantic completeness is reported separately. */
export const projectDesignSchema = z.preprocess(
  migrateLegacyProjectDesign,
  rawProjectDesignSchema.superRefine(validateStructure),
);

export interface ProjectDesignDiagnostic {
  path: string;
  message: string;
  pageId?: string;
}
export function getProjectDesignDiagnostics(
  design: ProjectDesign,
): readonly ProjectDesignDiagnostic[] {
  const result = rawProjectDesignSchema
    .superRefine(validateReferences)
    .safeParse(design);
  const diagnostics: ProjectDesignDiagnostic[] = result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        ...(issue.path[0] === "pages" && typeof issue.path[1] === "number"
          ? { pageId: design.pages[issue.path[1]]?.id }
          : {}),
      }));
  for (const page of design.pages) {
    const resolution = resolvePrototypeRoute(design, page.id);
    if (resolution.status === "unavailable")
      diagnostics.push({
        path: `pages.${page.id}.route`,
        pageId: page.id,
        message: resolution.message,
      });
  }
  return diagnostics;
}

/** Alias retained for callers that use the noun-first name. */
export const designProjectSchema = projectDesignSchema;

export type ProjectDesignSchema = typeof projectDesignSchema;

export type ProjectDesignParseResult =
  | { status: "ready"; design: ProjectDesign }
  | { status: "invalid"; error: string; issues: readonly string[] };

export type ProjectDesignReadResult =
  | { status: "missing"; path: typeof PROJECT_DESIGN_PATH }
  | ({ status: "invalid"; path: typeof PROJECT_DESIGN_PATH } & Omit<
      Extract<ProjectDesignParseResult, { status: "invalid" }>,
      "status"
    >)
  | {
      status: "ready";
      path: typeof PROJECT_DESIGN_PATH;
      design: ProjectDesign;
    };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatZodIssues(error: z.ZodError): readonly string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}

function invalidResult(
  error: string,
  issues: readonly string[] = [error],
): {
  status: "invalid";
  error: string;
  issues: readonly string[];
} {
  return { status: "invalid", error, issues };
}

function inputAsJson(
  input: unknown,
):
  | { ok: true; value: unknown }
  | { ok: false; result: ProjectDesignParseResult } {
  if (typeof input === "string") {
    if (byteLength(input) > PROJECT_DESIGN_LIMITS.maxJsonBytes) {
      return {
        ok: false,
        result: invalidResult(
          `design-project.json exceeds ${PROJECT_DESIGN_LIMITS.maxJsonBytes} bytes`,
        ),
      };
    }
    try {
      return { ok: true, value: JSON.parse(input) as unknown };
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      return {
        ok: false,
        result: invalidResult(
          `design-project.json is invalid JSON: ${message}`,
        ),
      };
    }
  }

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      result: invalidResult("design-project must be a JSON object"),
    };
  }

  try {
    const encoded = JSON.stringify(input);
    if (
      typeof encoded !== "string" ||
      byteLength(encoded) > PROJECT_DESIGN_LIMITS.maxJsonBytes
    ) {
      return {
        ok: false,
        result: invalidResult(
          `design-project.json exceeds ${PROJECT_DESIGN_LIMITS.maxJsonBytes} bytes`,
        ),
      };
    }
  } catch {
    return {
      ok: false,
      result: invalidResult("design-project must contain JSON-compatible data"),
    };
  }
  return { ok: true, value: input };
}

/** Parse JSON or a JSON-shaped value without executing any project content. */
export function parseProjectDesign(input: unknown): ProjectDesignParseResult {
  const json = inputAsJson(input);
  if (!json.ok) return json.result;
  const parsed = projectDesignSchema.safeParse(json.value);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    return invalidResult(issues[0] ?? "invalid design-project schema", issues);
  }
  return { status: "ready", design: parsed.data };
}

function rootAuthorityPaths(files: unknown): string[] | undefined {
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    return undefined;
  }
  return Object.keys(files).filter(
    (path) => path.toLowerCase() === PROJECT_DESIGN_PATH.toLowerCase(),
  );
}

/** Read the root authority from ProjectFiles; nested lookalikes are ignored. */
export function readProjectDesign(
  files: ProjectFiles,
): ProjectDesignReadResult {
  const authorityPaths = rootAuthorityPaths(files);
  if (!authorityPaths) {
    return {
      path: PROJECT_DESIGN_PATH,
      ...invalidResult("ProjectFiles must be a record of text files"),
    };
  }
  const filesValidation = validateProjectFiles(files);
  if (!filesValidation.ok) {
    return {
      path: PROJECT_DESIGN_PATH,
      ...invalidResult(filesValidation.error),
    };
  }
  if (authorityPaths.length === 0) {
    return { status: "missing", path: PROJECT_DESIGN_PATH };
  }
  if (authorityPaths.length > 1 || authorityPaths[0] !== PROJECT_DESIGN_PATH) {
    return {
      path: PROJECT_DESIGN_PATH,
      ...invalidResult(
        `ProjectFiles must contain exactly one canonical ${PROJECT_DESIGN_PATH} authority`,
      ),
    };
  }

  const content = (files as Record<string, unknown>)[PROJECT_DESIGN_PATH];
  if (typeof content !== "string") {
    return {
      path: PROJECT_DESIGN_PATH,
      ...invalidResult(`${PROJECT_DESIGN_PATH} must contain text content`),
    };
  }
  const parsed = parseProjectDesign(content);
  return parsed.status === "ready"
    ? { status: "ready", path: PROJECT_DESIGN_PATH, design: parsed.design }
    : { path: PROJECT_DESIGN_PATH, ...parsed };
}

function sortedById<T extends { id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => compareStableStrings(a.id, b.id));
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort(compareStableStrings);
}

function compareStableStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalDesign(design: ProjectDesign): ProjectDesign {
  return {
    schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION,
    productGoal: design.productGoal,
    audience: design.audience,
    revision: design.revision,
    pages: design.pages.map((page) => ({
      id: page.id,
      name: page.name,
      responsibility: page.responsibility,
      route: page.route,
      ...(page.previewPath !== undefined
        ? { previewPath: page.previewPath }
        : {}),
      kind: page.kind,
      parentId: page.parentId,
      layoutId: page.layoutId,
      filePaths: sortedIds(page.filePaths),
      sharedUiRefs: sortedIds(page.sharedUiRefs),
      flowIds: sortedIds(page.flowIds),
    })),
    layouts: sortedById(design.layouts).map((layout) => ({
      id: layout.id,
      name: layout.name,
      kind: layout.kind,
      filePaths: sortedIds(layout.filePaths),
      pageIds: sortedIds(layout.pageIds),
      sharedUiRefs: sortedIds(layout.sharedUiRefs),
    })),
    sharedUiRefs: sortedById(design.sharedUiRefs).map((ref) => ({
      id: ref.id,
      name: ref.name,
      kind: ref.kind,
      filePaths: sortedIds(ref.filePaths),
    })),
    flows: sortedById(design.flows).map((flow) => ({
      id: flow.id,
      name: flow.name,
      pageIds: sortedIds(flow.pageIds),
    })),
    ...(design.tasks ? { tasks: sortedById(design.tasks) } : {}),
    ...(design.journal ? { journal: design.journal } : {}),
    buildProgress: {
      status: design.buildProgress.status,
      percent: design.buildProgress.percent,
      completedPageIds: sortedIds(design.buildProgress.completedPageIds),
      completedFlowIds: sortedIds(design.buildProgress.completedFlowIds),
      checkpoints: [...design.buildProgress.checkpoints]
        .sort(
          (left, right) =>
            compareStableStrings(left.recordedAt, right.recordedAt) ||
            compareStableStrings(left.phase, right.phase),
        )
        .map((checkpoint) => ({
          phase: checkpoint.phase,
          status: checkpoint.status,
          pageIds: sortedIds(checkpoint.pageIds),
          flowIds: sortedIds(checkpoint.flowIds),
          artifactPaths: sortedIds(checkpoint.artifactPaths),
          validation: { ...checkpoint.validation },
          recordedAt: checkpoint.recordedAt,
        })),
    },
  };
}

/** Stable identity for affected targets; progress and prose do not change visuals. */
export function getProjectDesignStructureFingerprint(
  design: ProjectDesign,
): string {
  const canonical = canonicalDesign(design);
  return JSON.stringify({
    pages: sortedById(canonical.pages).map(
      ({
        id,
        route,
        previewPath,
        parentId,
        layoutId,
        filePaths,
        sharedUiRefs,
        flowIds,
      }) => ({
        id,
        route,
        previewPath,
        parentId,
        layoutId,
        filePaths,
        sharedUiRefs,
        flowIds,
      }),
    ),
    layouts: canonical.layouts.map(
      ({ id, filePaths, pageIds, sharedUiRefs }) => ({
        id,
        filePaths,
        pageIds,
        sharedUiRefs,
      }),
    ),
    sharedUiRefs: canonical.sharedUiRefs.map(({ id, filePaths }) => ({
      id,
      filePaths,
    })),
    flows: canonical.flows.map(({ id, pageIds }) => ({
      id,
      pageIds,
    })),
  });
}

function validatedDesign(input: unknown): ProjectDesign {
  const result = parseProjectDesign(input);
  if (result.status === "invalid") {
    throw new Error(result.error);
  }
  return result.design;
}

/** Stable two-space JSON with a final newline; no project content is run. */
export function serializeProjectDesign(input: unknown): string {
  const design = canonicalDesign(validatedDesign(input));
  return `${JSON.stringify(design, null, 2)}\n`;
}

/** Upsert the single root authority without mutating the caller's ProjectFiles. */
export function upsertProjectDesign(
  files: ProjectFiles,
  input: unknown,
): ProjectFiles {
  const authorityPaths = rootAuthorityPaths(files);
  if (!authorityPaths) {
    throw new Error("ProjectFiles must be a record of text files");
  }
  const filesValidation = validateProjectFiles(files);
  if (!filesValidation.ok) throw new Error(filesValidation.error);
  if (
    authorityPaths.some((path) => path !== PROJECT_DESIGN_PATH) ||
    authorityPaths.length > 1
  ) {
    throw new Error(
      `ProjectFiles must contain exactly one canonical ${PROJECT_DESIGN_PATH} authority`,
    );
  }
  const content = serializeProjectDesign(input);
  const updated = { ...files, [PROJECT_DESIGN_PATH]: content };
  const updatedValidation = validateProjectFiles(updated);
  if (!updatedValidation.ok) throw new Error(updatedValidation.error);
  return updated;
}

export interface ProjectDesignUpsertReady {
  status: "ready";
  files: ProjectFiles;
}

export type ProjectDesignUpsertResult =
  | ProjectDesignUpsertReady
  | { status: "invalid"; error: string; issues: readonly string[] };

/** Non-throwing write adapter for callers that surface validation state. */
export function tryUpsertProjectDesign(
  files: ProjectFiles,
  input: unknown,
): ProjectDesignUpsertResult {
  try {
    return { status: "ready", files: upsertProjectDesign(files, input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message);
  }
}

export type ProjectDesignUpdateResult =
  | {
      ok: true;
      files: ProjectFiles;
      design: ProjectDesign;
      action: "created" | "modified";
    }
  | { ok: false; error: string; issues?: readonly string[] };

/**
 * Shared UI/model mutation seam. Existing valid authority requires compare and
 * swap, and every successful update must advance its revision.
 */
export function applyProjectDesignUpdate(
  files: ProjectFiles,
  input: unknown,
  expectedRevision?: ProjectDesignRevision,
): ProjectDesignUpdateResult {
  const current = readProjectDesign(files);
  if (current.status === "ready") {
    if (
      expectedRevision === undefined ||
      !Object.is(expectedRevision, current.design.revision)
    ) {
      return { ok: false, error: "The project design revision is stale." };
    }
  } else if (expectedRevision !== undefined) {
    return {
      ok: false,
      error:
        current.status === "invalid"
          ? "The invalid project design has no trusted revision. Omit expectedRevision to replace it."
          : "The project design does not exist yet.",
    };
  }

  const updated = tryUpsertProjectDesign(files, input);
  if (updated.status === "invalid") {
    return { ok: false, error: updated.error, issues: updated.issues };
  }
  const next = readProjectDesign(updated.files);
  if (next.status !== "ready") {
    return {
      ok: false,
      error: "The project design could not be read after validation.",
    };
  }
  if (
    current.status === "ready" &&
    Object.is(next.design.revision, current.design.revision)
  ) {
    return {
      ok: false,
      error: "The project design revision must advance on update.",
    };
  }
  return {
    ok: true,
    files: updated.files,
    design: next.design,
    action: current.status === "missing" ? "created" : "modified",
  };
}

function nextDesignRevision(
  previous?: ProjectDesignRevision,
): ProjectDesignRevision {
  return typeof previous === "number" && previous < Number.MAX_SAFE_INTEGER
    ? previous + 1
    : previous === undefined
      ? 1
      : crypto.randomUUID();
}

/** Legacy document inputs retain whole-collection replacement semantics. */
export function applyProjectDesignToolUpdate(
  files: ProjectFiles,
  input: unknown,
  expectedRevision?: ProjectDesignRevision,
): ProjectDesignUpdateResult & { warnings?: readonly string[] } {
  return applyProjectDesignToolRequest(files, {
    document: input,
    expected_revision: expectedRevision,
  });
}

/** One tool transaction: merge first, validate structure, then compare and swap. */
export function applyProjectDesignToolRequest(
  files: ProjectFiles,
  input: unknown,
): ProjectDesignUpdateResult & { warnings?: readonly string[] } {
  const parsed = projectDesignToolInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    return {
      ok: false,
      error: issues[0] ?? "Invalid blueprint update",
      issues,
    };
  }
  const request = parsed.data;
  const {
    pageCount,
    flowCount,
    journal: echoedJournal,
    ...changes
  } = request.patch ?? request.document!;
  const removals = request.remove;
  const hasChanges =
    Object.entries(changes).some(([key, value]) =>
      key === "buildProgress"
        ? value && Object.values(value).some((field) => field !== undefined)
        : key !== "schemaVersion" && key !== "revision" && value !== undefined,
    ) || Object.values(removals ?? {}).some((ids) => ids.length > 0);
  if (!hasChanges)
    return {
      ok: false,
      error:
        "The input contains only a summary or revision metadata. Send actual fields in patch; summary counts cannot replace a blueprint. No files were changed.",
    };
  const current = readProjectDesign(files);
  const previous = current.status === "ready" ? current.design : undefined;
  if (current.status === "invalid" && request.patch)
    return {
      ok: false,
      error:
        "The blueprint JSON is invalid. Use document to replace it explicitly; a patch cannot recover unreadable data.",
    };
  const document: Record<string, unknown> = {
    ...previous,
    ...changes,
    schemaVersion: PROJECT_DESIGN_SCHEMA_VERSION,
    revision: changes.revision ?? nextDesignRevision(previous?.revision),
    buildProgress: { ...previous?.buildProgress, ...changes.buildProgress },
  };
  if (request.patch) {
    for (const key of entityCollections) {
      const updates = request.patch[key];
      const removed = new Set(removals?.[key] ?? []);
      if (updates === undefined && removed.size === 0) continue;
      const existing = new Map<string, Record<string, unknown>>(
        (previous?.[key] ?? []).map((entry) => [entry.id, { ...entry }]),
      );
      const seen = new Set<string>();
      for (const update of updates ?? []) {
        if (seen.has(update.id) || removed.has(update.id))
          return {
            ok: false,
            error: `Conflicting ${key} update for "${update.id}".`,
          };
        seen.add(update.id);
        const supplied = Object.fromEntries(
          Object.entries(update).filter(([, value]) => value !== undefined),
        );
        existing.set(update.id, { ...existing.get(update.id), ...supplied });
      }
      for (const id of removed) existing.delete(id);
      document[key] = [...existing.values()];
    }
  }
  const updated = applyProjectDesignUpdate(
    files,
    document,
    request.expected_revision ?? previous?.revision,
  );
  if (!updated.ok) return updated;
  const warnings = getProjectDesignDiagnostics(updated.design).map(
    (issue) => `${issue.path}: ${issue.message}`,
  );
  if (echoedJournal !== undefined)
    warnings.unshift(
      "Ignored supplied journal; recovery records are maintained by the Host.",
    );
  if ([pageCount, flowCount].some((count) => count !== undefined))
    warnings.unshift(
      "Ignored summary counts; counts are derived from blueprint entities.",
    );
  return { ...updated, warnings };
}

/** Append recovery information before the same source-file transaction commits. */
export function appendProjectDesignJournal(
  files: ProjectFiles,
  entry: ProjectDesignJournalEntry,
  previousFiles: ProjectFiles = files,
): ProjectFiles {
  const current = readProjectDesign(files);
  if (current.status !== "ready") return files;
  const checked = journalEntrySchema.parse(entry);
  const journal = current.design.journal ?? [];
  if (
    journal.some(
      (item) =>
        item.operationId === checked.operationId &&
        item.requestId === checked.requestId,
    )
  )
    return files;
  const previous = readProjectDesign(previousFiles);
  const revision =
    previous.status === "ready" &&
    Object.is(previous.design.revision, current.design.revision)
      ? nextDesignRevision(current.design.revision)
      : current.design.revision;
  return upsertProjectDesign(files, {
    ...current.design,
    revision,
    journal: [...journal, checked],
  });
}

export interface ProjectPageTreeNode extends ProjectDesignPage {
  children: ProjectPageTreeNode[];
}

/** Build a deterministic page tree from the validated page parent relation. */
export function derivePageTree(
  input: ProjectDesign,
): readonly ProjectPageTreeNode[] {
  const design = validatedDesign(input);
  const nodes = new Map<string, ProjectPageTreeNode>();
  for (const page of design.pages) {
    nodes.set(page.id, { ...page, children: [] });
  }
  const roots: ProjectPageTreeNode[] = [];
  for (const page of design.pages) {
    const node = nodes.get(page.id)!;
    const parent = page.parentId ? nodes.get(page.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

interface ProjectDesignChanges {
  ids: readonly string[];
  filePaths: readonly string[];
}

function assertChangedIds(changedIds: readonly string[]): ProjectDesignChanges {
  if (
    !Array.isArray(changedIds) ||
    changedIds.length > PROJECT_DESIGN_LIMITS.maxChangedIds
  ) {
    throw new Error(
      `changed ids must contain at most ${PROJECT_DESIGN_LIMITS.maxChangedIds} items`,
    );
  }
  const ids: string[] = [];
  const filePaths: string[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  changedIds.forEach((id) => {
    if (typeof id !== "string") throw new Error("changed ids must be strings");
    const parsedId = stableIdSchema.safeParse(id);
    if (parsedId.success) {
      if (!seenIds.has(parsedId.data)) {
        seenIds.add(parsedId.data);
        ids.push(parsedId.data);
      }
      return;
    }
    const parsedPath = filePathSchema.safeParse(id);
    if (!parsedPath.success) {
      throw new Error(`invalid changed id or path "${id}"`);
    }
    const key = parsedPath.data.toLowerCase();
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      filePaths.push(parsedPath.data);
    }
  });
  return { ids, filePaths };
}

/** Return stable page IDs affected by changed entities or normalized project file paths. */
export function deriveImpactPages(
  input: ProjectDesign,
  changedIds: readonly string[],
): readonly string[] {
  const design = validatedDesign(input);
  const changes = assertChangedIds(changedIds);
  const changedIdsSet = new Set(changes.ids);
  const changedPaths = new Set(
    changes.filePaths.map((path) => path.toLowerCase()),
  );
  const impacted = new Set<string>();
  const pageById = new Map(design.pages.map((page) => [page.id, page]));

  const changedSharedUiIds = new Set(
    design.sharedUiRefs
      .filter(
        (ref) =>
          changedIdsSet.has(ref.id) ||
          ref.filePaths.some((path) => changedPaths.has(path.toLowerCase())),
      )
      .map((ref) => ref.id),
  );
  const changedLayoutIds = new Set(
    design.layouts
      .filter(
        (layout) =>
          changedIdsSet.has(layout.id) ||
          layout.filePaths.some((path) =>
            changedPaths.has(path.toLowerCase()),
          ) ||
          layout.sharedUiRefs.some((id) => changedSharedUiIds.has(id)),
      )
      .map((layout) => layout.id),
  );
  const changedFlowIds = new Set(
    design.flows
      .filter((flow) => changedIdsSet.has(flow.id))
      .map((flow) => flow.id),
  );

  for (const page of design.pages) {
    if (
      changedIdsSet.has(page.id) ||
      page.filePaths.some((path) => changedPaths.has(path.toLowerCase())) ||
      (page.layoutId !== null && changedLayoutIds.has(page.layoutId)) ||
      page.sharedUiRefs.some((id) => changedSharedUiIds.has(id)) ||
      page.flowIds.some((id) => changedFlowIds.has(id))
    ) {
      impacted.add(page.id);
    }
  }
  for (const layout of design.layouts) {
    if (!changedLayoutIds.has(layout.id)) continue;
    layout.pageIds.forEach((pageId) => {
      if (pageById.has(pageId)) impacted.add(pageId);
    });
    for (const page of design.pages) {
      if (page.layoutId === layout.id) impacted.add(page.id);
    }
  }
  for (const flow of design.flows) {
    if (!changedFlowIds.has(flow.id)) {
      continue;
    }
    flow.pageIds.forEach((pageId) => {
      if (pageById.has(pageId)) impacted.add(pageId);
    });
    for (const page of design.pages) {
      if (page.flowIds.includes(flow.id)) impacted.add(page.id);
    }
  }
  return sortedIds([...impacted]);
}

export interface ProjectDesignCoverageTarget {
  id: string;
  pageId: string;
  route: string;
}

/** Usable coverage only; callers surface unavailable page diagnostics. */
export function deriveCoverageTargets(
  input: ProjectDesign,
): readonly ProjectDesignCoverageTarget[] {
  const design = validatedDesign(input);
  const targets: ProjectDesignCoverageTarget[] = [];
  for (const page of sortedById(design.pages)) {
    const resolution = resolvePrototypeRoute(design, page.id);
    if (resolution.status === "ready")
      targets.push({
        id: page.id,
        pageId: page.id,
        route: resolution.target.route,
      });
  }
  return targets;
}

export function resolveProjectDesignPreview(
  input: ProjectDesign,
  pageId: string,
): PrototypeRouteResolution {
  return resolvePrototypeRoute(input, pageId);
}
export function resolveProjectDesignPreviewTarget(
  input: ProjectDesign,
  pageId: string,
): PrototypePreviewTarget | null {
  const result = resolveProjectDesignPreview(input, pageId);
  return result.status === "ready" ? result.target : null;
}
export function resolveProjectDesignPreviewRoute(
  input: ProjectDesign,
  route: string,
): PrototypePreviewTarget | null {
  const result = resolveObservedPrototypeRoute(input, route);
  return result.status === "ready" ? result.target : null;
}

export interface IncompleteBuildProgress {
  status: BuildProgressStatus;
  percent: number;
  pageIds: readonly string[];
  flowIds: readonly string[];
  phaseIds: readonly (typeof PROJECT_DESIGN_BATCH_PHASES)[number][];
  nextPhase?: (typeof PROJECT_DESIGN_BATCH_PHASES)[number];
}

/** Resolve the bounded lists of pages and flows still absent from build progress. */
export function getIncompleteBuildProgress(
  input: ProjectDesign,
): IncompleteBuildProgress {
  const design = validatedDesign(input);
  const completedPages = new Set(design.buildProgress.completedPageIds);
  const completedFlows = new Set(design.buildProgress.completedFlowIds);
  return {
    status: design.buildProgress.status,
    percent: design.buildProgress.percent,
    pageIds: sortedIds(
      design.pages
        .filter((page) => !completedPages.has(page.id))
        .map((page) => page.id),
    ),
    flowIds: sortedIds(
      design.flows
        .filter((flow) => !completedFlows.has(flow.id))
        .map((flow) => flow.id),
    ),
    phaseIds: [],
  };
}

export const deriveIncompleteBuildProgress = getIncompleteBuildProgress;

/** Revision equality is the stale-write guard used by Project Design callers. */
export function isProjectDesignRevisionStale(
  expectedRevision: ProjectDesignRevision,
  currentRevision: ProjectDesignRevision,
): boolean {
  const valid = (revision: ProjectDesignRevision): boolean =>
    (typeof revision === "number" &&
      Number.isSafeInteger(revision) &&
      revision >= 0) ||
    (typeof revision === "string" &&
      revision === revision.trim() &&
      revision.length > 0 &&
      revision.length <= PROJECT_DESIGN_LIMITS.maxIdChars &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(revision));
  if (!valid(expectedRevision) || !valid(currentRevision)) {
    throw new Error(
      "project design revisions must be non-negative safe integers",
    );
  }
  return expectedRevision !== currentRevision;
}

export const isStaleRevision = isProjectDesignRevisionStale;

export const parseDesignProject = parseProjectDesign;
export const readDesignProject = readProjectDesign;
export const serializeDesignProject = serializeProjectDesign;
export const upsertDesignProject = upsertProjectDesign;
