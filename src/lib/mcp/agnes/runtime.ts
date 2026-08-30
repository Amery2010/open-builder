import { TOOL_POLICY_VERSION } from "../../ai/tool-policy-version";
import { useMcpStore } from "../../../store/mcp";
import { buildMcpRuntimeBundle, type McpRuntimeBundle } from "../runtime";
import type {
  McpServerEntry,
  McpServerRuntimeState,
  McpToolApproval,
} from "../types";
import { MCP_LIMITS } from "../limits";
import { getAgnesMcpService } from "./service";
import { AGNES_TOOL_ALIASES } from "./aliases";
import {
  AGNES_API_ORIGIN,
  AGNES_MCP_DEFINITION_VERSION,
  AGNES_MCP_SERVER_ID,
  AGNES_MCP_SERVER_NAME,
  AGNES_TOOL_DEFINITIONS,
  AGNES_TOOL_NAMES,
} from "./types";

function syntheticAgnesServer(): {
  server: McpServerEntry;
  runtime: McpServerRuntimeState;
} {
  const settings = useMcpStore.getState().agnes;
  const tools = Object.fromEntries(
    AGNES_TOOL_NAMES.map((name) => {
      const definition = AGNES_TOOL_DEFINITIONS[name];
      const approval = settings.tools[name];
      return [
        name,
        {
          ...definition,
          fingerprint: `agnes-v${AGNES_MCP_DEFINITION_VERSION}-${name}`,
          enabled: approval.enabled,
          allowInPlanMode: false,
          allowForSubagents:
            name === "generate_image" && approval.allowForSubagents,
          ...(name === "generate_image" && approval.allowForSubagents
            ? { elevatedPermissionsPolicyVersion: TOOL_POLICY_VERSION }
            : {}),
        } satisfies McpToolApproval,
      ];
    }),
  ) as Record<string, McpToolApproval>;
  const connected = Boolean(settings.enabled && settings.apiKey.trim());
  const fingerprint = `agnes-v${AGNES_MCP_DEFINITION_VERSION}`;
  const server: McpServerEntry = {
    id: AGNES_MCP_SERVER_ID,
    name: AGNES_MCP_SERVER_NAME,
    enabled: connected,
    // This synthetic entry is never persisted or connected as remote MCP. It
    // only lets the managed adapter reuse the existing approved-runtime path.
    transport: "streamable-http",
    url: AGNES_API_ORIGIN,
    requestTimeoutMs: 5 * 60 * 1_000,
    tools,
    createdAt: 0,
    updatedAt: settings.updatedAt,
    approvedAt: 0,
    definitionFingerprint: fingerprint,
  };
  return {
    server,
    runtime: {
      status: connected ? "ready" : "idle",
      tools: AGNES_TOOL_NAMES.map((name) => AGNES_TOOL_DEFINITIONS[name]),
      drift: {
        status: "clean",
        added: [],
        removed: [],
        changed: [],
        instructionsChanged: false,
        approvedFingerprint: fingerprint,
        currentFingerprint: fingerprint,
      },
      updatedAt: settings.updatedAt,
    },
  };
}

export async function buildAgnesMcpRuntimeBundle(
  globalEnabled: boolean,
): Promise<McpRuntimeBundle> {
  const currentGlobalEnabled =
    globalEnabled && useMcpStore.getState().globalEnabled;
  const { server, runtime } = syntheticAgnesServer();
  const bundle = await buildMcpRuntimeBundle({
    globalEnabled: currentGlobalEnabled,
    servers: { [server.id]: server },
    runtime: { [server.id]: runtime },
    caller: getAgnesMcpService(),
  });
  const imageApproval = useMcpStore.getState().agnes.tools.generate_image;
  if (
    currentGlobalEnabled &&
    server.enabled &&
    imageApproval.enabled &&
    imageApproval.allowForSubagents &&
    imageApproval.subagentPolicyVersion === TOOL_POLICY_VERSION &&
    bundle.aliases.has(AGNES_TOOL_ALIASES.generate_image)
  ) {
    // The runtime handler closes over this exact Set. Mutating only the
    // managed bundle avoids widening the generic external-MCP policy.
    bundle.subagentToolNames.add(AGNES_TOOL_ALIASES.generate_image);
  }
  return bundle;
}

export function mergeMcpRuntimeBundles(
  external: McpRuntimeBundle,
  managed: McpRuntimeBundle,
): McpRuntimeBundle {
  const totalTools =
    Object.keys(external.tools).length + Object.keys(managed.tools).length;
  if (totalTools > MCP_LIMITS.maxEnabledTools) {
    throw new Error(
      `At most ${MCP_LIMITS.maxEnabledTools} MCP tools may be enabled; received ${totalTools}.`,
    );
  }
  const aliases = new Map(external.aliases);
  for (const [alias, target] of managed.aliases) {
    if (aliases.has(alias)) throw new Error(`Duplicate MCP alias "${alias}".`);
    aliases.set(alias, target);
  }
  return {
    tools: { ...external.tools, ...managed.tools },
    planModeToolNames: new Set([
      ...external.planModeToolNames,
      ...managed.planModeToolNames,
    ]),
    subagentToolNames: new Set([
      ...external.subagentToolNames,
      ...managed.subagentToolNames,
    ]),
    aliases,
    instructions: [external.instructions, managed.instructions]
      .filter(Boolean)
      .join("\n\n"),
    warnings: [...external.warnings, ...managed.warnings],
    handler: (name, args, context) =>
      managed.aliases.has(name)
        ? managed.handler(name, args, context)
        : external.handler(name, args, context),
  };
}
