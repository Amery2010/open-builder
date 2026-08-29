import type { ExecutionMode } from "./tools-schema";
import type { WorkspaceMode } from "../../types";
import { buildCustomSystemPromptSection } from "./custom-system-prompt";

export interface RunSystemPromptSections {
  mode: ExecutionMode;
  memory: string;
  autoSkills: string;
  mandatorySkills: string;
  customSystemPrompt: string;
  planMode: string;
  workspaceMode?: WorkspaceMode;
  designMode?: string;
  designSystem?: string;
}

/** Compose only request-serving prompt context. Utility calls use separate prompts. */
export function buildRunSystemPromptSuffix({
  mode,
  memory,
  autoSkills,
  mandatorySkills,
  customSystemPrompt,
  planMode,
  workspaceMode = "auto",
  designMode = "",
  designSystem = "",
}: RunSystemPromptSections): string {
  if (mode === "auto_qa" || mode === "subagent") return "";

  return (
    (mode === "chat" ? memory : "") +
    autoSkills +
    buildCustomSystemPromptSection(customSystemPrompt) +
    mandatorySkills +
    ((mode === "chat" || mode === "plan") && workspaceMode === "design"
      ? designMode + designSystem
      : "") +
    (mode === "plan" ? planMode : "")
  );
}
