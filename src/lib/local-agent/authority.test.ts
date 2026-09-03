import { tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BUILTIN_TOOLS,
  DESIGN_HOST_TOOLS,
  HOST_TOOL_CATALOG,
  HOST_TOOL_RECORDS,
} from "../ai/tools-schema";
import { createLocalToolAuthoritySnapshot } from "./authority";

const tools: ToolSet = {
  list_files: tool({
    description: "List files",
    inputSchema: z.object({}),
  }),
  write_file: tool({
    description: "Write a file",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  }),
  screenshot_to_code: tool({
    description: "Must never be exposed to a local CLI",
    inputSchema: z.object({}),
  }),
  mcp_read: tool({
    description: "Read from an approved MCP server",
    inputSchema: z.object({ id: z.string() }),
  }),
};

describe("local Host Tool Authority", () => {
  it("serializes the exact Web Host run authority", async () => {
    const context = {
      runId: "parity-run",
      mode: "chat" as const,
      platform: "desktop" as const,
      allowedMcpAliases: new Set<string>(),
      activeSkillIds: new Set<string>(),
      approvedSkillScriptHashes: new Set<string>(),
      policyVersion: "test",
    };
    const hostRun = HOST_TOOL_CATALOG.openRun({
      tools: {
        list_files: BUILTIN_TOOLS.list_files,
        write_file: BUILTIN_TOOLS.write_file,
      },
      context,
    });
    const local = await createLocalToolAuthoritySnapshot({
      tools: hostRun.modelTools,
      mode: context.mode,
      platform: context.platform,
      hostRun,
    });

    expect([...local.names].sort()).toEqual(
      [...hostRun.authority.names].sort(),
    );
    expect(local.has("write_file")).toBe(hostRun.authority.has("write_file"));
  });

  it("keeps all Design Host tools equivalent across Web and Local authority", async () => {
    const context = {
      runId: "design-parity-run",
      mode: "chat" as const,
      platform: "desktop" as const,
      allowedMcpAliases: new Set<string>(),
      activeSkillIds: new Set<string>(),
      approvedSkillScriptHashes: new Set<string>(),
      policyVersion: "test",
    };
    const hostRun = HOST_TOOL_CATALOG.openRun({
      tools: {
        list_files: BUILTIN_TOOLS.list_files,
        ...DESIGN_HOST_TOOLS,
      },
      context,
      profile: "design",
    });
    const local = await createLocalToolAuthoritySnapshot({
      tools: hostRun.modelTools,
      mode: context.mode,
      platform: context.platform,
      hostRun,
    });

    expect([...local.names].sort()).toEqual(
      [...hostRun.authority.names].sort(),
    );
    expect(local.isReadOnly("set_default_preview_view")).toBe(false);
    expect(local.isReadOnly("update_design_tokens")).toBe(false);
    expect(local.isReadOnly("capture_preview_evidence")).toBe(true);
    for (const name of [
      "inspect_design_consistency",
      "measure_preview_layout",
      "audit_accessibility_tree",
      "compare_preview_states",
      "trace_design_provenance",
    ]) {
      expect(local.isReadOnly(name)).toBe(true);
    }
    await expect(
      local.validate("capture_preview_evidence", {
        viewports: ["mobile", "desktop"],
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      local.validate("audit_accessibility_tree", {
        viewports: ["mobile", "mobile"],
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      hostRun.authority.validate("compare_preview_states", {
        baseline_generation: "not-a-digest",
        viewports: ["mobile"],
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      hostRun.authority.validate("capture_preview_evidence", {
        viewports: ["mobile", "desktop"],
      }),
    ).resolves.toMatchObject({ success: true });
  });

  it("projects every eligible Host project write in Chat and none in Plan", async () => {
    const expectedProjectWrites = HOST_TOOL_RECORDS.filter(
      (capability) =>
        capability.effects.includes("write_project") &&
        capability.modes.includes("chat") &&
        capability.platforms.includes("desktop") &&
        capability.name in BUILTIN_TOOLS &&
        capability.name !== "screenshot_to_code",
    )
      .map((capability) => capability.name)
      .sort();

    const chat = await createLocalToolAuthoritySnapshot({
      tools: BUILTIN_TOOLS,
      mode: "chat",
      platform: "desktop",
    });
    const plan = await createLocalToolAuthoritySnapshot({
      tools: BUILTIN_TOOLS,
      mode: "plan",
      platform: "desktop",
    });

    expect(
      chat.specs
        .filter((spec) => expectedProjectWrites.includes(spec.name))
        .map((spec) => spec.name),
    ).toEqual(expectedProjectWrites);
    for (const name of expectedProjectWrites) {
      expect(chat.isReadOnly(name)).toBe(false);
    }
    expect(
      plan.specs.some((spec) => expectedProjectWrites.includes(spec.name)),
    ).toBe(false);
  });

  it("uses one filtered snapshot for visibility and execution", async () => {
    const snapshot = await createLocalToolAuthoritySnapshot({
      tools,
      mode: "chat",
      platform: "desktop",
      allowedMcpAliases: new Set(["mcp_read"]),
      annotations: new Map([
        [
          "mcp_read",
          {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        ],
      ]),
    });

    const visibleNames = snapshot.specs.map((spec) => spec.name);
    expect(visibleNames).toEqual(["list_files", "mcp_read", "write_file"]);
    expect([...snapshot.names]).toEqual(visibleNames);
    expect(snapshot.has("screenshot_to_code")).toBe(false);
    expect(snapshot.has("mcp_read")).toBe(true);
    expect(snapshot.isReadOnly("mcp_read")).toBe(false);
    expect(snapshot.get("mcp_read")?.spec.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true }),
    );
    expect(snapshot.get("mcp_read")?.spec.hostApproval).toBe("session");
    expect(snapshot.get("list_files")?.spec.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true }),
    );
    expect(snapshot.get("write_file")?.spec).toEqual(
      expect.objectContaining({ hostApproval: "session" }),
    );
  });

  it("adds attachment access as an explicit read-only capability", async () => {
    const snapshot = await createLocalToolAuthoritySnapshot({
      tools: {},
      mode: "chat",
      platform: "desktop",
      extraSpecs: [
        {
          name: "read_attachment",
          description: "Read an attachment",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(snapshot.specs).toEqual([
      expect.objectContaining({
        name: "read_attachment",
        annotations: expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
        }),
        hostApproval: "none",
      }),
    ]);
    expect(snapshot.isReadOnly("read_attachment")).toBe(true);
  });

  it("keeps attachment access alongside ordinary Host project writes", async () => {
    const snapshot = await createLocalToolAuthoritySnapshot({
      tools: { write_file: BUILTIN_TOOLS.write_file },
      mode: "chat",
      platform: "desktop",
      extraSpecs: [
        {
          name: "read_attachment",
          description: "Read an attachment",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(snapshot.specs.map((spec) => spec.name)).toEqual([
      "read_attachment",
      "write_file",
    ]);
    expect(snapshot.isReadOnly("read_attachment")).toBe(true);
    expect(snapshot.isReadOnly("write_file")).toBe(false);
  });

  it("does not expose dynamic tools without this run's MCP allowlist", async () => {
    const snapshot = await createLocalToolAuthoritySnapshot({
      tools: { mcp_read: tools.mcp_read },
      mode: "chat",
      platform: "desktop",
    });

    expect(snapshot.specs).toEqual([]);
    expect(snapshot.names).not.toContain("mcp_read");
  });
});
