import { SKILL_TOOL_NAME_SET } from "./tools";
import type { SkillEntry } from "./types";

export interface ActiveSkill {
  skillId: string;
  skillName: string;
  allowedTools: string[];
  activatedAt: number;
}

export interface SkillActiveContext {
  skills: ActiveSkill[];
  allowedTools: string[];
  restrictTools: boolean;
}

export interface SkillActiveContextController {
  get(): SkillActiveContext | null;
  activate(skill: SkillEntry): void;
  activateMany(skills: readonly SkillEntry[]): void;
  isActive(skillId: string): boolean;
  clear(): void;
  snapshot(): SkillActiveContext | null;
}

function cloneActiveSkill(skill: ActiveSkill): ActiveSkill {
  return {
    ...skill,
    allowedTools: [...skill.allowedTools],
  };
}

/**
 * Creates run-local Skill activation state. Each Chat/Plan/Auto QA/Subagent
 * run owns one controller so a read_skill call can never affect another run.
 */
export function createSkillActiveContext(
  initial: SkillActiveContext | null = null,
): SkillActiveContextController {
  const active = new Map<string, ActiveSkill>(
    (initial?.skills ?? []).map((skill) => [
      skill.skillId,
      cloneActiveSkill(skill),
    ]),
  );

  const controller: SkillActiveContextController = {
    get(): SkillActiveContext | null {
      const skills = Array.from(active.values(), cloneActiveSkill);
      if (skills.length === 0) return null;
      const declared = skills.filter((skill) => skill.allowedTools.length > 0);
      return {
        skills,
        allowedTools: Array.from(
          new Set(declared.flatMap((skill) => skill.allowedTools)),
        ),
        restrictTools: declared.length > 0,
      };
    },
    activate(skill: SkillEntry): void {
      active.set(skill.id, {
        skillId: skill.id,
        skillName: skill.name,
        allowedTools: [...(skill.allowedTools ?? [])],
        activatedAt: Date.now(),
      });
    },
    activateMany(skills: readonly SkillEntry[]): void {
      for (const skill of skills) controller.activate(skill);
    },
    isActive(skillId: string): boolean {
      return active.has(skillId);
    },
    clear(): void {
      active.clear();
    },
    snapshot(): SkillActiveContext | null {
      return controller.get();
    },
  };

  return controller;
}

/**
 * Legacy singleton retained for API compatibility only. Runtime code must use
 * createSkillActiveContext() and pass the controller through ToolRunContext.
 */
export const skillActiveContext = createSkillActiveContext();

/** Tools that bypass active-skill allowed-tools filtering. Flow / infrastructure tools. */
export const ALWAYS_ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SKILL_TOOL_NAME_SET,
  "ask_user_question",
  "exit_plan_mode",
  "compact_context",
  "dispatch_subagent",
  "submit_design_contract",
]);

/** Returns the live allowed-tools denial shared by Web and Local hosts. */
export function activeSkillToolRestrictionError(
  toolName: string,
  active: SkillActiveContext | null,
): string | undefined {
  if (
    !active?.restrictTools ||
    ALWAYS_ALLOWED_TOOL_NAMES.has(toolName) ||
    active.allowedTools.includes(toolName)
  ) {
    return undefined;
  }
  const activeNames = active.skills
    .map((skill) => `"${skill.skillName}"`)
    .join(", ");
  return (
    `Tool "${toolName}" is not in the active skills ${activeNames} ` +
    `allowed-tools. Available now: ${active.allowedTools.join(", ")}. ` +
    "Work within these tools, call read_skill on a different skill, or wait for the next user message."
  );
}
