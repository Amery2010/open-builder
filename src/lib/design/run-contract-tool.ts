import { tool } from "ai";
import { designContractSchema } from "./run-contract";

export const SUBMIT_DESIGN_CONTRACT_TOOL = {
  submit_design_contract: tool({
    description:
      "Submit the run-local Design contract after inspecting the project and loading the required Design Skill. " +
      "In Design mode, init_project may run before this tool, but every other project write is blocked until the contract is accepted.",
    inputSchema: designContractSchema,
  }),
};
