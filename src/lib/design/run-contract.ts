import { z } from "zod";
import { normalizeProjectPath } from "../tools/fs-tools";
import { isSensitiveProjectPath } from "../utils/project-file-policy";
import { PROJECT_DESIGN_BATCH_PHASES } from "./project-design";

export const DESIGN_SURFACE_MODES = [
  "persuade",
  "operate",
  "read",
  "experience",
  "mixed",
] as const;

export const DESIGN_CHANGE_MODES = ["create", "extend", "migrate"] as const;

export const DESIGN_BLUEPRINT_BATCH_PHASES = PROJECT_DESIGN_BATCH_PHASES;

export type DesignBlueprintRevision = string | number;
export type DesignBlueprintBatchPhase =
  (typeof DESIGN_BLUEPRINT_BATCH_PHASES)[number];

const BLUEPRINT_ID_MAX_CHARS = 200;
const BLUEPRINT_PATH_MAX_CHARS = 1_000;
const BLUEPRINT_LIST_MAX_ITEMS = 200;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;

const blueprintRevisionSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(BLUEPRINT_ID_MAX_CHARS)
    .refine((value) => !CONTROL_CHARACTER_RE.test(value), {
      message: "must not contain control characters",
    }),
  z.number().int().nonnegative().safe(),
]);

const blueprintIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(BLUEPRINT_ID_MAX_CHARS)
  .refine((value) => !CONTROL_CHARACTER_RE.test(value), {
    message: "must not contain control characters",
  });

const blueprintPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(BLUEPRINT_PATH_MAX_CHARS)
  .transform((value, context) => {
    const checked = normalizeProjectPath(value);
    if (!checked.ok) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: checked.error,
      });
      return z.NEVER;
    }
    if (isSensitiveProjectPath(checked.path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sensitive project paths are not allowed",
      });
      return z.NEVER;
    }
    return checked.path;
  });

function rejectDuplicateValues(values: string[], context: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    // Project paths are treated case-insensitively at this boundary so that
    // a scope cannot contain two spellings for one authority target.
    const key = value.toLowerCase();
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must not contain duplicate value "${value}"`,
        path: [index],
      });
    }
    seen.add(key);
  }
}

const blueprintPageIdsSchema = z
  .array(blueprintIdSchema)
  .min(1)
  .max(BLUEPRINT_LIST_MAX_ITEMS)
  .superRefine(rejectDuplicateValues);

const blueprintSharedFilePathsSchema = z
  .array(blueprintPathSchema)
  .max(BLUEPRINT_LIST_MAX_ITEMS)
  .superRefine(rejectDuplicateValues);

const blueprintSharedUiIdsSchema = z
  .array(blueprintIdSchema)
  .max(BLUEPRINT_LIST_MAX_ITEMS)
  .superRefine(rejectDuplicateValues);

export const designBlueprintSharedScopeSchema = z
  .object({
    file_paths: blueprintSharedFilePathsSchema.optional().default([]),
    ui_ids: blueprintSharedUiIdsSchema.optional().default([]),
  })
  .strict();

export const designBlueprintScopeSchema = z
  .object({
    revision: blueprintRevisionSchema,
    target_page_ids: blueprintPageIdsSchema,
    shared_scope: designBlueprintSharedScopeSchema,
    batch_phase: z.enum(DESIGN_BLUEPRINT_BATCH_PHASES),
  })
  .strict();

const designContractShape = {
  surface_mode: z.enum(DESIGN_SURFACE_MODES),
  change_mode: z.enum(DESIGN_CHANGE_MODES),
  target: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .describe("The specific interface, flow, or project area to change."),
  audience: z.string().trim().min(1).max(1_000),
  primary_goal: z.string().trim().min(1).max(1_000),
  concept: z.string().trim().min(1).max(2_000),
  system_id: z.string().trim().min(1).max(100).nullable(),
  translation: z
    .object({
      foundations: z.string().trim().min(1).max(2_000),
      composition: z.string().trim().min(1).max(2_000),
      components: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  preserve: z
    .array(z.string().trim().min(1).max(1_000))
    .min(1)
    .max(30)
    .describe("Existing behavior and contracts that must remain unchanged."),
  acceptance: z.array(z.string().trim().min(1).max(1_000)).min(1).max(30),
};

/** Canonical schema shown to models and emitted by all successful parses. */
export const designContractModelSchema = z
  .object({
    ...designContractShape,
    blueprint: designBlueprintScopeSchema
      .optional()
      .describe("Optional run-bound Design blueprint scope."),
  })
  .strict();

/**
 * Host compatibility schema. Older clients may still send
 * `blueprint_scope`, but the accepted value is always normalized to the
 * canonical `blueprint` field.
 */
export const designContractSchema = z
  .object({
    ...designContractShape,
    blueprint: designBlueprintScopeSchema.optional(),
    blueprint_scope: designBlueprintScopeSchema.optional(),
  })
  .strict()
  .transform((value, context) => {
    const { blueprint_scope: legacyBlueprint, ...canonical } = value;
    if (
      canonical.blueprint &&
      legacyBlueprint &&
      JSON.stringify(canonical.blueprint) !== JSON.stringify(legacyBlueprint)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blueprint and blueprint_scope must describe the same scope",
        path: ["blueprint_scope"],
      });
      return z.NEVER;
    }
    return {
      ...canonical,
      ...((canonical.blueprint ?? legacyBlueprint)
        ? { blueprint: canonical.blueprint ?? legacyBlueprint }
        : {}),
    };
  });

export type DesignSurfaceMode = (typeof DESIGN_SURFACE_MODES)[number];
export type DesignChangeMode = (typeof DESIGN_CHANGE_MODES)[number];
export type DesignContract = z.infer<typeof designContractSchema>;

export type DesignBlueprintScope = z.infer<typeof designBlueprintScopeSchema>;
