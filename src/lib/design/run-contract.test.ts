import { describe, expect, it } from "vitest";
import { createSkillActiveContext } from "../skills/active-context";
import type { SkillEntry } from "../skills/types";
import { WRITE_TOOL_NAMES } from "../ai/tools-schema";
import {
  createDesignContractController,
  type DesignContract,
} from "./run-contract";

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

describe("Design contract controller", () => {
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
});
