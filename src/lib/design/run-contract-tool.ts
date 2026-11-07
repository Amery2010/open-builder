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
      "A contract is recommended for ordinary project file edits and required for prototype/blueprint batches, the dedicated update_design_tokens tool, and automatic visual review. " +
      "init_project may precede it; an automatic Design repair reuses its preloaded contract.",
    inputSchema: designContractToolInputSchema,
  }),
};
