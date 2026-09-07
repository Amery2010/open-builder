import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { createSkillActiveContext } from "../skills/active-context";
import type { SkillEntry } from "../skills/types";
import { WRITE_TOOL_NAMES } from "../ai/tools-schema";
import { SUBAGENT_REGISTRY } from "../ai/subagents/registry";
import type { SubagentDefinition } from "../ai/subagents/types";
import {
  createDesignContractController,
  designContractModelSchema,
  designContractSchema,
  type DesignContract,
  type DesignBlueprintScope,
} from "./run-contract";
import {
  designContractToolInputSchema,
  SUBMIT_DESIGN_CONTRACT_TOOL,
} from "./run-contract-tool";

function skill(id: string): SkillEntry {
  return {
    id,
    name: id,
    description: id,
    version: "1.0.0",
    autoEnabled: true,
    source: "builtin",
    installedAt: 0,
  };
}

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
  it("publishes only the canonical blueprint field to models", async () => {
    const schema = await asSchema(
      SUBMIT_DESIGN_CONTRACT_TOOL.submit_design_contract.inputSchema,
    ).jsonSchema;
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

describe("Design contract controller", () => {
  it("fails closed for writes when a Design caller omitted run policy setup", () => {
    const controller = createDesignContractController();

    expect(controller.authorizeProjectWrite("read_files")).toBeUndefined();
    expect(controller.authorizeProjectWrite("init_project")).toBeUndefined();
    expect(controller.authorizeProjectWrite("write_file")).toContain(
      "Design run policy required",
    );
    expect(
      controller.authorizeProjectWrite("import_generated_image", {
        image_id: "generated-image",
      }),
    ).toContain("Design run policy required");
  });

  it("keeps project writes locked after an invalid contract submission", () => {
    const controller = createDesignContractController();
    const skills = createSkillActiveContext();
    skills.activate(skill("design-product-ui"));
    controller.reset({ enabled: true });

    expect(() =>
      controller.submit(
        { ...contract(), target: undefined },
        {
          expectedSystemId: "graphite",
          skillContext: skills,
        },
      ),
    ).toThrow();
    expect(controller.isReady()).toBe(false);
    expect(controller.authorizeProjectWrite("write_file")).toContain(
      "Design contract required",
    );
  });

  it("blocks project writes until a valid contract is accepted", () => {
    const controller = createDesignContractController();
    const skills = createSkillActiveContext();
    controller.reset({ enabled: true });

    expect(controller.authorizeProjectWrite("init_project")).toBeUndefined();
    expect(controller.authorizeProjectWrite("read_files")).toBeUndefined();
    expect(controller.authorizeProjectWrite("dispatch_subagent")).toContain(
      "Design contract required",
    );
    for (const toolName of WRITE_TOOL_NAMES) {
      if (toolName === "init_project") continue;
      expect(controller.authorizeProjectWrite(toolName)).toContain(
        "Design contract required",
      );
    }
    expect(controller.authorizeProjectWrite("write_file")).toContain(
      "Design contract required",
    );
    expect(() =>
      controller.submit(contract(), {
        expectedSystemId: "graphite",
        skillContext: skills,
      }),
    ).toThrow("design-product-ui");

    skills.activate(skill("design-product-ui"));
    expect(
      controller.submit(contract(), {
        expectedSystemId: "graphite",
        skillContext: skills,
      }),
    ).toMatchObject({ surface_mode: "operate", system_id: "graphite" });
    expect(controller.authorizeProjectWrite("write_file")).toBeUndefined();
    expect(
      controller.authorizeProjectWrite("import_generated_image", {
        image_id: "generated-image",
      }),
    ).toBeUndefined();
  });

  it("allows only the validated blueprint Host update while repairing invalid authority", () => {
    const controller = createDesignContractController();
    const skills = createSkillActiveContext();
    skills.activate(skill("design-product-ui"));
    controller.reset({ enabled: true, allowProjectDesignRepair: true });

    expect(
      controller.authorizeProjectWrite("update_project_design", {}),
    ).toBeUndefined();
    expect(
      controller.authorizeProjectWrite("write_file", {
        path: "src/App.tsx",
        content: "blocked",
      }),
    ).toContain("Design contract required");
    expect(() =>
      controller.submit(contract(), {
        expectedSystemId: "graphite",
        skillContext: skills,
      }),
    ).toThrow("Repair the invalid project design");
  });

  it("allows known read-only subagents before the contract and fails closed otherwise", () => {
    const controller = createDesignContractController();
    controller.reset({ enabled: true });

    expect(
      controller.authorizeProjectWrite("dispatch_subagent", {
        subagent: "code-explorer",
        task: "Inspect the active entry chain.",
      }),
    ).toBeUndefined();
    expect(
      controller.authorizeProjectWrite("dispatch_subagent", {
        subagent: "unknown-agent",
        task: "Inspect the project.",
      }),
    ).toContain("Design contract required");

    const fullWriteAgent: SubagentDefinition = {
      name: "full-write-test-agent",
      description: "Test-only write-capable agent",
      systemPrompt: "Test only",
      toolWhitelist: ["write_file"],
      writePolicy: "fullWrite",
    };
    SUBAGENT_REGISTRY.push(fullWriteAgent);
    try {
      expect(
        controller.authorizeProjectWrite("dispatch_subagent", {
          subagent: fullWriteAgent.name,
          task: "Modify the project.",
        }),
      ).toContain("Design contract required");
    } finally {
      SUBAGENT_REGISTRY.splice(SUBAGENT_REGISTRY.indexOf(fullWriteAgent), 1);
    }

    expect(controller.authorizeProjectWrite("write_file", {})).toContain(
      "Design contract required",
    );
  });

  it("validates applied system, change mode, and surface-specific Skills", () => {
    const controller = createDesignContractController();
    const skills = createSkillActiveContext();
    skills.activate(skill("art-direct-web"));
    controller.reset({ enabled: true, expectedChangeModes: ["migrate"] });

    expect(() =>
      controller.submit(
        contract({ surface_mode: "persuade", change_mode: "migrate" }),
        { expectedSystemId: "other", skillContext: skills },
      ),
    ).toThrow("currently applied Design system");
    expect(() =>
      controller.submit(contract({ surface_mode: "persuade" }), {
        expectedSystemId: "graphite",
        skillContext: skills,
      }),
    ).toThrow("change_mode");

    const accepted = controller.submit(
      contract({ surface_mode: "persuade", change_mode: "migrate" }),
      { expectedSystemId: "graphite", skillContext: skills },
    );
    expect(accepted.change_mode).toBe("migrate");
  });

  it("requires both Design Skills for mixed surfaces and resets per run", () => {
    const controller = createDesignContractController();
    const skills = createSkillActiveContext();
    skills.activate(skill("design-product-ui"));
    controller.reset({ enabled: true });

    expect(() =>
      controller.submit(contract({ surface_mode: "mixed" }), {
        expectedSystemId: "graphite",
        skillContext: skills,
      }),
    ).toThrow("art-direct-web");

    skills.activate(skill("art-direct-web"));
    controller.submit(contract({ surface_mode: "mixed" }), {
      expectedSystemId: "graphite",
      skillContext: skills,
    });
    expect(controller.isReady()).toBe(true);

    controller.reset({ enabled: true });
    expect(controller.isReady()).toBe(false);
    expect(controller.getContract()).toBeNull();
  });

  it("reuses a validated contract only while its system still matches", () => {
    const controller = createDesignContractController();
    controller.reset(
      { enabled: true, expectedSystemId: "graphite" },
      contract(),
    );
    expect(controller.isReady()).toBe(true);
    expect(() =>
      controller.reset(
        { enabled: true, expectedSystemId: "other" },
        contract(),
      ),
    ).toThrow("no longer matches");
  });

  it("fails closed after a reusable policy reset cannot be rebuilt", () => {
    const controller = createDesignContractController();
    controller.reset(
      { enabled: true, expectedSystemId: "graphite" },
      contract(),
    );
    expect(controller.getContract()).not.toBeNull();

    expect(() =>
      controller.reset(
        { enabled: true, expectedSystemId: "other" },
        contract(),
      ),
    ).toThrow("no longer matches");
    expect(controller.getContract()).toBeNull();
    expect(controller.authorizeProjectWrite("write_file")).toContain(
      "Design run policy required",
    );

    controller.reset(
      { enabled: true, expectedSystemId: "graphite" },
      contract(),
    );
    expect(() =>
      controller.reset({ enabled: true, sealReusableContract: true }),
    ).toThrow("requires a reusable contract");
    expect(controller.getContract()).toBeNull();
    expect(controller.authorizeProjectWrite("write_file")).toContain(
      "Design run policy required",
    );
  });

  it("seals an automatic repair contract against resubmission and blueprint widening", () => {
    const controller = createDesignContractController();
    const skills = createSkillActiveContext();
    skills.activate(skill("design-product-ui"));
    const reviewed = contract({
      blueprint: blueprint({
        target_page_ids: ["settings"],
        shared_scope: { file_paths: [], ui_ids: [] },
      }),
    });
    controller.reset(
      {
        enabled: true,
        sealReusableContract: true,
        expectedBlueprintRevision: "blueprint-r3",
        knownBlueprintPageIds: ["settings", "dashboard"],
        knownBlueprintPageFilePaths: {
          settings: ["src/pages/Settings.tsx"],
          dashboard: ["src/pages/Dashboard.tsx"],
        },
      },
      reviewed,
    );

    expect(controller.isReusableContractSealed()).toBe(true);
    expect(() =>
      controller.submit(
        contract({
          blueprint: blueprint({
            target_page_ids: ["settings", "dashboard"],
            shared_scope: { file_paths: [], ui_ids: [] },
          }),
        }),
        { expectedSystemId: "graphite", skillContext: skills },
      ),
    ).toThrow(/sealed.*cannot be replaced/i);
    expect(
      controller.authorizeProjectWrite("update_project_design", {
        design: {},
      }),
    ).toContain("reviewed blueprint is sealed");
    expect(
      controller.authorizeProjectWrite("write_file", {
        path: "src/pages/Dashboard.tsx",
        content: "out of reviewed scope",
      }),
    ).toContain("outside the selected page files");
    expect(
      controller.authorizeProjectWrite("write_file", {
        path: "src/pages/Settings.tsx",
        content: "reviewed scope",
      }),
    ).toBeUndefined();
    expect(controller.getContract()).toEqual(reviewed);
  });

  it("binds an optional blueprint to its revision and known page/shared scope", () => {
    const controller = createDesignContractController();
    const skills = createSkillActiveContext();
    skills.activate(skill("design-product-ui"));
    controller.reset({
      enabled: true,
      expectedBlueprintRevision: "blueprint-r3",
      knownBlueprintPageIds: ["settings", "dashboard", "reports"],
      knownBlueprintSharedFilePaths: [
        "src/components/AppShell.tsx",
        "src/styles/tokens.css",
      ],
      knownBlueprintSharedUiIds: ["app-shell", "primary-nav", "footer"],
    });

    const accepted = controller.submit(contract({ blueprint: blueprint() }), {
      expectedSystemId: "graphite",
      skillContext: skills,
      expectedBlueprintRevision: "blueprint-r3",
      knownBlueprintPageIds: ["settings", "dashboard"],
      knownBlueprintSharedFilePaths: [
        "src/components/AppShell.tsx",
        "src/styles/tokens.css",
      ],
      knownBlueprintSharedUiIds: ["app-shell", "primary-nav"],
    });

    expect(accepted.blueprint).toEqual(blueprint());
    expect(
      controller.authorizeProjectWrite("write_file", {
        path: "src/components/AppShell.tsx",
        content: "updated",
      }),
    ).toBeUndefined();
    expect(
      controller.authorizeProjectWrite("write_file", {
        path: "src/pages/Reports.tsx",
        content: "out of scope",
      }),
    ).toContain("outside the selected page files");
    for (const path of ["DESIGN.md", "tokens.css"]) {
      expect(
        controller.authorizeProjectWrite("write_file", {
          path,
          content: "authoritative",
        }),
      ).toBeUndefined();
    }
    expect(
      controller.authorizeProjectWrite("write_file", {
        path: "design-project.json",
        content: "{}",
      }),
    ).toContain("outside the selected page files");
    expect(controller.authorizeProjectWrite("install_component", {})).toContain(
      "cannot be proven to be in scope",
    );
  });

  it("fails closed for stale, unknown, duplicate, unsafe, and invalid blueprint values", () => {
    const controller = createDesignContractController();
    const skills = createSkillActiveContext();
    skills.activate(skill("design-product-ui"));
    controller.reset({
      enabled: true,
      expectedBlueprintRevision: "blueprint-r3",
      knownBlueprintPageIds: ["settings", "dashboard"],
      knownBlueprintSharedFilePaths: ["src/components/AppShell.tsx"],
      knownBlueprintSharedUiIds: ["app-shell"],
    });
    const submit = (scope: DesignBlueprintScope) =>
      controller.submit(contract({ blueprint: scope }), {
        expectedSystemId: "graphite",
        skillContext: skills,
      });

    expect(() => submit(blueprint({ revision: "blueprint-r2" }))).toThrow(
      /stale|current blueprint/i,
    );
    expect(() => submit(blueprint({ target_page_ids: ["unknown"] }))).toThrow(
      "unknown page",
    );
    expect(() =>
      submit(
        blueprint({
          shared_scope: {
            file_paths: ["src/other.ts"],
            ui_ids: ["app-shell"],
          },
        }),
      ),
    ).toThrow("unknown path");
    expect(() =>
      submit(
        blueprint({
          shared_scope: {
            file_paths: ["src/components/AppShell.tsx"],
            ui_ids: ["unknown-ui"],
          },
        }),
      ),
    ).toThrow("unknown id");

    expect(() =>
      designContractSchema.parse(
        contract({
          blueprint: blueprint({ target_page_ids: ["settings", "settings"] }),
        }),
      ),
    ).toThrow("duplicate");
    expect(() =>
      designContractSchema.parse(
        contract({
          blueprint: blueprint({
            shared_scope: {
              file_paths: [
                "src/components/AppShell.tsx",
                "src\\components\\AppShell.tsx",
              ],
              ui_ids: ["app-shell"],
            },
          }),
        }),
      ),
    ).toThrow("duplicate");
    expect(() =>
      designContractSchema.parse(
        contract({
          blueprint: blueprint({
            shared_scope: {
              file_paths: ["../secrets.txt"],
              ui_ids: ["app-shell"],
            },
          }),
        }),
      ),
    ).toThrow(/traversal|unsafe/i);
    expect(() =>
      designContractSchema.parse(
        contract({
          blueprint: blueprint({ batch_phase: "not-a-phase" as never }),
        }),
      ),
    ).toThrow();
  });

  it("reuses a blueprint contract only while its revision and scope remain bound", () => {
    const controller = createDesignContractController();
    const reusable = contract({ blueprint: blueprint() });
    controller.reset(
      {
        enabled: true,
        expectedBlueprintRevision: "blueprint-r3",
        knownBlueprintPageIds: ["settings", "dashboard"],
        knownBlueprintSharedFilePaths: [
          "src/components/AppShell.tsx",
          "src/styles/tokens.css",
        ],
        knownBlueprintSharedUiIds: ["app-shell", "primary-nav"],
      },
      reusable,
    );
    expect(controller.getContract()).toEqual(reusable);

    expect(() =>
      controller.reset(
        {
          enabled: true,
          expectedBlueprintRevision: "blueprint-r4",
          knownBlueprintPageIds: ["settings", "dashboard"],
          knownBlueprintSharedFilePaths: [
            "src/components/AppShell.tsx",
            "src/styles/tokens.css",
          ],
          knownBlueprintSharedUiIds: ["app-shell", "primary-nav"],
        },
        reusable,
      ),
    ).toThrow(/stale|current blueprint/i);
  });

  it("supports explicit path tools and keeps legacy runs unrestricted", () => {
    const controller = createDesignContractController();
    const skills = createSkillActiveContext();
    skills.activate(skill("design-product-ui"));
    controller.reset({
      enabled: true,
      expectedBlueprintRevision: 1,
      knownBlueprintPageIds: ["settings"],
      knownBlueprintSharedFilePaths: [
        "src/components/AppShell.tsx",
        "src/styles",
      ],
      knownBlueprintSharedUiIds: [],
      knownBlueprintPageFilePaths: {
        settings: ["src/pages/Settings.tsx"],
      },
    });
    controller.submit(
      contract({
        blueprint: blueprint({
          revision: 1,
          target_page_ids: ["settings"],
          shared_scope: {
            file_paths: ["src/components/AppShell.tsx", "src/styles"],
            ui_ids: [],
          },
        }),
      }),
      { expectedSystemId: "graphite", skillContext: skills },
    );

    expect(
      controller.authorizeProjectWrite("write_file", {
        path: "src/pages/Settings.tsx",
        content: "selected page",
      }),
    ).toBeUndefined();
    expect(
      controller.authorizeProjectWrite("write_file", {
        path: "src/pages/Dashboard.tsx",
        content: "another page",
      }),
    ).toContain("outside the selected page files");
    expect(
      controller.authorizeProjectWrite("rename_file", {
        old_path: "src/components/AppShell.tsx",
        new_path: "src/components/AppShell.tsx",
      }),
    ).toBeUndefined();
    expect(
      controller.authorizeProjectWrite("move_file", {
        path: "src/components/AppShell.tsx",
        target_dir: "src/styles",
      }),
    ).toContain("outside the selected page files");
    expect(
      controller.authorizeProjectWrite("write_file", {
        path: "../escape.ts",
        content: "unsafe",
      }),
    ).toContain("unsafe");

    const legacy = createDesignContractController();
    legacy.reset({ enabled: true });
    legacy.submit(contract(), {
      expectedSystemId: "graphite",
      skillContext: skills,
    });
    expect(
      legacy.authorizeProjectWrite("write_file", {
        path: "src/pages/AnyPage.tsx",
        content: "legacy behavior",
      }),
    ).toBeUndefined();
  });
});
