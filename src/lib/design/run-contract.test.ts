import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import {
  designContractModelSchema,
  designContractSchema,
  type DesignContract,
  type DesignBlueprintScope,
} from "./run-contract";
import { designContractToolInputSchema } from "./run-contract-tool";

function contract(overrides: Partial<DesignContract> = {}): DesignContract {
  return {
    surface_mode: "operate",
    change_mode: "extend",
    target: "Settings workspace",
    audience: "Workspace administrators",
    primary_goal: "Configure the project safely",
    concept: "A precise operations bench",
    system_id: "graphite",
    translation: {
      foundations: "Use the applied semantic color and type roles.",
      composition: "Keep the existing two-column workspace structure.",
      components: "Translate controls through shared product primitives.",
    },
    preserve: ["Routes, data contracts, permissions, and accessibility"],
    acceptance: ["All changed UI consumes semantic tokens"],
    ...overrides,
  };
}

function blueprint(
  overrides: Partial<DesignBlueprintScope> = {},
): DesignBlueprintScope {
  return {
    revision: "blueprint-r3",
    target_page_ids: ["settings", "dashboard"],
    shared_scope: {
      file_paths: ["src/components/AppShell.tsx", "src/styles/tokens.css"],
      ui_ids: ["app-shell", "primary-nav"],
    },
    batch_phase: "core_flow",
    ...overrides,
  };
}

describe("Design contract schema", () => {
  it("reads the historical contract schema without restoring write authority", async () => {
    const schema = await asSchema(designContractToolInputSchema).jsonSchema;
    const objectSchema = schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(objectSchema.properties).toHaveProperty("blueprint");
    expect(objectSchema.properties).not.toHaveProperty("blueprint_scope");
    expect(objectSchema.required).toEqual(
      expect.arrayContaining(["target", "preserve"]),
    );
    expect(
      (objectSchema.properties?.target as { description?: string }).description,
    ).toBeTruthy();
    expect(
      (objectSchema.properties?.preserve as { description?: string })
        .description,
    ).toBeTruthy();
  });

  it("normalizes the legacy blueprint alias and merges equal dual fields", async () => {
    const legacyInput = { ...contract(), blueprint_scope: blueprint() };
    const legacy = designContractSchema.parse(legacyInput);
    const duplicate = designContractSchema.parse({
      ...contract(),
      blueprint: blueprint(),
      blueprint_scope: blueprint(),
    });
    const validated =
      await designContractToolInputSchema.validate?.(legacyInput);

    expect(legacy.blueprint).toEqual(blueprint());
    expect(legacy).not.toHaveProperty("blueprint_scope");
    expect(duplicate.blueprint).toEqual(blueprint());
    expect(duplicate).not.toHaveProperty("blueprint_scope");
    expect(validated).toMatchObject({
      success: true,
      value: { blueprint: blueprint() },
    });
    expect(designContractModelSchema.safeParse(legacyInput).success).toBe(
      false,
    );
  });

  it("rejects conflicting canonical and legacy blueprint fields", () => {
    expect(() =>
      designContractSchema.parse({
        ...contract(),
        blueprint: blueprint(),
        blueprint_scope: blueprint({ revision: "blueprint-r4" }),
      }),
    ).toThrow("must describe the same scope");
  });
});
