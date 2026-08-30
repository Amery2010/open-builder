import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { TOOL_POLICY_VERSION } from "../../ai/tool-policy-version";
import { useMcpStore } from "../../../store/mcp";
import { createMcpServerEntry } from "../validation";
import { AGNES_TOOL_ALIASES } from "./aliases";
import { buildAgnesMcpRuntimeBundle } from "./runtime";
import {
  AGNES_MCP_DEFINITION_VERSION,
  AGNES_MCP_SERVER_ID,
  AGNES_TOOL_DEFINITIONS,
  AGNES_TOOL_NAMES,
  createDefaultAgnesMcpSettings,
  normalizeAgnesMcpSettings,
} from "./types";

vi.mock("localforage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    createInstance: () => ({
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    }),
  },
}));

describe("Agnes MCP runtime projection", () => {
  beforeEach(() => {
    const agnes = createDefaultAgnesMcpSettings(1);
    agnes.enabled = true;
    agnes.apiKey = "secret";
    for (const name of AGNES_TOOL_NAMES) agnes.tools[name].enabled = true;
    agnes.tools.generate_image.allowForSubagents = true;
    agnes.tools.generate_image.subagentPolicyVersion = TOOL_POLICY_VERSION;
    useMcpStore.setState({
      globalEnabled: true,
      agnes,
      servers: {},
      runtime: {},
    });
  });

  it("exposes all approved tools to Chat, none to Plan, and only images to subagents", async () => {
    const bundle = await buildAgnesMcpRuntimeBundle(true);

    expect(new Set(Object.keys(bundle.tools))).toEqual(
      new Set(Object.values(AGNES_TOOL_ALIASES)),
    );
    expect(bundle.planModeToolNames).toEqual(new Set());
    expect(bundle.subagentToolNames).toEqual(
      new Set([AGNES_TOOL_ALIASES.generate_image]),
    );
    expect(bundle.subagentToolNames).not.toContain(
      AGNES_TOOL_ALIASES.create_video,
    );
    expect(bundle.subagentToolNames).not.toContain(
      AGNES_TOOL_ALIASES.get_video_status,
    );
  });

  it("returns an empty managed bundle when MCP is excluded from the run", async () => {
    const bundle = await buildAgnesMcpRuntimeBundle(false);
    expect(bundle.tools).toEqual({});
    expect(bundle.aliases).toEqual(new Map());
  });

  it("uses an identity that imported external MCP servers cannot claim", () => {
    expect(() =>
      createMcpServerEntry(
        {
          name: "Collision",
          transport: "streamable-http",
          url: "https://mcp.example.com/rpc",
        },
        { id: AGNES_MCP_SERVER_ID },
      ),
    ).toThrow(/server id/i);
  });

  it("resets tool grants when definitions or the elevated policy are stale", () => {
    const staleDefinition = normalizeAgnesMcpSettings({
      enabled: true,
      apiKey: "secret",
      definitionVersion: AGNES_MCP_DEFINITION_VERSION - 1,
      tools: {
        generate_image: {
          enabled: true,
          allowForSubagents: true,
          subagentPolicyVersion: TOOL_POLICY_VERSION,
        },
        create_video: { enabled: true, allowForSubagents: false },
        get_video_status: { enabled: true, allowForSubagents: false },
      },
      updatedAt: 1,
    });
    expect(
      Object.values(staleDefinition.tools).every((tool) => !tool.enabled),
    ).toBe(true);

    const stalePolicy = normalizeAgnesMcpSettings({
      enabled: true,
      apiKey: "secret",
      definitionVersion: AGNES_MCP_DEFINITION_VERSION,
      tools: {
        generate_image: {
          enabled: true,
          allowForSubagents: true,
          subagentPolicyVersion: "old-policy",
        },
        create_video: { enabled: false, allowForSubagents: false },
        get_video_status: { enabled: false, allowForSubagents: false },
      },
      updatedAt: 1,
    });
    expect(stalePolicy.tools.generate_image).toMatchObject({
      enabled: true,
      allowForSubagents: false,
    });

    expect(
      normalizeAgnesMcpSettings({
        enabled: true,
        apiKey: 42 as never,
      }),
    ).toMatchObject({ enabled: false, apiKey: "" });
  });

  it("ties every managed tool-definition change to a version bump", () => {
    const approvedDefinitions: Record<number, string> = {
      1: "07376b3e935949054d846cda8213ec786de2821eab7c78efc1b6fb082bee29b5",
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(AGNES_TOOL_DEFINITIONS))
      .digest("hex");
    expect(digest).toBe(approvedDefinitions[AGNES_MCP_DEFINITION_VERSION]);
  });
});
