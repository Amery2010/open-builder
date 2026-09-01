import { jsonSchema, type ToolSet } from "ai";
import type {
  ToolExecutionContext,
  ToolExecutionOutput,
} from "../ai/generator-types";
import { TOOL_POLICY_VERSION } from "../ai/tool-policy-version";
import { buildApprovedMcpInstructions, selectAvailableMcpTools } from "./index";
import { compileMcpToolInputValidator } from "./tool-input-validator";
import type {
  McpServerEntry,
  McpServerRuntimeState,
  McpToolAnnotations,
} from "./types";

export interface McpToolCaller {
  callTool(
    serverId: string,
    toolName: string,
    args: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionOutput>;
}

export interface McpRuntimeBundle {
  tools: ToolSet;
  planModeToolNames: Set<string>;
  subagentToolNames: Set<string>;
  aliases: Map<string, { serverId: string; toolName: string }>;
  /** The annotations belonging to each exposed alias. Kept beside aliases so
   * local CLI adapters can project the same Host capability snapshot. */
  annotations: Map<string, McpToolAnnotations>;
  instructions: string;
  warnings: string[];
  handler: (
    name: string,
    args: unknown,
    context?: ToolExecutionContext,
  ) => Promise<ToolExecutionOutput>;
}

export interface BuildMcpRuntimeOptions {
  globalEnabled: boolean;
  servers: Record<string, McpServerEntry>;
  runtime: Record<string, McpServerRuntimeState>;
  caller: McpToolCaller;
}

export async function buildMcpRuntimeBundle(
  options: BuildMcpRuntimeOptions,
): Promise<McpRuntimeBundle> {
  const aliases = new Map<string, { serverId: string; toolName: string }>();
  const annotations = new Map<string, McpToolAnnotations>();
  const planModeToolNames = new Set<string>();
  const subagentToolNames = new Set<string>();
  const tools: ToolSet = {};
  const warnings: string[] = [];
  const available = selectAvailableMcpTools(options.servers, options.runtime, {
    globalEnabled: options.globalEnabled,
    mode: "chat",
  });
  for (const selected of available) {
    try {
      const validate = await compileMcpToolInputValidator(
        selected.definition.inputSchema,
      );
      aliases.set(selected.alias, {
        serverId: selected.serverId,
        toolName: selected.toolName,
      });
      if (selected.definition.annotations) {
        annotations.set(selected.alias, {
          ...selected.definition.annotations,
        });
      }
      tools[selected.alias] = {
        description:
          `[MCP: ${selected.serverName} / ${selected.definition.title || selected.toolName}] ` +
          (selected.definition.description ||
            "No description supplied by the server."),
        inputSchema: jsonSchema(selected.definition.inputSchema as never, {
          validate,
        }),
      };
    } catch (error) {
      warnings.push(
        `${selected.serverName} / ${selected.toolName}: input schema is unsupported (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  for (const selected of selectAvailableMcpTools(
    options.servers,
    options.runtime,
    { globalEnabled: options.globalEnabled, mode: "plan" },
  )) {
    if (aliases.has(selected.alias)) planModeToolNames.add(selected.alias);
  }
  for (const selected of selectAvailableMcpTools(
    options.servers,
    options.runtime,
    { globalEnabled: options.globalEnabled, mode: "subagent" },
  )) {
    if (aliases.has(selected.alias)) subagentToolNames.add(selected.alias);
  }
  for (const server of Object.values(options.servers)) {
    const state = options.runtime[server.id];
    if (server.enabled && state?.status === "error" && state.error) {
      warnings.push(`${server.name}: ${state.error}`);
    }
  }

  return {
    tools,
    planModeToolNames,
    subagentToolNames,
    aliases,
    annotations,
    instructions: buildApprovedMcpInstructions(
      options.servers,
      options.runtime,
      options.globalEnabled,
    ),
    warnings,
    handler: async (name, args, context) => {
      if (!context) {
        return {
          text: `Error: MCP tool alias "${name}" is not authorized without a tool execution context.`,
          isError: true,
        };
      }
      const allowedByMode =
        context.run.mode === "chat"
          ? aliases.has(name)
          : context.run.mode === "plan"
            ? planModeToolNames.has(name)
            : context.run.mode === "subagent"
              ? subagentToolNames.has(name)
              : false;
      if (
        context.run.policyVersion !== TOOL_POLICY_VERSION ||
        !context.run.allowedMcpAliases.has(name) ||
        !allowedByMode
      ) {
        return {
          text:
            `Error: MCP tool alias "${name}" is not authorized for ` +
            `the current ${context.run.mode} run.`,
          isError: true,
        };
      }
      const target = aliases.get(name);
      if (!target) {
        return {
          text: `Error: MCP tool alias "${name}" is unavailable or no longer approved.`,
          isError: true,
        };
      }
      return options.caller.callTool(
        target.serverId,
        target.toolName,
        args,
        context,
      );
    },
  };
}
