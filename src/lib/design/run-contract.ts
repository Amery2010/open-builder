import { z } from "zod";
import type { SkillActiveContextController } from "../skills/active-context";
import { getSubagentByName } from "../ai/subagents/registry";
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

const blueprintKnownPageIdsSchema = z
  .array(blueprintIdSchema)
  .max(BLUEPRINT_LIST_MAX_ITEMS)
  .superRefine(rejectDuplicateValues);

const blueprintKnownSharedFilePathsSchema = z
  .array(blueprintPathSchema)
  .max(BLUEPRINT_LIST_MAX_ITEMS)
  .superRefine(rejectDuplicateValues);

const blueprintKnownSharedUiIdsSchema = z
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

/** Trusted run bindings for the optional blueprint scope. */
export interface DesignBlueprintScopeBindings {
  expectedRevision?: DesignBlueprintRevision;
  knownPageIds?: readonly string[];
  knownSharedFilePaths?: readonly string[];
  knownSharedUiIds?: readonly string[];
  knownPageFilePaths?: Readonly<Record<string, readonly string[]>>;
}

const DESIGN_GATED_WRITE_TOOLS = new Set([
  "init_project",
  "manage_dependencies",
  "write_file",
  "patch_file",
  "delete_file",
  "rename_file",
  "move_file",
  "manage_env",
  "install_component",
  "screenshot_to_code",
  "apply_design_style",
  "update_design_tokens",
  "update_project_design",
  "execute_skill_script",
  // A full-write subagent can reconcile its entire file tree into the parent.
  "dispatch_subagent",
]);

export interface DesignContractRunPolicy {
  enabled: boolean;
  /** Invalid root blueprint recovery: only update_project_design may run. */
  allowProjectDesignRepair?: boolean;
  expectedChangeModes?: readonly DesignChangeMode[];
  expectedSystemId?: string | null;
  blueprint?: DesignBlueprintScopeBindings;
  /** Flat fields keep this policy compatible with the existing system/change bindings. */
  expectedBlueprintRevision?: DesignBlueprintRevision;
  knownBlueprintPageIds?: readonly string[];
  knownBlueprintSharedFilePaths?: readonly string[];
  knownBlueprintSharedUiIds?: readonly string[];
  knownBlueprintPageFilePaths?: Readonly<Record<string, readonly string[]>>;
}

export interface SubmitDesignContractContext {
  expectedSystemId: string | null;
  skillContext: SkillActiveContextController;
  blueprint?: DesignBlueprintScopeBindings;
  expectedBlueprintRevision?: DesignBlueprintRevision;
  knownBlueprintPageIds?: readonly string[];
  knownBlueprintSharedFilePaths?: readonly string[];
  knownBlueprintSharedUiIds?: readonly string[];
  knownBlueprintPageFilePaths?: Readonly<Record<string, readonly string[]>>;
}

export interface DesignContractController {
  reset(
    policy: DesignContractRunPolicy,
    reusableContract?: DesignContract,
  ): void;
  submit(input: unknown, context: SubmitDesignContractContext): DesignContract;
  authorizeProjectWrite(toolName: string, args?: unknown): string | undefined;
  getContract(): DesignContract | null;
  isReady(): boolean;
}

function requiredSkillIds(surfaceMode: DesignSurfaceMode): readonly string[] {
  if (surfaceMode === "operate") return ["design-product-ui"];
  if (surfaceMode === "mixed") {
    return ["design-product-ui", "art-direct-web"];
  }
  return ["art-direct-web"];
}

interface NormalizedBlueprintScopeBindings {
  enabled: boolean;
  expectedRevision?: DesignBlueprintRevision;
  knownPageIds?: ReadonlySet<string>;
  knownSharedFilePaths?: ReadonlySet<string>;
  knownSharedUiIds?: ReadonlySet<string>;
  knownPageFilePaths?: ReadonlyMap<string, ReadonlySet<string>>;
}

type BlueprintBindingOwner =
  DesignContractRunPolicy | SubmitDesignContractContext;

function hasBlueprintBindingFields(owner: BlueprintBindingOwner): boolean {
  return (
    owner.blueprint !== undefined ||
    owner.expectedBlueprintRevision !== undefined ||
    owner.knownBlueprintPageIds !== undefined ||
    owner.knownBlueprintSharedFilePaths !== undefined ||
    owner.knownBlueprintSharedUiIds !== undefined ||
    owner.knownBlueprintPageFilePaths !== undefined
  );
}

function parseBindingRevision(
  value: unknown,
): DesignBlueprintRevision | undefined {
  if (value === undefined) return undefined;
  const parsed = blueprintRevisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("The expected Design blueprint revision is invalid.");
  }
  return parsed.data;
}

function resolveBindingField(
  nestedValue: unknown,
  flatValue: unknown,
  label: string,
): unknown {
  if (
    nestedValue !== undefined &&
    flatValue !== undefined &&
    JSON.stringify(nestedValue) !== JSON.stringify(flatValue)
  ) {
    throw new Error(`The Design blueprint ${label} binding is ambiguous.`);
  }
  return nestedValue ?? flatValue;
}

function parseKnownBindingList<T>(
  value: unknown,
  schema: z.ZodType<T>,
  label: string,
): T | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`The known Design blueprint ${label} list is invalid.`);
  }
  return parsed.data;
}

function normalizeBlueprintBindings(
  owner: BlueprintBindingOwner,
): NormalizedBlueprintScopeBindings {
  const nested = owner.blueprint;
  if (nested !== undefined && (!nested || typeof nested !== "object")) {
    throw new Error("The Design blueprint bindings are invalid.");
  }

  const expectedRevision = parseBindingRevision(
    resolveBindingField(
      nested?.expectedRevision,
      owner.expectedBlueprintRevision,
      "revision",
    ),
  );
  const knownPageIds = parseKnownBindingList(
    resolveBindingField(
      nested?.knownPageIds,
      owner.knownBlueprintPageIds,
      "page id",
    ),
    blueprintKnownPageIdsSchema,
    "page id",
  );
  const knownSharedFilePaths = parseKnownBindingList(
    resolveBindingField(
      nested?.knownSharedFilePaths,
      owner.knownBlueprintSharedFilePaths,
      "shared file path",
    ),
    blueprintKnownSharedFilePathsSchema,
    "shared file path",
  );
  const knownSharedUiIds = parseKnownBindingList(
    resolveBindingField(
      nested?.knownSharedUiIds,
      owner.knownBlueprintSharedUiIds,
      "shared UI id",
    ),
    blueprintKnownSharedUiIdsSchema,
    "shared UI id",
  );
  const rawPageFilePaths = resolveBindingField(
    nested?.knownPageFilePaths,
    owner.knownBlueprintPageFilePaths,
    "page file path",
  );
  let knownPageFilePaths: Map<string, ReadonlySet<string>> | undefined;
  if (rawPageFilePaths !== undefined) {
    if (!rawPageFilePaths || typeof rawPageFilePaths !== "object") {
      throw new Error(
        "The known Design blueprint page file paths are invalid.",
      );
    }
    knownPageFilePaths = new Map();
    for (const [pageId, paths] of Object.entries(rawPageFilePaths)) {
      const parsedId = blueprintIdSchema.safeParse(pageId);
      const parsedPaths = blueprintKnownSharedFilePathsSchema.safeParse(paths);
      if (!parsedId.success || !parsedPaths.success) {
        throw new Error(
          "The known Design blueprint page file paths are invalid.",
        );
      }
      knownPageFilePaths.set(
        parsedId.data,
        new Set(parsedPaths.data.map((path) => path.toLowerCase())),
      );
    }
  }

  return {
    enabled: hasBlueprintBindingFields(owner),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    ...(knownPageIds !== undefined
      ? { knownPageIds: new Set(knownPageIds) }
      : {}),
    ...(knownSharedFilePaths !== undefined
      ? {
          knownSharedFilePaths: new Set(
            knownSharedFilePaths.map((path) => path.toLowerCase()),
          ),
        }
      : {}),
    ...(knownSharedUiIds !== undefined
      ? { knownSharedUiIds: new Set(knownSharedUiIds) }
      : {}),
    ...(knownPageFilePaths ? { knownPageFilePaths } : {}),
  };
}

function blueprintScopeForContract(
  value: DesignContract,
): DesignBlueprintScope | null {
  return value.blueprint ?? null;
}

function unknownBlueprintValues(
  values: readonly string[],
  known: ReadonlySet<string>,
  caseInsensitive = false,
): string[] {
  return values.filter(
    (value) => !known.has(caseInsensitive ? value.toLowerCase() : value),
  );
}

function validateBlueprintScope(
  scope: DesignBlueprintScope | null,
  bindings: NormalizedBlueprintScopeBindings,
): void {
  if (!bindings.enabled) return;
  if (!scope) {
    throw new Error(
      "A Design blueprint scope is required for this run and must be submitted with the contract.",
    );
  }
  if (
    bindings.expectedRevision !== undefined &&
    !Object.is(scope.revision, bindings.expectedRevision)
  ) {
    throw new Error(
      "Design blueprint revision is stale or does not match the current blueprint.",
    );
  }
  if (bindings.knownPageIds) {
    const unknown = scope.target_page_ids.filter(
      (pageId) => !bindings.knownPageIds?.has(pageId),
    );
    if (unknown.length > 0) {
      throw new Error(
        `Design blueprint target_page_ids contains unknown page id(s): ${unknown.join(", ")}.`,
      );
    }
  }
  if (bindings.knownSharedFilePaths) {
    const unknown = unknownBlueprintValues(
      scope.shared_scope.file_paths,
      bindings.knownSharedFilePaths,
      true,
    );
    if (unknown.length > 0) {
      throw new Error(
        `Design blueprint shared_scope.file_paths contains unknown path(s): ${unknown.join(", ")}.`,
      );
    }
  }
  if (bindings.knownSharedUiIds) {
    const unknown = scope.shared_scope.ui_ids.filter(
      (uiId) => !bindings.knownSharedUiIds?.has(uiId),
    );
    if (unknown.length > 0) {
      throw new Error(
        `Design blueprint shared_scope.ui_ids contains unknown id(s): ${unknown.join(", ")}.`,
      );
    }
  }
}

const DESIGN_AUTHORITY_FILE_NAMES = new Set(["design.md", "tokens.css"]);

function isDesignAuthorityPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    !normalized.includes("/") && DESIGN_AUTHORITY_FILE_NAMES.has(normalized)
  );
}

function normalizeWritePath(value: unknown, label: string): string {
  const checked = normalizeProjectPath(value);
  if (!checked.ok) {
    throw new Error(`Design blueprint ${label} is unsafe: ${checked.error}.`);
  }
  if (isSensitiveProjectPath(checked.path)) {
    throw new Error(
      `Design blueprint ${label} is unsafe: sensitive project paths are not in scope.`,
    );
  }
  return checked.path;
}

type BlueprintWritePathResult =
  | { kind: "paths"; paths: string[] }
  | { kind: "trusted-authority" }
  | { kind: "unavailable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function writePathsForTool(
  toolName: string,
  args: unknown,
): BlueprintWritePathResult {
  if (
    toolName === "apply_design_style" ||
    toolName === "update_design_tokens" ||
    toolName === "update_project_design"
  ) {
    // These host operations have fixed, root-level authority targets.
    return { kind: "trusted-authority" };
  }
  if (toolName === "manage_dependencies") {
    return { kind: "paths", paths: ["package.json"] };
  }
  if (toolName === "manage_env") {
    // The operation can also generate src/env.ts. The .env paths cannot be
    // admitted to a blueprint scope, so this remains fail-closed below.
    return { kind: "paths", paths: [".env", ".env.example", "src/env.ts"] };
  }
  if (!isRecord(args)) return { kind: "unavailable" };

  switch (toolName) {
    case "write_file":
    case "patch_file":
    case "delete_file":
      return {
        kind: "paths",
        paths: [normalizeWritePath(args.path, "path")],
      };
    case "screenshot_to_code":
      if (args.output_path === undefined) return { kind: "unavailable" };
      return {
        kind: "paths",
        paths: [normalizeWritePath(args.output_path, "output_path")],
      };
    case "rename_file":
      return {
        kind: "paths",
        paths: [
          normalizeWritePath(args.old_path, "old_path"),
          normalizeWritePath(args.new_path, "new_path"),
        ],
      };
    case "move_file": {
      const path = normalizeWritePath(args.path, "path");
      if (typeof args.target_dir !== "string") {
        throw new Error(
          "Design blueprint move_file target_dir must be a safe project path.",
        );
      }
      const targetDir = args.target_dir.trim()
        ? normalizeWritePath(args.target_dir, "target_dir")
        : "";
      const basename = path.slice(path.lastIndexOf("/") + 1);
      return {
        kind: "paths",
        paths: [path, targetDir ? `${targetDir}/${basename}` : basename],
      };
    }
    default:
      return { kind: "unavailable" };
  }
}

function blueprintWriteScopeError(toolName: string, reason: string): string {
  return `Design blueprint scope rejected project write tool "${toolName}": ${reason}`;
}

function cloneContract(contract: DesignContract): DesignContract {
  const cloned: DesignContract = {
    ...contract,
    translation: { ...contract.translation },
    preserve: [...contract.preserve],
    acceptance: [...contract.acceptance],
  };
  if (contract.blueprint) {
    cloned.blueprint = {
      ...contract.blueprint,
      target_page_ids: [...contract.blueprint.target_page_ids],
      shared_scope: {
        file_paths: [...contract.blueprint.shared_scope.file_paths],
        ui_ids: [...contract.blueprint.shared_scope.ui_ids],
      },
    };
  }
  return cloned;
}

export function createDesignContractController(): DesignContractController {
  let policy: DesignContractRunPolicy = { enabled: false };
  let blueprintPolicy: NormalizedBlueprintScopeBindings = { enabled: false };
  let contract: DesignContract | null = null;

  return {
    reset(nextPolicy, reusableContract) {
      const nextBlueprintPolicy = normalizeBlueprintBindings(nextPolicy);
      policy = {
        enabled: nextPolicy.enabled,
        ...(nextPolicy.allowProjectDesignRepair
          ? { allowProjectDesignRepair: true }
          : {}),
        ...(nextPolicy.expectedSystemId !== undefined
          ? { expectedSystemId: nextPolicy.expectedSystemId }
          : {}),
        ...(nextPolicy.expectedChangeModes
          ? { expectedChangeModes: [...nextPolicy.expectedChangeModes] }
          : {}),
      };
      blueprintPolicy = nextBlueprintPolicy;
      if (!reusableContract) {
        contract = null;
        return;
      }
      if (policy.allowProjectDesignRepair) {
        throw new Error(
          "Repair the invalid project design before reusing a Design contract.",
        );
      }
      const parsed = designContractSchema.parse(reusableContract);
      if (
        policy.expectedSystemId !== undefined &&
        parsed.system_id !== policy.expectedSystemId
      ) {
        throw new Error(
          "The reusable Design contract no longer matches the applied Design system.",
        );
      }
      if (
        policy.expectedChangeModes &&
        !policy.expectedChangeModes.includes(parsed.change_mode)
      ) {
        throw new Error(
          "The reusable Design contract no longer matches the required change mode.",
        );
      }
      validateBlueprintScope(
        blueprintScopeForContract(parsed),
        blueprintPolicy,
      );
      contract = cloneContract(parsed);
    },

    submit(input, context) {
      if (!policy.enabled) {
        throw new Error(
          "submit_design_contract is available only during a Design run.",
        );
      }
      if (policy.allowProjectDesignRepair) {
        throw new Error(
          "Repair the invalid project design with update_project_design before submitting a Design contract.",
        );
      }
      const parsed = designContractSchema.parse(input);
      const contextBlueprintPolicy = normalizeBlueprintBindings(context);
      if (
        blueprintPolicy.expectedRevision !== undefined &&
        contextBlueprintPolicy.expectedRevision !== undefined &&
        !Object.is(
          blueprintPolicy.expectedRevision,
          contextBlueprintPolicy.expectedRevision,
        )
      ) {
        throw new Error(
          "The Design blueprint revision binding changed while this run was active.",
        );
      }
      if (parsed.system_id !== context.expectedSystemId) {
        throw new Error(
          `Design contract system_id must match the currently applied Design system (${context.expectedSystemId ?? "none"}).`,
        );
      }
      if (
        policy.expectedChangeModes &&
        !policy.expectedChangeModes.includes(parsed.change_mode)
      ) {
        throw new Error(
          `Design contract change_mode must be one of: ${policy.expectedChangeModes.join(", ")}.`,
        );
      }
      validateBlueprintScope(
        blueprintScopeForContract(parsed),
        blueprintPolicy,
      );
      validateBlueprintScope(
        blueprintScopeForContract(parsed),
        contextBlueprintPolicy,
      );
      const missingSkills = requiredSkillIds(parsed.surface_mode).filter(
        (skillId) => !context.skillContext.isActive(skillId),
      );
      if (missingSkills.length > 0) {
        throw new Error(
          `Load the required Design Skill before submitting this contract: ${missingSkills.join(", ")}.`,
        );
      }
      contract = cloneContract(parsed);
      return cloneContract(parsed);
    },

    authorizeProjectWrite(toolName, args) {
      // Registered read-only subagents can perform the required pre-contract
      // inspection. Unknown and future write-capable agents remain fail-closed.
      const requestedSubagent =
        toolName === "dispatch_subagent" &&
        args &&
        typeof args === "object" &&
        typeof (args as { subagent?: unknown }).subagent === "string"
          ? getSubagentByName((args as { subagent: string }).subagent)
          : null;
      const isKnownReadonlySubagent =
        requestedSubagent !== null &&
        (requestedSubagent.writePolicy ?? "readonly") === "readonly";
      if (
        !policy.enabled ||
        !DESIGN_GATED_WRITE_TOOLS.has(toolName) ||
        toolName === "init_project" ||
        isKnownReadonlySubagent
      ) {
        return undefined;
      }
      if (
        !contract &&
        policy.allowProjectDesignRepair &&
        toolName === "update_project_design"
      ) {
        return undefined;
      }
      if (!contract) {
        return (
          `Design contract required before project write tool "${toolName}". ` +
          "Inspect the project, load the correct Design Skill, and call submit_design_contract first."
        );
      }

      const blueprintScope = blueprintScopeForContract(contract);
      if (!blueprintScope) return undefined;
      let writePaths: BlueprintWritePathResult;
      try {
        writePaths = writePathsForTool(toolName, args);
      } catch (error) {
        return blueprintWriteScopeError(
          toolName,
          error instanceof Error
            ? error.message
            : "the requested path is unsafe",
        );
      }
      if (writePaths.kind === "trusted-authority") return undefined;
      if (writePaths.kind === "unavailable") {
        return blueprintWriteScopeError(
          toolName,
          "the write target is not explicit and cannot be proven to be in scope",
        );
      }
      const allowedPaths = new Set(
        blueprintScope.shared_scope.file_paths.map((path) =>
          path.toLowerCase(),
        ),
      );
      for (const pageId of blueprintScope.target_page_ids) {
        for (const path of blueprintPolicy.knownPageFilePaths?.get(pageId) ??
          []) {
          allowedPaths.add(path);
        }
      }
      const outOfScope = writePaths.paths.filter(
        (path) =>
          !isDesignAuthorityPath(path) && !allowedPaths.has(path.toLowerCase()),
      );
      if (outOfScope.length > 0) {
        return blueprintWriteScopeError(
          toolName,
          `path(s) outside the selected page files and shared_scope.file_paths: ${outOfScope.join(", ")}`,
        );
      }
      return undefined;
    },

    getContract() {
      return contract ? cloneContract(contract) : null;
    },

    isReady() {
      return !policy.enabled || contract !== null;
    },
  };
}
