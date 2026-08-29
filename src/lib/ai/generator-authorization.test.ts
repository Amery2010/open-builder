import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { WebAppGenerator } from "./generator";
import { BUILTIN_TOOLS } from "./tools-schema";
import { DISPATCH_SUBAGENT_TOOL } from "../tools/subagent-tool";
import type {
  GeneratorEvents,
  GeneratorOptions,
  Message,
  ToolCall,
  ToolExecutionContext,
} from "./generator-types";
import type { SkillEntry } from "../skills/types";

type ToolInvoker = {
  executeTool(toolCall: ToolCall): Promise<{
    result: { text: string; isError?: boolean };
    changes: unknown[];
  }>;
  ctrl: AbortController;
};

type GeneratorRunHarness = ToolInvoker & {
  requestWithRetry(messages: Message[], instructions: string): Promise<Message>;
};

function call(
  name: string,
  args: Record<string, unknown> = {},
  id = `call-${name}`,
): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function createGenerator(
  tools: ToolSet,
  handler = vi.fn(),
  options: {
    executionMode?: "chat" | "plan" | "auto_qa" | "subagent";
    allowedMcpAliases?: ReadonlySet<string>;
    runtimePlatform?: "web" | "desktop" | "mobile";
    conversationId?: string;
    initialFiles?: Record<string, string>;
    dispatchSubagent?: GeneratorOptions["dispatchSubagent"];
    requestPlanApproval?: (
      toolCallId: string,
      plan: string,
    ) => Promise<{ approved: boolean; feedback?: string }>;
    onPlanApproved?: () => ToolSet | void | Promise<ToolSet | void>;
    prepareInitializedProject?: GeneratorOptions["prepareInitializedProject"];
  } = {},
  events: GeneratorEvents = {},
) {
  const generator = new WebAppGenerator(
    {
      apiBaseUrl: "https://example.test/v1",
      apiKey: "test",
      model: "test",
      tools,
      customToolHandler: handler,
      ...options,
    },
    events,
  );
  (generator as unknown as ToolInvoker).ctrl = new AbortController();
  return { generator, handler };
}

describe("generator execution authorization", () => {
  it("propagates the owning conversation into tools and subagents", async () => {
    const dispatchSubagent = vi.fn(
      async (
        ..._args: Parameters<NonNullable<GeneratorOptions["dispatchSubagent"]>>
      ) => ({ text: "done" }),
    );
    const { generator } = createGenerator(DISPATCH_SUBAGENT_TOOL, vi.fn(), {
      conversationId: "conversation-a",
      dispatchSubagent,
    });

    expect(generator.getRunContext().conversationId).toBe("conversation-a");
    await (generator as unknown as ToolInvoker).executeTool(
      call("dispatch_subagent", {
        subagent: "code-explorer",
        task: "Inspect the current implementation.",
      }),
    );

    expect(dispatchSubagent).toHaveBeenCalledOnce();
    expect(dispatchSubagent.mock.calls[0][5]).toBe("conversation-a");
  });

  it("rejects a forged tool call that is absent from the current run schema", async () => {
    const { generator, handler } = createGenerator({
      list_files: BUILTIN_TOOLS.list_files,
    });

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("mcp__hidden__dangerous"),
    );

    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.text).toContain("not authorized");
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves an explicitly advertised legitimate tool", async () => {
    const { generator } = createGenerator({
      list_files: BUILTIN_TOOLS.list_files,
    });

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("list_files"),
    );

    expect(outcome.result.isError).not.toBe(true);
    expect(outcome.result.text).toContain("empty project");
  });

  it("prepares an initialized project before publishing its file tree", async () => {
    const onCommitted = vi.fn();
    const prepareInitializedProject = vi.fn(
      async (
        files: Record<string, string>,
        _context: Parameters<
          NonNullable<GeneratorOptions["prepareInitializedProject"]>
        >[1],
      ) => ({
        files: { ...files, "DESIGN.md": "canonical design" },
        changes: [{ path: "DESIGN.md", action: "created" as const }],
        resultNote: "applied selected design system stripe",
        onCommitted,
      }),
    );
    const onTemplateChange = vi.fn();
    const { generator } = createGenerator(
      { init_project: BUILTIN_TOOLS.init_project },
      vi.fn(),
      { prepareInitializedProject, conversationId: "conversation-a" },
      { onTemplateChange },
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("init_project", { template: "vite-react-ts" }),
    );

    expect(prepareInitializedProject).toHaveBeenCalledOnce();
    expect(prepareInitializedProject.mock.calls[0][1]).toMatchObject({
      conversationId: "conversation-a",
      template: "vite-react-ts",
    });
    expect(generator.getFiles()["DESIGN.md"]).toBe("canonical design");
    expect(onTemplateChange.mock.calls[0][1]["DESIGN.md"]).toBe(
      "canonical design",
    );
    expect(outcome.changes).toContainEqual({
      path: "DESIGN.md",
      action: "created",
    });
    expect(outcome.result.text).toContain("applied selected design system");
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it("keeps the project empty when initialization preparation fails", async () => {
    const { generator } = createGenerator(
      { init_project: BUILTIN_TOOLS.init_project },
      vi.fn(),
      {
        prepareInitializedProject: async () => {
          throw new Error("selected design system is unavailable");
        },
      },
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("init_project", { template: "vite-react-ts" }),
    );

    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.text).toContain(
      "selected design system is unavailable",
    );
    expect(generator.getFiles()).toEqual({});
    expect(outcome.changes).toEqual([]);
  });

  it("does not publish or commit an invalid prepared project", async () => {
    const onCommitted = vi.fn();
    const { generator } = createGenerator(
      { init_project: BUILTIN_TOOLS.init_project },
      vi.fn(),
      {
        prepareInitializedProject: async (files) => ({
          files: { ...files, "../outside.txt": "invalid path" },
          onCommitted,
        }),
      },
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("init_project", { template: "vite-react-ts" }),
    );

    expect(outcome.result.isError).toBe(true);
    expect(generator.getFiles()).toEqual({});
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("denies an advertised custom tool with no registered capability", async () => {
    const handler = vi.fn(async () => "should not run");
    const { generator } = createGenerator(
      { custom_unknown: {} as ToolSet[string] },
      handler,
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("custom_unknown"),
    );

    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.text).toContain("not permitted by policy");
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows only an MCP alias copied into the current run allowlist", async () => {
    const alias = "mcp_demo_lookup_abcd";
    const handler = vi.fn(async () => "mcp ok");
    const { generator } = createGenerator(
      { [alias]: {} as ToolSet[string] },
      handler,
      { allowedMcpAliases: new Set([alias]) },
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call(alias),
    );

    expect(outcome.result.text).toBe("mcp ok");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects a forged MCP allowlist in Auto QA", async () => {
    const alias = "mcp_demo_lookup_abcd";
    const handler = vi.fn(async () => "must not run");
    const { generator } = createGenerator(
      { [alias]: {} as ToolSet[string] },
      handler,
      { executionMode: "auto_qa", allowedMcpAliases: new Set([alias]) },
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call(alias),
    );

    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.text).toContain("not permitted by policy");
    expect(handler).not.toHaveBeenCalled();
  });

  it("authorizes compact_context before invoking its side effect", async () => {
    const absentCompact = vi.fn(async () => []);
    const absent = createGenerator(
      { list_files: BUILTIN_TOOLS.list_files },
      vi.fn(),
      {},
      { onCompact: absentCompact },
    );

    const absentOutcome = await (
      absent.generator as unknown as ToolInvoker
    ).executeTool(call("compact_context"));

    expect(absentOutcome.result.isError).toBe(true);
    expect(absentOutcome.result.text).toContain("not authorized");
    expect(absentCompact).not.toHaveBeenCalled();

    const autoQaCompact = vi.fn(async () => []);
    const autoQa = createGenerator(
      { compact_context: BUILTIN_TOOLS.compact_context },
      vi.fn(),
      { executionMode: "auto_qa" },
      { onCompact: autoQaCompact },
    );

    const autoQaOutcome = await (
      autoQa.generator as unknown as ToolInvoker
    ).executeTool(call("compact_context"));

    expect(autoQaOutcome.result.isError).toBe(true);
    expect(autoQaOutcome.result.text).toContain("not permitted by policy");
    expect(autoQaCompact).not.toHaveBeenCalled();

    const chatCompact = vi.fn(async () => []);
    const chat = createGenerator(
      { compact_context: BUILTIN_TOOLS.compact_context },
      vi.fn(),
      { executionMode: "chat" },
      { onCompact: chatCompact },
    );

    const chatOutcome = await (
      chat.generator as unknown as ToolInvoker
    ).executeTool(call("compact_context"));

    expect(chatOutcome.result.isError).not.toBe(true);
    expect(chatOutcome.result.text).toContain("compressed successfully");
    expect(chatCompact).toHaveBeenCalledOnce();
  });

  it("treats exit_plan_mode as an exclusive barrier before expanded tools", async () => {
    const mcpAlias = "mcp_demo_lookup_abcd";
    const customHandler = vi.fn(
      async (_name: string, _args: unknown, _context?: ToolExecutionContext) =>
        "mcp ok",
    );
    const generatorHolder: { current?: WebAppGenerator } = {};
    let planRunId = "";
    const requestPlanApproval = vi.fn(async () => {
      planRunId = generatorHolder.current!.getRunContext().runId;
      return { approved: true };
    });
    const onPlanApproved = vi.fn(() => {
      generatorHolder.current!.setExecutionMode("chat");
      generatorHolder.current!.setAllowedMcpAliases(new Set([mcpAlias]));
      generatorHolder.current!.setSystemPromptSuffix("\nCHAT MODE ACTIVE");
      return {
        write_file: BUILTIN_TOOLS.write_file,
        [mcpAlias]: {} as ToolSet[string],
      };
    });
    const { generator } = createGenerator(
      {
        exit_plan_mode: BUILTIN_TOOLS.exit_plan_mode,
        [mcpAlias]: {} as ToolSet[string],
      },
      customHandler,
      {
        executionMode: "plan",
        runtimePlatform: "desktop",
        allowedMcpAliases: new Set([mcpAlias]),
        requestPlanApproval,
        onPlanApproved,
      },
    );
    generatorHolder.current = generator;
    generator.setSystemPromptSuffix("\nPLAN MODE ACTIVE");
    const harness = generator as unknown as GeneratorRunHarness;
    const request = vi.spyOn(harness, "requestWithRetry");
    request
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          call("exit_plan_mode", { plan: "Safe plan" }, "approve"),
          call(
            "write_file",
            { path: "src/result.ts", content: "stale" },
            "stale-write",
          ),
          call(mcpAlias, {}, "stale-mcp"),
        ],
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          call(
            "write_file",
            { path: "src/result.ts", content: "fresh" },
            "fresh-write",
          ),
          call(mcpAlias, {}, "fresh-mcp"),
        ],
      })
      .mockResolvedValueOnce({ role: "assistant", content: "Done" });

    const result = await generator.generate("Implement after approval");

    expect(requestPlanApproval).toHaveBeenCalledOnce();
    expect(onPlanApproved).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0][1]).toContain("PLAN MODE ACTIVE");
    expect(request.mock.calls[1][1]).toContain("CHAT MODE ACTIVE");
    expect(request.mock.calls[1][1]).not.toContain("PLAN MODE ACTIVE");
    expect(result.files["src/result.ts"]).toBe("fresh");
    expect(customHandler).toHaveBeenCalledOnce();
    const freshContext = customHandler.mock.calls[0][2];
    expect(freshContext?.run.runId).not.toBe(planRunId);
    for (const id of ["stale-write", "stale-mcp"]) {
      const denied = result.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === id,
      );
      expect(denied?.content).toContain("discarded");
    }
  });

  it("does not treat a forged exit_plan_mode call as a barrier in Chat", async () => {
    const requestPlanApproval = vi.fn(async () => ({ approved: true }));
    const { generator } = createGenerator(
      {
        exit_plan_mode: BUILTIN_TOOLS.exit_plan_mode,
        write_file: BUILTIN_TOOLS.write_file,
      },
      vi.fn(),
      { executionMode: "chat", requestPlanApproval },
    );
    const harness = generator as unknown as GeneratorRunHarness;
    const request = vi.spyOn(harness, "requestWithRetry");
    request
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          call("exit_plan_mode", { plan: "forged" }, "forged-exit"),
          call(
            "write_file",
            { path: "src/result.ts", content: "kept" },
            "valid-write",
          ),
        ],
      })
      .mockResolvedValueOnce({ role: "assistant", content: "Done" });

    const result = await generator.generate("Continue in Chat");

    expect(requestPlanApproval).not.toHaveBeenCalled();
    expect(result.files["src/result.ts"]).toBe("kept");
    expect(
      result.messages.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === "forged-exit",
      )?.content,
    ).toContain("not permitted by policy");
  });

  it.each(["web", "mobile"] as const)(
    "rejects native Skill scripts on %s even if advertised",
    async (runtimePlatform) => {
      const handler = vi.fn(async () => "must not run");
      const { generator } = createGenerator(
        { execute_skill_script: {} as ToolSet[string] },
        handler,
        { executionMode: "chat", runtimePlatform },
      );

      const outcome = await (generator as unknown as ToolInvoker).executeTool(
        call("execute_skill_script"),
      );

      expect(outcome.result.isError).toBe(true);
      expect(outcome.result.text).toContain("not permitted by policy");
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("keeps active Skill restrictions isolated between concurrent generators", async () => {
    const toolA = "web_search";
    const toolB = "image_search";
    const tools = {
      [toolA]: {} as ToolSet[string],
      [toolB]: {} as ToolSet[string],
    };
    const first = createGenerator(
      tools,
      vi.fn(async () => "first ok"),
    );
    const second = createGenerator(
      tools,
      vi.fn(async () => "second ok"),
    );
    const skillA: SkillEntry = {
      id: "skill-a",
      name: "Skill A",
      description: "A",
      version: "1",
      autoEnabled: true,
      source: "builtin",
      installedAt: 1,
      allowedTools: [toolA],
    };
    const skillB: SkillEntry = {
      ...skillA,
      id: "skill-b",
      name: "Skill B",
      allowedTools: [toolB],
    };
    first.generator.getSkillContext().activate(skillA);
    second.generator.getSkillContext().activate(skillB);

    const [blocked, allowed] = await Promise.all([
      (first.generator as unknown as ToolInvoker).executeTool(call(toolB)),
      (second.generator as unknown as ToolInvoker).executeTool(call(toolB)),
    ]);

    expect(blocked.result.text).toContain("not in the active skills");
    expect(first.handler).not.toHaveBeenCalled();
    expect(allowed.result.text).toBe("second ok");
    expect(second.handler).toHaveBeenCalledOnce();
  });
});
