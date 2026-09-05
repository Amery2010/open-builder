import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import {
  BUILTIN_TOOLS,
  DESIGN_DIAGNOSTIC_TOOLS,
  DESIGN_HOST_TOOLS,
  HOST_TOOL_CATALOG,
  HOST_TOOL_RECORDS,
  STATIC_TOOL_DEFINITIONS,
  buildToolSetForRun,
  isPlanModeToolVisible,
  isToolAllowedInMode,
  isWriteToolName,
} from "./tools-schema";
import { filterToolSet } from "../tools/tool-set-utils";

describe("tool policies", () => {
  const staticDefinition = (name: string): ToolSet[string] => {
    const definition = HOST_TOOL_CATALOG.get(name)?.definition;
    if (!definition) throw new Error(`Missing test definition for ${name}`);
    return definition;
  };

  it("marks custom file-writing tools as write tools", () => {
    expect(isWriteToolName("install_component")).toBe(true);
    expect(isWriteToolName("screenshot_to_code")).toBe(true);
    expect(isWriteToolName("apply_design_style")).toBe(true);
    expect(isWriteToolName("apply_design_system")).toBe(false);
    expect(isWriteToolName("execute_skill_script")).toBe(true);
    expect(isWriteToolName("read_files")).toBe(false);
  });

  it("filters builtin and custom write tools in plan mode", () => {
    const custom = {
      install_component: {} as ToolSet[string],
      execute_skill_script: {} as ToolSet[string],
      project_health_check: {} as ToolSet[string],
    };
    const builtins = filterToolSet(BUILTIN_TOOLS, isPlanModeToolVisible);
    const customs = filterToolSet(custom, isPlanModeToolVisible);

    expect(builtins.write_file).toBeUndefined();
    expect(builtins.read_files).toBeDefined();
    expect(customs.install_component).toBeUndefined();
    expect(customs.execute_skill_script).toBeUndefined();
    expect(customs.project_health_check).toBeDefined();
  });

  it("fails closed for unknown tools in restricted modes", () => {
    expect(isPlanModeToolVisible("mcp__unknown__tool")).toBe(false);
    expect(isToolAllowedInMode("unknown", "auto_qa")).toBe(false);
    expect(
      isToolAllowedInMode("execute_skill_script", "subagent", "desktop"),
    ).toBe(false);
  });

  it("registers the executable memory name without the legacy drift", () => {
    expect(HOST_TOOL_CATALOG.get("manage_memories")).toMatchObject({
      effects: ["read_runtime", "write_runtime"],
      approval: "session",
    });
    expect(HOST_TOOL_CATALOG.get("manage_memories")?.definition).toBeDefined();
    expect(HOST_TOOL_CATALOG.get("memory")).toBeUndefined();
  });

  it("keeps the flat static inventory unique and presentation-complete", () => {
    expect(new Set(HOST_TOOL_RECORDS.map((record) => record.name)).size).toBe(
      HOST_TOOL_RECORDS.length,
    );
    for (const record of HOST_TOOL_RECORDS) {
      expect(record.presentation.name.en).not.toBe("");
      expect(record.presentation.name.zh).not.toBe("");
      expect(record.presentation.iconKey).not.toBe("");
      expect(record.outputRetention).toMatch(/^(full|summary-only|run-only)$/);
      if (record.implementation.kind === "host") {
        expect(record.definition).toBeDefined();
      }
    }
    expect(Object.keys(STATIC_TOOL_DEFINITIONS).sort()).toEqual(
      HOST_TOOL_RECORDS.filter((record) => record.definition)
        .map((record) => record.name)
        .sort(),
    );
    expect(HOST_TOOL_CATALOG.get("apply_design_system")).toBeUndefined();
  });

  it("declares ProjectFiles permission only for destructive operations", () => {
    const protectedRecords = Object.fromEntries(
      HOST_TOOL_RECORDS.filter((record) => record.projectPermission).map(
        (record) => [
          record.name,
          {
            operation: record.projectPermission?.operation,
            sessionEligible: record.projectPermission?.sessionEligible,
          },
        ],
      ),
    );

    expect(protectedRecords).toEqual({
      init_project: {
        operation: "replace_project",
        sessionEligible: false,
      },
      delete_file: { operation: "delete", sessionEligible: true },
      rename_file: { operation: "move", sessionEligible: true },
      move_file: { operation: "move", sessionEligible: true },
    });
    for (const name of [
      "list_files",
      "read_files",
      "write_file",
      "patch_file",
      "manage_dependencies",
      "manage_env",
      "update_design_tokens",
    ]) {
      expect(HOST_TOOL_CATALOG.get(name)?.projectPermission).toBeUndefined();
    }
  });

  it("projects equivalent Host authority for API and Local CLI runtimes", () => {
    const tools = {
      delete_file: BUILTIN_TOOLS.delete_file,
      write_file: BUILTIN_TOOLS.write_file,
    };
    const baseContext = {
      runId: "runtime-parity",
      mode: "chat" as const,
      platform: "desktop" as const,
      allowedMcpAliases: new Set<string>(),
      activeSkillIds: new Set<string>(),
      approvedSkillScriptHashes: new Set<string>(),
      policyVersion: "test",
    };
    const api = HOST_TOOL_CATALOG.openRun({
      tools,
      context: { ...baseContext, runtime: "api" },
    });
    const local = HOST_TOOL_CATALOG.openRun({
      tools,
      context: { ...baseContext, runtime: "local_cli" },
    });

    expect([...local.authority.names]).toEqual([...api.authority.names]);
    expect(local.authority.get("delete_file")?.projectPermission).toMatchObject(
      { operation: "delete", sessionEligible: true },
    );
  });

  it("keeps presentation summaries bounded and free of file or secret values", () => {
    const summarize =
      HOST_TOOL_CATALOG.get("manage_env")?.presentation.summarizeArguments;
    const summary = summarize?.({
      operations: [
        { action: "set", key: "API_KEY", value: "super-secret-value" },
      ],
      content: "private file content",
    });

    expect(summary).toContain("operations[1]");
    expect(summary).not.toContain("super-secret-value");
    expect(summary).not.toContain("private file content");

    const scriptSummary = HOST_TOOL_CATALOG.get(
      "execute_skill_script",
    )?.presentation.summarizeArguments({
      skill_name: "safe-skill",
      script_path: "scripts/run.ts",
      args: ["--token", "super-secret-value"],
    });
    expect(scriptSummary).toContain("skill_name=safe-skill");
    expect(scriptSummary).toContain("args[2]");
    expect(scriptSummary).not.toContain("super-secret-value");
  });

  it("keeps automatic QA to project inspection and necessary repair tools", () => {
    expect(isToolAllowedInMode("project_health_check", "auto_qa")).toBe(true);
    expect(isToolAllowedInMode("patch_file", "auto_qa")).toBe(true);
    expect(isToolAllowedInMode("web_search", "auto_qa")).toBe(false);
    expect(isToolAllowedInMode("read_skill", "auto_qa")).toBe(false);
    expect(isToolAllowedInMode("manage_env", "auto_qa")).toBe(false);
  });

  it("matches every declared mode, profile, and platform combination", () => {
    const allDefinitions = Object.fromEntries(
      HOST_TOOL_RECORDS.map((record) => [
        record.name,
        record.definition ?? ({} as ToolSet[string]),
      ]),
    ) as ToolSet;
    const providerOwnedNames = new Set(
      HOST_TOOL_RECORDS.filter(
        (record) => record.implementation.kind === "provider",
      ).map((record) => record.name),
    );

    for (const mode of ["chat", "plan", "auto_qa", "subagent"] as const) {
      for (const profile of ["default", "design", "design_review"] as const) {
        for (const platform of ["web", "desktop", "mobile"] as const) {
          const projected = buildToolSetForRun({
            custom: allDefinitions,
            mode,
            profile,
            platform,
            providerOwnedNames,
          });
          for (const record of HOST_TOOL_RECORDS) {
            const expected =
              record.modes.includes(mode) &&
              record.profiles.includes(profile) &&
              record.platforms.includes(platform);
            expect(
              record.name in projected,
              `${record.name} in ${mode}/${profile}/${platform}`,
            ).toBe(expected);
          }
        }
      }
    }
  });

  it.each([
    ["list_files", "chat", "web", true],
    ["list_files", "plan", "desktop", true],
    ["list_files", "auto_qa", "mobile", true],
    ["list_files", "subagent", "desktop", true],
    ["get_console_logs", "chat", "desktop", true],
    ["get_console_logs", "plan", "desktop", false],
    ["get_console_logs", "auto_qa", "desktop", false],
    ["get_console_logs", "subagent", "desktop", false],
    ["web_search", "subagent", "desktop", false],
    ["execute_skill_script", "chat", "desktop", true],
    ["execute_skill_script", "chat", "web", false],
    ["execute_skill_script", "chat", "mobile", false],
    ["execute_skill_script", "plan", "desktop", false],
    ["execute_skill_script", "auto_qa", "desktop", false],
    ["execute_skill_script", "subagent", "desktop", false],
  ] as const)(
    "%s in %s on %s is allowed=%s",
    (toolName, mode, platform, expected) => {
      expect(isToolAllowedInMode(toolName, mode, platform)).toBe(expected);
    },
  );

  it("projects native Skill scripts only into Desktop Chat", () => {
    const custom = {
      execute_skill_script: staticDefinition("execute_skill_script"),
    };

    expect(
      buildToolSetForRun({
        custom,
        mode: "chat",
        platform: "desktop",
      }).execute_skill_script,
    ).toBeDefined();

    for (const [mode, platform] of [
      ["chat", "web"],
      ["chat", "mobile"],
      ["plan", "desktop"],
      ["auto_qa", "desktop"],
      ["subagent", "desktop"],
    ] as const) {
      expect(
        buildToolSetForRun({
          custom,
          mode,
          platform,
          allowedDynamicNames: new Set(["execute_skill_script"]),
        }).execute_skill_script,
      ).toBeUndefined();
    }
  });

  it("projects an unknown dynamic tool only from the explicit run allowlist", () => {
    const alias = "mcp_demo_lookup_abcd";
    const custom = { [alias]: {} as ToolSet[string] };

    expect(
      buildToolSetForRun({
        custom,
        mode: "plan",
        platform: "desktop",
      })[alias],
    ).toBeUndefined();
    expect(
      buildToolSetForRun({
        custom,
        mode: "plan",
        platform: "desktop",
        allowedDynamicNames: new Set([alias]),
      })[alias],
    ).toBeDefined();
  });

  it("accepts a static-name override only when the run marks it provider-owned", () => {
    const providerWebSearch = {} as ToolSet[string];
    expect(() =>
      buildToolSetForRun({
        custom: { web_search: providerWebSearch },
        mode: "chat",
        platform: "web",
      }),
    ).toThrow(/name collision/);

    expect(
      buildToolSetForRun({
        custom: { web_search: providerWebSearch },
        mode: "chat",
        platform: "web",
        providerOwnedNames: new Set(["web_search"]),
      }).web_search,
    ).toBe(providerWebSearch);
  });

  it("removes model Design-system application and profiles Design tools", () => {
    const custom = {
      apply_design_style: staticDefinition("apply_design_style"),
      apply_design_system: {} as ToolSet[string],
      submit_design_review: staticDefinition("submit_design_review"),
      submit_design_contract: staticDefinition("submit_design_contract"),
      update_design_tokens: DESIGN_HOST_TOOLS.update_design_tokens,
      capture_preview_evidence: DESIGN_HOST_TOOLS.capture_preview_evidence,
      set_default_preview_view: DESIGN_HOST_TOOLS.set_default_preview_view,
      ...DESIGN_DIAGNOSTIC_TOOLS,
      web_search: staticDefinition("web_search"),
    };

    const automatic = buildToolSetForRun({
      custom,
      mode: "chat",
      platform: "web",
      profile: "default",
    });
    expect(automatic.apply_design_style).toBeDefined();
    expect(automatic.apply_design_system).toBeUndefined();

    const design = buildToolSetForRun({
      custom,
      mode: "chat",
      platform: "web",
      profile: "design",
    });
    expect(design.apply_design_style).toBeUndefined();
    expect(design.apply_design_system).toBeUndefined();
    expect(design.submit_design_contract).toBeDefined();
    expect(design.update_design_tokens).toBeDefined();
    expect(design.capture_preview_evidence).toBeDefined();
    expect(design.set_default_preview_view).toBeDefined();
    for (const name of Object.keys(DESIGN_DIAGNOSTIC_TOOLS)) {
      expect(design[name]).toBeDefined();
      expect(automatic[name]).toBeUndefined();
    }
    expect(automatic.submit_design_contract).toBeUndefined();
    expect(automatic.update_design_tokens).toBeUndefined();
    expect(automatic.capture_preview_evidence).toBeUndefined();
    expect(automatic.set_default_preview_view).toBeDefined();

    const explicitApply = buildToolSetForRun({
      custom,
      mode: "chat",
      platform: "web",
      profile: "design",
    });
    expect(explicitApply.apply_design_style).toBeUndefined();
    expect(explicitApply.apply_design_system).toBeUndefined();
  });

  it("keeps Design Review strictly read-only and offline", () => {
    const custom = {
      project_health_check: staticDefinition("project_health_check"),
      web_search: staticDefinition("web_search"),
      apply_design_system: {} as ToolSet[string],
      submit_design_review: staticDefinition("submit_design_review"),
      submit_design_contract: staticDefinition("submit_design_contract"),
      ...DESIGN_DIAGNOSTIC_TOOLS,
      mcp_review_escape: {} as ToolSet[string],
    };
    const review = buildToolSetForRun({
      custom,
      mode: "chat",
      platform: "desktop",
      profile: "design_review",
      allowedDynamicNames: new Set(["mcp_review_escape"]),
    });

    expect(review.read_files).toBeDefined();
    expect(review.project_health_check).toBeUndefined();
    expect(review.submit_design_review).toBeDefined();
    expect(review.write_file).toBeUndefined();
    expect(review.web_search).toBeUndefined();
    expect(review.apply_design_system).toBeUndefined();
    expect(review.mcp_review_escape).toBeUndefined();
    for (const name of Object.keys(DESIGN_DIAGNOSTIC_TOOLS)) {
      expect(review[name]).toBeUndefined();
    }
    expect(Object.keys(review).sort()).toEqual([
      "list_files",
      "read_files",
      "search_in_files",
      "submit_design_review",
    ]);
  });
});
