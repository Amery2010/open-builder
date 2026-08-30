import { tool } from "ai";
import { z } from "zod";
import type { SkillActiveContextController } from "../skills/active-context";

export const DESIGN_SURFACE_MODES = [
  "persuade",
  "operate",
  "read",
  "experience",
  "mixed",
] as const;

export const DESIGN_CHANGE_MODES = ["create", "extend", "migrate"] as const;

export const designContractSchema = z
  .object({
    surface_mode: z.enum(DESIGN_SURFACE_MODES),
    change_mode: z.enum(DESIGN_CHANGE_MODES),
    target: z.string().trim().min(1).max(1_000),
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
    preserve: z.array(z.string().trim().min(1).max(1_000)).min(1).max(30),
    acceptance: z.array(z.string().trim().min(1).max(1_000)).min(1).max(30),
  })
  .strict();

export type DesignSurfaceMode = (typeof DESIGN_SURFACE_MODES)[number];
export type DesignChangeMode = (typeof DESIGN_CHANGE_MODES)[number];
export type DesignContract = z.infer<typeof designContractSchema>;

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
  "apply_design_system",
  "execute_skill_script",
  // A full-write subagent can reconcile its entire file tree into the parent.
  "dispatch_subagent",
]);

export const SUBMIT_DESIGN_CONTRACT_TOOL = {
  submit_design_contract: tool({
    description:
      "Submit the run-local Design contract after inspecting the project and loading the required Design Skill. " +
      "In Design mode, init_project may run before this tool, but every other project write is blocked until the contract is accepted.",
    inputSchema: designContractSchema,
  }),
};

interface DesignContractRunPolicy {
  enabled: boolean;
  expectedChangeModes?: readonly DesignChangeMode[];
  expectedSystemId?: string | null;
}

export interface SubmitDesignContractContext {
  expectedSystemId: string | null;
  skillContext: SkillActiveContextController;
}

export interface DesignContractController {
  reset(
    policy: DesignContractRunPolicy,
    reusableContract?: DesignContract,
  ): void;
  submit(input: unknown, context: SubmitDesignContractContext): DesignContract;
  authorizeProjectWrite(toolName: string): string | undefined;
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

function cloneContract(contract: DesignContract): DesignContract {
  return {
    ...contract,
    translation: { ...contract.translation },
    preserve: [...contract.preserve],
    acceptance: [...contract.acceptance],
  };
}

export function createDesignContractController(): DesignContractController {
  let policy: DesignContractRunPolicy = { enabled: false };
  let contract: DesignContract | null = null;

  return {
    reset(nextPolicy, reusableContract) {
      policy = {
        enabled: nextPolicy.enabled,
        ...(nextPolicy.expectedSystemId !== undefined
          ? { expectedSystemId: nextPolicy.expectedSystemId }
          : {}),
        ...(nextPolicy.expectedChangeModes
          ? { expectedChangeModes: [...nextPolicy.expectedChangeModes] }
          : {}),
      };
      if (!reusableContract) {
        contract = null;
        return;
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
      contract = cloneContract(parsed);
    },

    submit(input, context) {
      if (!policy.enabled) {
        throw new Error(
          "submit_design_contract is available only during a Design run.",
        );
      }
      const parsed = designContractSchema.parse(input);
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

    authorizeProjectWrite(toolName) {
      if (
        !policy.enabled ||
        !DESIGN_GATED_WRITE_TOOLS.has(toolName) ||
        toolName === "init_project" ||
        contract
      ) {
        return undefined;
      }
      return (
        `Design contract required before project write tool "${toolName}". ` +
        "Inspect the project, load the correct Design Skill, and call submit_design_contract first."
      );
    },

    getContract() {
      return contract ? cloneContract(contract) : null;
    },

    isReady() {
      return !policy.enabled || contract !== null;
    },
  };
}
