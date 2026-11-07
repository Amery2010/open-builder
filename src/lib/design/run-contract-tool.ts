import { jsonSchema, zodSchema } from "ai";
import {
  designContractModelSchema,
  designContractSchema,
  type DesignContract,
} from "./run-contract";

const canonicalDesignContractSchema = zodSchema(designContractModelSchema);

/** Read-only adapter for historical contract arguments; no executable tool. */
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
