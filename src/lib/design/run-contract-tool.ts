import { jsonSchema, tool, zodSchema } from "ai";
import {
  designContractModelSchema,
  designContractSchema,
  type DesignContract,
} from "./run-contract";

const canonicalDesignContractSchema = zodSchema(designContractModelSchema);

export const designContractToolInputSchema = jsonSchema<DesignContract>(
  () => canonicalDesignContractSchema.jsonSchema,
  {
    validate: (value) => {
      const parsed = designContractSchema.safeParse(value);
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error };
    },
  },
);

export const SUBMIT_DESIGN_CONTRACT_TOOL = {
  submit_design_contract: tool({
    description:
      "Submit the run-local Design contract after inspecting the project and loading the required Design Skill. " +
      "In Design mode, init_project may run before this tool, but every other project write is blocked until the contract is accepted.",
    inputSchema: designContractToolInputSchema,
  }),
};
