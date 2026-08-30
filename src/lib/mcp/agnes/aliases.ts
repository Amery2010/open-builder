import { createMcpToolAlias } from "../alias";
import {
  AGNES_MCP_SERVER_ID,
  AGNES_TOOL_NAMES,
  type AgnesToolName,
} from "./types";

export const AGNES_TOOL_ALIASES = Object.fromEntries(
  AGNES_TOOL_NAMES.map((name) => [
    name,
    createMcpToolAlias(AGNES_MCP_SERVER_ID, name),
  ]),
) as Record<AgnesToolName, string>;

const AGNES_TOOL_BY_ALIAS = new Map(
  AGNES_TOOL_NAMES.map((name) => [AGNES_TOOL_ALIASES[name], name] as const),
);

export function agnesToolNameFromAlias(
  alias: string,
): AgnesToolName | undefined {
  return AGNES_TOOL_BY_ALIAS.get(alias);
}
