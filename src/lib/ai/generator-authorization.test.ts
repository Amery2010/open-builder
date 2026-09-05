import { describe, expect, it, vi } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { WebAppGenerator } from "./generator";
import {
  BUILTIN_TOOLS,
  DESIGN_DIAGNOSTIC_TOOLS,
  DESIGN_HOST_TOOLS,
} from "./tools-schema";
import { DISPATCH_SUBAGENT_TOOL } from "../tools/subagent-tool";
import type {
  FileChange,
  GeneratorEvents,
  GeneratorOptions,
  Message,
  ToolCall,
  ToolExecutionContext,
} from "./generator-types";
import type { SkillEntry } from "../skills/types";
import { createDesignContractController } from "../design/run-contract";
import { SUBMIT_DESIGN_CONTRACT_TOOL } from "../design/run-contract-tool";
import { SCRIPT_SKILL_TOOL } from "../skills/tools";
import { SEARCH_TOOLS } from "../tools/search";
import { ASSET_SEARCH_TOOLS } from "../tools/asset-search";
import {
  createProjectPermissionBroker,
  type ProjectPermissionAuditEvent,
  type ProjectPermissionDecision,
  type ProjectPermissionSession,
} from "../security/project-permission-broker";
import * as fsTools from "../tools/fs-tools";

const EMPTY_TEST_TOOL = tool({
  description: "Test dynamic tool",
  inputSchema: z.object({}),
});

type ToolInvoker = {
  executeTool(toolCall: ToolCall): Promise<{
    result: {
      text: string;
      isError?: boolean;
      retention?: "full" | "summary-only" | "run-only";
    };
    changes: unknown[];
    hadSideEffect: boolean;
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
    authorizeToolCall?: GeneratorOptions["authorizeToolCall"];
    projectPermissionSession?: ProjectPermissionSession;
    toolRuntime?: GeneratorOptions["toolRuntime"];
    onProjectPermissionAuthorityChange?: GeneratorOptions["onProjectPermissionAuthorityChange"];
    onProjectPermissionRequestFinished?: GeneratorOptions["onProjectPermissionRequestFinished"];
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

function createPermissionHarness(input?: {
  decisions?: readonly ProjectPermissionDecision[];
  decide?: (
    request: Parameters<
      Parameters<typeof createProjectPermissionBroker>[0]["decision"]["decide"]
    >[0],
    signal: AbortSignal,
  ) => ProjectPermissionDecision | Promise<ProjectPermissionDecision>;
  audit?: (event: ProjectPermissionAuditEvent) => void | Promise<void>;
  bypassEnabled?: boolean;
}) {
  const queued = [...(input?.decisions ?? [])];
  const decide = vi.fn(
    input?.decide ?? (() => queued.shift() ?? ({ kind: "deny" } as const)),
  );
  const events: ProjectPermissionAuditEvent[] = [];
  const audit = vi.fn(async (event: ProjectPermissionAuditEvent) => {
    events.push(event);
    await input?.audit?.(event);
  });
  const session = createProjectPermissionBroker({
    decision: { decide },
    audit: { record: audit },
  }).openSession({
    conversationId: "conversation-a",
    policyVersion: "test-policy",
    projectRevision: 0,
    bypassEnabled: input?.bypassEnabled ?? false,
  });
  return { session, decide, audit, events };
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

  it("does not prompt for ordinary ProjectFiles writes or patches", async () => {
    const permission = createPermissionHarness();
    const { generator } = createGenerator(
      {
        write_file: BUILTIN_TOOLS.write_file,
        patch_file: BUILTIN_TOOLS.patch_file,
      },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "src/App.ts": "export const value = 1;" },
        projectPermissionSession: permission.session,
      },
    );
    const harness = generator as unknown as ToolInvoker;

    await harness.executeTool(
      call("write_file", {
        path: "src/App.ts",
        content: "export const value = 2;",
      }),
    );
    await harness.executeTool(
      call("patch_file", {
        path: "src/App.ts",
        patches: [{ search: "value = 2", replace: "value = 3" }],
      }),
    );

    expect(permission.decide).not.toHaveBeenCalled();
    expect(generator.getFiles()["src/App.ts"]).toContain("value = 3");
  });

  it("authorizes deletion once, rotates authority, and settles the result", async () => {
    const permission = createPermissionHarness({
      decisions: [{ kind: "allow_once" }],
    });
    const authorityChanged = vi.fn();
    const { generator } = createGenerator(
      { delete_file: BUILTIN_TOOLS.delete_file },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "src/old.ts": "old" },
        projectPermissionSession: permission.session,
        onProjectPermissionAuthorityChange: authorityChanged,
      },
    );
    const initialRunId = generator.getRunContext().runId;

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("delete_file", { path: "src/old.ts" }, "delete-once"),
    );

    expect(outcome.result.isError).not.toBe(true);
    expect(generator.getFiles()).toEqual({});
    expect(permission.decide).toHaveBeenCalledOnce();
    expect(generator.getRunContext().runId).not.toBe(initialRunId);
    expect(permission.session.authority().grants).toEqual([]);
    expect(authorityChanged).toHaveBeenCalled();
    expect(permission.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "requested",
        "approved",
        "execution_started",
        "settled",
      ]),
    );
  });

  it("reuses a denial only within the same generation run", async () => {
    const permission = createPermissionHarness({
      decisions: [{ kind: "deny" }],
    });
    const { generator } = createGenerator(
      { delete_file: BUILTIN_TOOLS.delete_file },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "src/old.ts": "old" },
        projectPermissionSession: permission.session,
      },
    );
    const harness = generator as unknown as ToolInvoker;

    const first = await harness.executeTool(
      call("delete_file", { path: "src/old.ts" }, "denied-1"),
    );
    const second = await harness.executeTool(
      call("delete_file", { path: "src/old.ts" }, "denied-2"),
    );

    expect(first.result.text).toContain("permission_denied");
    expect(second.result.text).toContain("permission_denied");
    expect(permission.decide).toHaveBeenCalledOnce();
    expect(generator.getFiles()["src/old.ts"]).toBe("old");
  });

  it("reuses session scope for the same operation but not another operation", async () => {
    const permission = createPermissionHarness({
      decisions: [
        { kind: "allow_session", scope: { kind: "project" } },
        { kind: "allow_once" },
      ],
    });
    const { generator } = createGenerator(
      {
        delete_file: BUILTIN_TOOLS.delete_file,
        rename_file: BUILTIN_TOOLS.rename_file,
      },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: {
          "src/a.ts": "a",
          "src/b.ts": "b",
          "src/c.ts": "c",
        },
        projectPermissionSession: permission.session,
      },
    );
    const harness = generator as unknown as ToolInvoker;

    await harness.executeTool(
      call("delete_file", { path: "src/a.ts" }, "delete-a"),
    );
    await harness.executeTool(
      call("delete_file", { path: "src/b.ts" }, "delete-b"),
    );
    await harness.executeTool(
      call(
        "rename_file",
        { old_path: "src/c.ts", new_path: "src/d.ts" },
        "move-c",
      ),
    );

    expect(permission.decide).toHaveBeenCalledTimes(2);
    expect(permission.decide.mock.calls[0][0].operation).toBe("delete");
    expect(permission.decide.mock.calls[1][0].operation).toBe("move");
    expect(generator.getFiles()).toEqual({ "src/d.ts": "c" });
  });

  it("requires once-only approval to replace a non-empty project", async () => {
    const permission = createPermissionHarness({
      decisions: [{ kind: "allow_once" }],
    });
    const { generator } = createGenerator(
      { init_project: BUILTIN_TOOLS.init_project },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "legacy.txt": "old project" },
        projectPermissionSession: permission.session,
      },
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("init_project", { template: "static" }, "replace-project"),
    );

    expect(outcome.result.isError).not.toBe(true);
    expect(permission.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "replace_project",
        sessionEligible: false,
        scope: { kind: "project" },
      }),
      expect.any(AbortSignal),
    );
    expect(permission.session.authority().grants).toEqual([]);
    expect(generator.getFiles()["legacy.txt"]).toBeUndefined();
  });

  it("previews the complete prepared Design initialization impact", async () => {
    const prepareInitializedProject = vi.fn(
      async (files: Record<string, string>) => ({
        files: {
          ...files,
          "DESIGN.md": "design contract",
          "tokens.css": ":root { --accent: teal; }",
        },
      }),
    );
    const permission = createPermissionHarness({
      decisions: [{ kind: "allow_once" }],
    });
    const { generator } = createGenerator(
      { init_project: BUILTIN_TOOLS.init_project },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "legacy.txt": "old project" },
        projectPermissionSession: permission.session,
        prepareInitializedProject,
      },
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("init_project", { template: "static" }, "prepared-replacement"),
    );
    const request = permission.decide.mock.calls[0][0];
    const committedPaths = outcome.changes
      .map((change) => (change as FileChange).path)
      .sort();

    expect(prepareInitializedProject).toHaveBeenCalledOnce();
    expect(request.affectedPaths).toEqual(committedPaths);
    expect(request.affectedPaths).toEqual(
      expect.arrayContaining(["DESIGN.md", "tokens.css", "legacy.txt"]),
    );
    expect(request.affectedCount).toBe(committedPaths.length);
  });

  it("does not prompt when non-empty initialization preparation will fail", async () => {
    const permission = createPermissionHarness({
      decisions: [{ kind: "allow_once" }],
    });
    const { generator } = createGenerator(
      { init_project: BUILTIN_TOOLS.init_project },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "legacy.txt": "old project" },
        projectPermissionSession: permission.session,
        prepareInitializedProject: async () => {
          throw new Error("selected design system is unavailable");
        },
      },
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("init_project", { template: "static" }, "failed-preparation"),
    );

    expect(permission.decide).not.toHaveBeenCalled();
    expect(outcome.result.text).toContain(
      "selected design system is unavailable",
    );
    expect(generator.getFiles()).toEqual({ "legacy.txt": "old project" });
  });

  it("keeps files unchanged when required approval audit cannot be persisted", async () => {
    const permission = createPermissionHarness({
      decisions: [{ kind: "allow_once" }],
      audit: (event) => {
        if (event.type === "execution_started") {
          throw new Error("audit storage unavailable");
        }
      },
    });
    const { generator } = createGenerator(
      { delete_file: BUILTIN_TOOLS.delete_file },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "src/old.ts": "old" },
        projectPermissionSession: permission.session,
      },
    );
    const initialRunId = generator.getRunContext().runId;

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("delete_file", { path: "src/old.ts" }, "audit-failed"),
    );

    expect(outcome.result.text).toContain("permission_audit_unavailable");
    expect(generator.getFiles()["src/old.ts"]).toBe("old");
    expect(generator.getRunContext().runId).not.toBe(initialRunId);
  });

  it("bypasses only the Broker and preserves other Host guards", async () => {
    const permission = createPermissionHarness({
      bypassEnabled: true,
      audit: () => {
        throw new Error("best-effort audit unavailable");
      },
    });
    const { generator } = createGenerator(
      { delete_file: BUILTIN_TOOLS.delete_file },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "src/old.ts": "old", ".env": "SECRET=value" },
        projectPermissionSession: permission.session,
      },
    );
    const harness = generator as unknown as ToolInvoker;
    const deleted = await harness.executeTool(
      call("delete_file", { path: "src/old.ts" }, "bypassed-delete"),
    );
    const protectedPath = await harness.executeTool(
      call("delete_file", { path: ".env" }, "protected-delete"),
    );

    expect(deleted.result.isError).not.toBe(true);
    expect(protectedPath.result.text).toContain("manage_env");
    expect(permission.decide).not.toHaveBeenCalled();
    expect(generator.getFiles()[".env"]).toBe("SECRET=value");

    const planPermission = createPermissionHarness({ bypassEnabled: true });
    const plan = createGenerator(
      { delete_file: BUILTIN_TOOLS.delete_file },
      vi.fn(),
      {
        executionMode: "plan",
        conversationId: "conversation-a",
        initialFiles: { "src/plan.ts": "keep" },
        projectPermissionSession: planPermission.session,
      },
    );
    const blocked = await (
      plan.generator as unknown as ToolInvoker
    ).executeTool(call("delete_file", { path: "src/plan.ts" }, "plan-delete"));
    expect(blocked.result.text).toContain("not permitted by policy");
    expect(plan.generator.getFiles()["src/plan.ts"]).toBe("keep");
  });

  it("cancels a pending permission request when project state changes", async () => {
    let resolveDecision!: (decision: ProjectPermissionDecision) => void;
    const decision = new Promise<ProjectPermissionDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const permission = createPermissionHarness({ decide: () => decision });
    const { generator } = createGenerator(
      { delete_file: BUILTIN_TOOLS.delete_file },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "src/old.ts": "old" },
        projectPermissionSession: permission.session,
      },
    );
    const authorization = (generator as unknown as ToolInvoker).executeTool(
      call("delete_file", { path: "src/old.ts" }, "stale-delete"),
    );
    await vi.waitFor(() => expect(permission.decide).toHaveBeenCalledOnce());
    generator.setFiles({ "src/new.ts": "new" });

    const outcome = await authorization;
    expect(outcome.result.text).toContain("permission_stale");
    expect(generator.getFiles()).toEqual({ "src/new.ts": "new" });
    resolveDecision({ kind: "allow_once" });
  });

  it("aborts a pending permission request and revokes grants on Stop", async () => {
    const permission = createPermissionHarness({
      decide: () => new Promise<ProjectPermissionDecision>(() => undefined),
    });
    const { generator } = createGenerator(
      { delete_file: BUILTIN_TOOLS.delete_file },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "src/old.ts": "old" },
        projectPermissionSession: permission.session,
      },
    );
    const authorization = (generator as unknown as ToolInvoker).executeTool(
      call("delete_file", { path: "src/old.ts" }, "stopped-delete"),
    );
    await vi.waitFor(() => expect(permission.decide).toHaveBeenCalledOnce());

    generator.abort();

    await expect(authorization).rejects.toMatchObject({ name: "AbortError" });
    expect(permission.session.authority().grants).toEqual([]);
    expect(generator.getFiles()["src/old.ts"]).toBe("old");
  });

  it("does not commit a late project replacement after Stop", async () => {
    let finishPreparation!: (value: { files: Record<string, string> }) => void;
    const preparation = new Promise<{ files: Record<string, string> }>(
      (resolve) => {
        finishPreparation = resolve;
      },
    );
    const prepareInitializedProject = vi.fn(() => preparation);
    const permission = createPermissionHarness({
      decisions: [{ kind: "allow_once" }],
    });
    const { generator } = createGenerator(
      { init_project: BUILTIN_TOOLS.init_project },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "legacy.txt": "old project" },
        projectPermissionSession: permission.session,
        prepareInitializedProject,
      },
    );
    const execution = (generator as unknown as ToolInvoker).executeTool(
      call("init_project", { template: "static" }, "late-replacement"),
    );
    await vi.waitFor(() =>
      expect(prepareInitializedProject).toHaveBeenCalledOnce(),
    );

    generator.abort();
    finishPreparation({ files: { "index.html": "late replacement" } });

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(generator.getFiles()).toEqual({ "legacy.txt": "old project" });
  });

  it("does not commit a bypassed init after Stop while template loading is pending", async () => {
    let releaseTemplate!: () => void;
    let markTemplateStarted!: () => void;
    const templateStarted = new Promise<void>((resolve) => {
      markTemplateStarted = resolve;
    });
    const templateGate = new Promise<void>((resolve) => {
      releaseTemplate = resolve;
    });
    const originalDispatchFsTool = fsTools.dispatchFsTool;
    const dispatchSpy = vi
      .spyOn(fsTools, "dispatchFsTool")
      .mockImplementation(async (...args) => {
        if (args[0] === "init_project") {
          markTemplateStarted();
          await templateGate;
        }
        return originalDispatchFsTool(...args);
      });
    const permission = createPermissionHarness({ bypassEnabled: true });
    const { generator } = createGenerator(
      { init_project: BUILTIN_TOOLS.init_project },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "legacy.txt": "old project" },
        projectPermissionSession: permission.session,
      },
    );

    try {
      const execution = (generator as unknown as ToolInvoker).executeTool(
        call("init_project", { template: "static" }, "late-bypass-init"),
      );
      await templateStarted;

      generator.abort();
      releaseTemplate();

      await expect(execution).rejects.toMatchObject({ name: "AbortError" });
      expect(generator.getFiles()).toEqual({ "legacy.txt": "old project" });
    } finally {
      releaseTemplate();
      dispatchSpy.mockRestore();
    }
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
    expect(outcome.hadSideEffect).toBe(false);
  });

  it("validates and dispatches the default-preview Host tool through the run snapshot", async () => {
    const handler = vi.fn(() =>
      JSON.stringify({ ok: true, status: "updated", view: "mobile" }),
    );
    const { generator } = createGenerator(
      {
        set_default_preview_view: DESIGN_HOST_TOOLS.set_default_preview_view,
      },
      handler,
    );
    const harness = generator as unknown as ToolInvoker;

    const updated = await harness.executeTool(
      call("set_default_preview_view", { view: "mobile" }),
    );
    expect(updated.result).toMatchObject({ retention: "full" });
    expect(updated.hadSideEffect).toBe(true);
    expect(handler).toHaveBeenCalledWith(
      "set_default_preview_view",
      { view: "mobile" },
      expect.objectContaining({
        run: expect.objectContaining({ mode: "chat" }),
      }),
    );

    handler.mockClear();
    const invalid = await harness.executeTool(
      call("set_default_preview_view", { view: "watch" }),
    );
    expect(invalid.result).toMatchObject({ isError: true });
    expect(invalid.result.text).toContain("Invalid arguments");
    expect(handler).not.toHaveBeenCalled();
  });

  it("stamps summary-only retention on Design mutation and evidence outputs", async () => {
    const handler = vi.fn(() => ({
      text: "bounded result",
      structuredContent: { ok: true },
      content: [{ type: "text" as const, text: "bounded result" }],
    }));
    const { generator } = createGenerator(
      {
        update_design_tokens: DESIGN_HOST_TOOLS.update_design_tokens,
        capture_preview_evidence: DESIGN_HOST_TOOLS.capture_preview_evidence,
        ...DESIGN_DIAGNOSTIC_TOOLS,
      },
      handler,
    );
    const harness = generator as unknown as ToolInvoker;

    const mutation = await harness.executeTool(
      call("update_design_tokens", {
        changes: [{ token: "--accent", value: "#0f766e" }],
      }),
    );
    const evidence = await harness.executeTool(
      call("capture_preview_evidence", { viewports: ["mobile"] }),
    );
    const diagnostic = await harness.executeTool(
      call("measure_preview_layout", { viewports: ["mobile"] }),
    );

    expect(mutation.result.retention).toBe("summary-only");
    expect(evidence.result.retention).toBe("summary-only");
    expect(diagnostic.result.retention).toBe("summary-only");
    expect(diagnostic.hadSideEffect).toBe(false);
  });

  it("keeps rich evidence for the active loop and scrubs it at the run boundary", async () => {
    const imageSentinel = "run-only-image-bytes";
    const semanticSentinel = "run-only-semantic-text";
    const summary = {
      kind: "preview_evidence_v1",
      status: "complete",
      generation: "a".repeat(64),
      evidence: [],
      errors: [],
      placeholder: "run only",
    };
    const { generator } = createGenerator(
      {
        capture_preview_evidence: DESIGN_HOST_TOOLS.capture_preview_evidence,
      },
      vi.fn(() => ({
        text: JSON.stringify(summary),
        structuredContent: summary,
        content: [
          { type: "text" as const, text: semanticSentinel },
          {
            type: "image" as const,
            data: imageSentinel,
            mimeType: "image/webp",
          },
        ],
        modelOutput: {
          type: "content" as const,
          value: [{ type: "text" as const, text: semanticSentinel }],
        },
      })),
    );
    const harness = generator as unknown as GeneratorRunHarness;
    let requestCount = 0;
    let activeLoopSawRichEvidence = false;
    vi.spyOn(harness, "requestWithRetry").mockImplementation(
      async (messages) => {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            role: "assistant",
            content: null,
            tool_calls: [
              call(
                "capture_preview_evidence",
                { viewports: ["mobile"] },
                "capture-run-only",
              ),
            ],
          };
        }
        activeLoopSawRichEvidence =
          JSON.stringify(messages).includes(imageSentinel);
        return { role: "assistant", content: "Done" };
      },
    );

    const result = await generator.generate("Inspect the mobile preview");
    const persisted = result.messages.find(
      (message) =>
        message.role === "tool" && message.tool_call_id === "capture-run-only",
    );

    expect(activeLoopSawRichEvidence).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain(imageSentinel);
    expect(JSON.stringify(persisted)).not.toContain(semanticSentinel);
    expect(persisted?.toolOutput?.retention).toBeUndefined();
  });

  it("enforces a run-local write authorization hook before mutation", async () => {
    const authorizeToolCall = vi.fn((name: string) =>
      name === "write_file" ? "Design contract required." : undefined,
    );
    const { generator } = createGenerator(
      { write_file: BUILTIN_TOOLS.write_file },
      vi.fn(),
      { authorizeToolCall },
    );

    const outcome = await (generator as unknown as ToolInvoker).executeTool(
      call("write_file", { path: "src/App.tsx", content: "changed" }),
    );

    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.text).toContain("Design contract required");
    expect(generator.getFiles()).toEqual({});
    expect(authorizeToolCall).toHaveBeenCalledOnce();
    expect(outcome.hadSideEffect).toBe(false);
  });

  it("allows a registered read-only subagent before the Design contract while writes stay blocked", async () => {
    const controller = createDesignContractController();
    controller.reset({ enabled: true });
    const subagentResult = JSON.stringify({
      ok: true,
      subagent: "code-explorer",
      task: "Inspect the active entry chain.",
      status: "done",
      text: "src/main.tsx renders src/App.tsx",
      events: [],
      durationMs: 5,
    });
    const dispatchSubagent = vi.fn(async () => ({ text: subagentResult }));
    const { generator } = createGenerator(
      {
        ...DISPATCH_SUBAGENT_TOOL,
        write_file: BUILTIN_TOOLS.write_file,
      },
      vi.fn(),
      {
        dispatchSubagent,
        authorizeToolCall: (name, args) =>
          controller.authorizeProjectWrite(name, args),
      },
    );
    const harness = generator as unknown as ToolInvoker;

    const dispatched = await harness.executeTool(
      call("dispatch_subagent", {
        subagent: "code-explorer",
        task: "Inspect the active entry chain.",
      }),
    );
    const written = await harness.executeTool(
      call("write_file", {
        path: "src/App.tsx",
        content: "export default function App() { return null; }",
      }),
    );

    expect(dispatchSubagent).toHaveBeenCalledOnce();
    expect(dispatched.result.text).toBe(subagentResult);
    expect(dispatched.result.isError).not.toBe(true);
    expect(dispatched.hadSideEffect).toBe(true);
    expect(written.result).toMatchObject({ isError: true });
    expect(written.result.text).toContain("Design contract required");
    expect(written.hadSideEffect).toBe(false);
    expect(generator.getFiles()).toEqual({});
  });

  it("unlocks Design writes only after the structured contract tool succeeds", async () => {
    const controller = createDesignContractController();
    controller.reset({ enabled: true, expectedSystemId: "graphite" });
    const handler = vi.fn(
      async (name: string, args: unknown, context?: ToolExecutionContext) => {
        if (name !== "submit_design_contract" || !context) return "unknown";
        controller.submit(args, {
          expectedSystemId: "graphite",
          skillContext: context.skillContext,
        });
        return JSON.stringify({ accepted: true });
      },
    );
    const { generator } = createGenerator(
      {
        write_file: BUILTIN_TOOLS.write_file,
        ...SUBMIT_DESIGN_CONTRACT_TOOL,
      },
      handler,
      {
        authorizeToolCall: (name) => controller.authorizeProjectWrite(name),
      },
    );
    generator.getSkillContext().activate({
      id: "design-product-ui",
      name: "design-product-ui",
      description: "Product UI",
      version: "1.0.0",
      autoEnabled: true,
      source: "builtin",
      installedAt: 0,
    });
    const harness = generator as unknown as ToolInvoker;

    expect(
      (
        await harness.executeTool(
          call("write_file", { path: "src/App.tsx", content: "blocked" }),
        )
      ).result.text,
    ).toContain("Design contract required");

    const submitted = await harness.executeTool(
      call("submit_design_contract", {
        surface_mode: "operate",
        change_mode: "extend",
        target: "Settings workspace",
        audience: "Administrators",
        primary_goal: "Configure safely",
        concept: "A precise operations bench",
        system_id: "graphite",
        translation: {
          foundations: "Semantic roles",
          composition: "Clear hierarchy",
          components: "Shared controls",
        },
        preserve: ["Routes and behavior"],
        acceptance: ["Runtime Token consumption"],
      }),
    );
    expect(submitted.result.isError).not.toBe(true);

    const written = await harness.executeTool(
      call("write_file", { path: "src/App.tsx", content: "allowed" }),
    );
    expect(written.result.isError).not.toBe(true);
    expect(written.hadSideEffect).toBe(true);
    expect(generator.getFiles()["src/App.tsx"]).toBe("allowed");
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
      { custom_unknown: EMPTY_TEST_TOOL },
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
      { [alias]: EMPTY_TEST_TOOL },
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
      { [alias]: EMPTY_TEST_TOOL },
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
        [mcpAlias]: EMPTY_TEST_TOOL,
      };
    });
    const { generator } = createGenerator(
      {
        exit_plan_mode: BUILTIN_TOOLS.exit_plan_mode,
        [mcpAlias]: EMPTY_TEST_TOOL,
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

  it("discards sibling calls after interactive permission rotates authority", async () => {
    const permission = createPermissionHarness({
      decisions: [{ kind: "allow_once" }],
    });
    const { generator } = createGenerator(
      {
        delete_file: BUILTIN_TOOLS.delete_file,
        write_file: BUILTIN_TOOLS.write_file,
      },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "src/old.ts": "old" },
        projectPermissionSession: permission.session,
      },
    );
    const harness = generator as unknown as GeneratorRunHarness;
    const request = vi.spyOn(harness, "requestWithRetry");
    request
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          call("delete_file", { path: "src/old.ts" }, "approved-delete"),
          call(
            "write_file",
            { path: "src/result.ts", content: "stale" },
            "stale-sibling",
          ),
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
        ],
      })
      .mockResolvedValueOnce({ role: "assistant", content: "Done" });

    const result = await generator.generate("Replace the obsolete file");

    expect(request).toHaveBeenCalledTimes(3);
    expect(result.files).toEqual({ "src/result.ts": "fresh" });
    expect(
      result.messages.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === "stale-sibling",
      )?.content,
    ).toContain("ProjectFiles permission changed");
  });

  it("keeps a session grant across naturally completed user generations", async () => {
    const permission = createPermissionHarness({
      decisions: [{ kind: "allow_session", scope: { kind: "project" } }],
    });
    const { generator } = createGenerator(
      { delete_file: BUILTIN_TOOLS.delete_file },
      vi.fn(),
      {
        conversationId: "conversation-a",
        initialFiles: { "src/a.ts": "a", "src/b.ts": "b" },
        projectPermissionSession: permission.session,
      },
    );
    const harness = generator as unknown as GeneratorRunHarness;
    vi.spyOn(harness, "requestWithRetry")
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          call("delete_file", { path: "src/a.ts" }, "delete-a-first-run"),
        ],
      })
      .mockResolvedValueOnce({ role: "assistant", content: "First done" })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          call("delete_file", { path: "src/b.ts" }, "delete-b-second-run"),
        ],
      })
      .mockResolvedValueOnce({ role: "assistant", content: "Second done" });

    await generator.generate("Delete the first obsolete file");
    await generator.generate("Delete the second obsolete file");

    expect(permission.decide).toHaveBeenCalledOnce();
    expect(permission.session.authority().grants).toHaveLength(1);
    expect(generator.getFiles()).toEqual({});
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
        { execute_skill_script: SCRIPT_SKILL_TOOL.execute_skill_script },
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
      [toolA]: SEARCH_TOOLS.web_search,
      [toolB]: ASSET_SEARCH_TOOLS.image_search,
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
      (first.generator as unknown as ToolInvoker).executeTool(
        call(toolB, { query: "reference" }),
      ),
      (second.generator as unknown as ToolInvoker).executeTool(
        call(toolB, { query: "reference" }),
      ),
    ]);

    expect(blocked.result.text).toContain("not in the active skills");
    expect(first.handler).not.toHaveBeenCalled();
    expect(allowed.result.text).toBe("second ok");
    expect(second.handler).toHaveBeenCalledOnce();
  });
});
