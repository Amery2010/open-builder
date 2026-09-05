import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  HostToolCatalog,
  HostToolDispatchError,
  type HostToolRecord,
} from "./host-tool-catalog";
import type { ToolRunContext } from "./tools-schema";

const definition = tool({
  description: "Inspect a value",
  inputSchema: z.object({ value: z.string() }),
});

const record: HostToolRecord = {
  name: "inspect_value",
  definition,
  source: "builtin",
  effects: ["read_runtime"],
  modes: ["chat"],
  profiles: ["default"],
  platforms: ["web"],
  approval: "none",
  outputRetention: "summary-only",
  presentation: {
    name: { en: "Inspect value", zh: "检查值" },
    iconKey: "inspect",
    summarizeArguments: () => "value",
  },
  implementation: { kind: "host", key: "inspect-value" },
};

function context(mode: ToolRunContext["mode"] = "chat"): ToolRunContext {
  return {
    runId: "run-1",
    mode,
    platform: "web",
    runtime: "api",
    allowedMcpAliases: new Set(),
    activeSkillIds: new Set(),
    approvedSkillScriptHashes: new Set(),
    policyVersion: "test",
  };
}

describe("HostToolCatalog", () => {
  it("compiles immutable model and authority projections from one record", () => {
    const catalog = new HostToolCatalog([record]);
    const run = catalog.openRun({
      tools: { inspect_value: definition },
      context: context(),
    });

    expect(run.modelTools.inspect_value).toBe(definition);
    expect(run.authority.get("inspect_value")?.presentation.name).toEqual({
      en: "Inspect value",
      zh: "检查值",
    });
    expect(() => (run.authority.names as Set<string>).add("escape")).toThrow();
    expect(run.authority.has("escape")).toBe(false);
  });

  it("validates before guard, approval, implementation, state and retention", async () => {
    const order: string[] = [];
    const catalog = new HostToolCatalog([record]);
    const run = catalog.openRun({
      tools: { inspect_value: definition },
      context: context(),
      guard: () => {
        order.push("guard");
      },
      requestApproval: () => {
        order.push("approval");
      },
      hostDispatcher: (call) => {
        order.push("implementation");
        return call.input;
      },
      validateState: () => {
        order.push("state");
      },
      retainOutput: (result) => {
        order.push("retention");
        return result;
      },
      audit: () => {
        order.push("audit");
      },
    });

    await expect(
      run.dispatch({ name: "inspect_value", input: { value: "ok" } }),
    ).resolves.toEqual({ value: "ok" });
    expect(order).toEqual([
      "guard",
      "approval",
      "implementation",
      "state",
      "retention",
      "audit",
    ]);

    order.length = 0;
    await expect(
      run.dispatch({ name: "inspect_value", input: { value: 1 } }),
    ).rejects.toMatchObject({ stage: "schema" });
    expect(order).toEqual([]);
  });

  it("rotates authority by opening a new run instead of mutating the old one", () => {
    const catalog = new HostToolCatalog([record]);
    const chat = catalog.openRun({
      tools: { inspect_value: definition },
      context: context(),
    });
    const plan = catalog.openRun({
      tools: { inspect_value: definition },
      context: context("plan"),
    });

    expect(chat.authority.has("inspect_value")).toBe(true);
    expect(plan.authority.has("inspect_value")).toBe(false);
    expect(chat.authority.has("inspect_value")).toBe(true);
  });

  it("copies dynamic authority so MCP drift cannot mutate an open run", () => {
    const aliases = new Set(["mcp_demo_lookup"]);
    const dynamicDefinition = tool({
      description: "MCP lookup",
      inputSchema: z.object({}),
    });
    const catalog = new HostToolCatalog([]);
    const opened = catalog.openRun({
      tools: { mcp_demo_lookup: dynamicDefinition },
      context: { ...context(), allowedMcpAliases: aliases },
      allowedDynamicNames: aliases,
    });
    aliases.clear();
    const reopened = catalog.openRun({
      tools: { mcp_demo_lookup: dynamicDefinition },
      context: { ...context(), allowedMcpAliases: aliases },
      allowedDynamicNames: aliases,
    });

    expect(opened.authority.has("mcp_demo_lookup")).toBe(true);
    expect(reopened.authority.has("mcp_demo_lookup")).toBe(false);
  });

  it("fails closed on static and adapter name collisions", () => {
    const catalog = new HostToolCatalog([record]);
    const replacement = tool({
      description: "Replacement",
      inputSchema: z.object({}),
    });

    expect(() =>
      catalog.openRun({
        tools: { inspect_value: replacement },
        context: context(),
        allowedDynamicNames: new Set(["inspect_value"]),
      }),
    ).toThrow(/name collision/);
    expect(() => new HostToolCatalog([record, record])).toThrow(/Duplicate/);
    expect(() =>
      catalog.openRun({
        tools: { inspect_value: definition },
        context: context(),
        providerOwnedNames: new Set(["inspect_value"]),
      }),
    ).toThrow(/provider ownership is not declared/);
  });

  it("keeps provider tools visible but outside Host dispatch", async () => {
    const providerRecord: HostToolRecord = {
      ...record,
      name: "native_search",
      definition: undefined,
      source: "network",
      implementation: { kind: "provider" },
    };
    const nativeDefinition = tool({
      description: "Native search",
      inputSchema: z.object({ query: z.string() }),
    });
    const hostDispatcher = vi.fn();
    const run = new HostToolCatalog([providerRecord]).openRun({
      tools: { native_search: nativeDefinition },
      context: context(),
      providerOwnedNames: new Set(["native_search"]),
      hostDispatcher,
    });

    expect(run.providerOwnedNames.has("native_search")).toBe(true);
    await expect(
      run.dispatch({ name: "native_search", input: { query: "x" } }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HostToolDispatchError>>({
        stage: "implementation",
      }),
    );
    expect(hostDispatcher).not.toHaveBeenCalled();
  });

  it("lets an explicitly provider-owned adapter replace the host schema for that run", () => {
    const providerDefinition = tool({
      description: "Provider-native implementation",
      inputSchema: z.object({ query: z.string() }),
    });
    const run = new HostToolCatalog([
      {
        ...record,
        implementation: {
          kind: "host",
          key: "inspect-value",
          providerAlternative: true,
        },
      },
    ]).openRun({
      tools: { inspect_value: providerDefinition },
      context: context(),
      providerOwnedNames: new Set(["inspect_value"]),
    });

    expect(run.modelTools.inspect_value).toBe(providerDefinition);
    expect(run.providerOwnedNames.has("inspect_value")).toBe(true);
    expect(run.authority.get("inspect_value")?.implementation).toEqual({
      kind: "provider",
    });
  });
});
