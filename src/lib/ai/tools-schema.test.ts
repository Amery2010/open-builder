import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import {
  BUILTIN_TOOLS,
  buildToolSetForRun,
  isPlanModeToolVisible,
  isToolAllowedInMode,
  isWriteToolName,
} from "./tools-schema";
import { filterToolSet } from "../tools/tool-set-utils";

describe("tool policies", () => {
  it("marks custom file-writing tools as write tools", () => {
    expect(isWriteToolName("install_component")).toBe(true);
    expect(isWriteToolName("screenshot_to_code")).toBe(true);
    expect(isWriteToolName("apply_design_style")).toBe(true);
    expect(isWriteToolName("apply_design_system")).toBe(true);
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

  it("keeps automatic QA to project inspection and necessary repair tools", () => {
    expect(isToolAllowedInMode("project_health_check", "auto_qa")).toBe(true);
    expect(isToolAllowedInMode("patch_file", "auto_qa")).toBe(true);
    expect(isToolAllowedInMode("web_search", "auto_qa")).toBe(false);
    expect(isToolAllowedInMode("read_skill", "auto_qa")).toBe(false);
    expect(isToolAllowedInMode("manage_env", "auto_qa")).toBe(false);
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
      execute_skill_script: {} as ToolSet[string],
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

  it("exposes Design system application only for the explicit apply run", () => {
    const custom = {
      apply_design_style: {} as ToolSet[string],
      apply_design_system: {} as ToolSet[string],
      submit_design_review: {} as ToolSet[string],
      submit_design_contract: {} as ToolSet[string],
      web_search: {} as ToolSet[string],
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
    expect(automatic.submit_design_contract).toBeUndefined();

    const explicitApply = buildToolSetForRun({
      custom,
      mode: "chat",
      platform: "web",
      profile: "design",
      allowDesignSystemApply: true,
    });
    expect(explicitApply.apply_design_style).toBeUndefined();
    expect(explicitApply.apply_design_system).toBeDefined();
  });

  it("keeps Design Review strictly read-only and offline", () => {
    const custom = {
      project_health_check: {} as ToolSet[string],
      web_search: {} as ToolSet[string],
      apply_design_system: {} as ToolSet[string],
      submit_design_review: {} as ToolSet[string],
      submit_design_contract: {} as ToolSet[string],
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
    expect(Object.keys(review).sort()).toEqual([
      "list_files",
      "read_files",
      "search_in_files",
      "submit_design_review",
    ]);
  });
});
