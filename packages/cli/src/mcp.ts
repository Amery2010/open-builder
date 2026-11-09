import {
  McpServer,
  type CallToolResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { listDesignSystems } from "./assets.js";
import { ProjectService } from "./project-service.js";
import { executeOperation } from "./results.js";
import { listTemplates } from "./templates.js";
import { VERSION } from "./version.js";

export interface McpOptions {
  root: string;
  allowProjectScripts?: boolean;
  signal?: AbortSignal;
}

export function createBuilderServer(
  service: ProjectService,
  options: McpOptions,
  pending: Set<Promise<unknown>> = new Set(),
): McpServer {
  const server = new McpServer(
    { name: "open-builder", version: VERSION },
    {
      instructions:
        "Open Builder initializes and checks frontend projects within its configured workspace. The host edits code and installs dependencies. Static checks do not prove build, browser, or deployment success. Design application adds files only and refuses conflicts. Verification runs trusted local project scripts only when the operator enabled it.",
    },
  );
  const path = z
    .string()
    .min(1)
    .describe("Project path relative to the configured workspace.");
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  const writes = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };

  async function call(
    operation: string,
    action: () => unknown | Promise<unknown>,
  ): Promise<CallToolResult> {
    const work = executeOperation(operation, action);
    pending.add(work);
    try {
      const { result, isError } = await work;
      const summary = result.error
        ? `${operation}: ${result.error.code}. ${result.error.message}`
        : `${operation}: ${result.ok ? "completed successfully" : "completed with findings or task failure"}. See the structured result for details.`;
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { ...result },
        isError,
      };
    } finally {
      pending.delete(work);
    }
  }

  server.registerTool(
    "builder_list_templates",
    {
      description: "List native frontend templates and their supported tasks.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => call("templates.list", listTemplates),
  );
  server.registerTool(
    "builder_list_design_systems",
    {
      description:
        "List bundled unofficial visual references and their intended use.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => call("design.list", listDesignSystems),
  );
  server.registerTool(
    "builder_init_project",
    {
      description:
        "Create a project in a new directory. Does not install dependencies or replace existing files.",
      inputSchema: z
        .object({
          path,
          template: z.enum(["react-ts", "static"]),
          design: z.enum(["linear", "stripe", "notion"]).optional(),
        })
        .strict(),
      annotations: writes,
    },
    (args) => call("init", () => service.initialize(args.path, args)),
  );
  server.registerTool(
    "builder_apply_design_system",
    {
      description:
        "Add DESIGN.md and tokens.css. Refuses existing targets; the host must wire the existing style entry.",
      inputSchema: z
        .object({ path, id: z.enum(["linear", "stripe", "notion"]) })
        .strict(),
      annotations: writes,
    },
    (args) =>
      call("design.apply", () => service.applyDesign(args.path, args.id)),
  );
  server.registerTool(
    "builder_check_project",
    {
      description:
        "Inspect source files and limited design token wiring. Does not build, render, or inspect environment secret values.",
      inputSchema: z.object({ path }).strict(),
      annotations: readOnly,
    },
    (args) => call("check", () => service.check(args.path)),
  );
  if (options.allowProjectScripts) {
    server.registerTool(
      "builder_verify_project",
      {
        description:
          "Execute a trusted project's build, typecheck, lint, or test script. No dependency installation. Default timeout: 300 seconds.",
        inputSchema: z
          .object({
            path,
            task: z.enum(["build", "typecheck", "lint", "test"]),
            packageManager: z.enum(["npm", "pnpm"]).optional(),
            timeoutMs: z
              .number()
              .int()
              .positive()
              .max(2_147_483_647)
              .optional(),
          })
          .strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
      },
      (args, ctx: ServerContext) =>
        call("verify", () => {
          const token = ctx.mcpReq._meta?.progressToken;
          let progress = 0;
          return service.verify(args.path, {
            ...args,
            signal: options.signal
              ? AbortSignal.any([options.signal, ctx.mcpReq.signal])
              : ctx.mcpReq.signal,
            onProgress: () => {
              if (token === undefined) return;
              void ctx.mcpReq
                .notify({
                  method: "notifications/progress",
                  params: {
                    progressToken: token,
                    progress: ++progress,
                    message: "Project script is running.",
                  },
                })
                .catch(() => undefined);
            },
          });
        }),
    );
  }
  return server;
}

export async function runMcp(options: McpOptions): Promise<void> {
  const service = new ProjectService({ root: options.root });
  await service.ready();
  const shutdown = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([shutdown.signal, options.signal])
    : shutdown.signal;
  const pending = new Set<Promise<unknown>>();
  const handle = serveStdio(
    () => createBuilderServer(service, { ...options, signal }, pending),
    {
      onerror: (error) => process.stderr.write(`MCP: ${error.message}\n`),
    },
  );
  try {
    await new Promise<void>((resolve) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        process.stdin.off("end", done);
        process.stdin.off("close", done);
        process.stdout.off("error", done);
        signal.removeEventListener("abort", done);
      };
      process.stdin.once("end", done);
      process.stdin.once("close", done);
      process.stdout.once("error", done);
      signal.addEventListener("abort", done, { once: true });
      if (
        signal.aborted ||
        process.stdin.readableEnded ||
        process.stdin.destroyed
      )
        done();
    });
  } finally {
    shutdown.abort();
    await handle.close();
    await Promise.allSettled([...pending]);
  }
}
