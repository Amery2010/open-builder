import type {
  ExecutionMode,
  RuntimePlatform,
  ToolSource,
} from "../ai/tools-schema";
import type {
  ProjectPermissionOperation,
  ProjectPermissionScope,
} from "./project-permission-broker";
import { PROJECT_FILE_LIMITS } from "../utils/project-files";

const STORAGE_KEY = "open-builder-permission-activity";
const MAX_ENTRIES = 200;
const MAX_TEXT_CHARS = 240;
const MAX_AUDIT_PATHS = PROJECT_FILE_LIMITS.maxFiles * 2;

export interface PermissionActivityMcpMetadata {
  serverId?: string;
  serverName?: string;
  toolTitle?: string;
}

export interface PermissionActivityEntry {
  id: string;
  at: number;
  version?: 2;
  conversationId?: string;
  tool: string;
  source: ToolSource | "unknown";
  mode: ExecutionMode;
  platform: RuntimePlatform;
  decision:
    | "allowed"
    | "denied"
    | "requested"
    | "allowed_once"
    | "allowed_session"
    | "cancelled"
    | "revoked"
    | "execution_started"
    | "succeeded"
    | "failed"
    | "bypassed";
  target?: string;
  reason?: string;
  mcp?: PermissionActivityMcpMetadata;
  requestId?: string;
  sessionId?: string;
  hostRunId?: string;
  callId?: string;
  runtime?: "api" | "local_cli";
  operation?: ProjectPermissionOperation;
  scope?: ProjectPermissionScope;
  affectedPaths?: readonly string[];
  affectedCount?: number;
  authorityRevisionBefore?: number;
  authorityRevisionAfter?: number;
  outcome?: string;
}

export type PermissionActivityInput = Omit<
  PermissionActivityEntry,
  "id" | "at"
>;

export class PermissionActivityStorageError extends Error {
  constructor(message = "Permission audit storage is unavailable.") {
    super(message);
    this.name = "PermissionActivityStorageError";
  }
}

const subscribers = new Set<() => void>();

function safeText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:token|key|secret|password)=)[^&#\s]*/gi, "$1[REDACTED]")
    .slice(0, MAX_TEXT_CHARS);
}

function safeTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return safeText(value);
  }
}

function safeScope(
  value: ProjectPermissionScope | undefined,
): ProjectPermissionScope | undefined {
  if (!value) return undefined;
  if (value.kind === "project") return Object.freeze({ kind: "project" });
  if (value.kind === "subtree") {
    const path = safeText(value.path);
    return path ? Object.freeze({ kind: "subtree", path }) : undefined;
  }
  const paths = value.paths
    .slice(0, MAX_AUDIT_PATHS)
    .map((path) => safeText(path))
    .filter((path): path is string => Boolean(path));
  return Object.freeze({ kind: "exact", paths: Object.freeze(paths) });
}

function sanitizeEntry(
  input: PermissionActivityInput,
): PermissionActivityEntry {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    at: Date.now(),
    ...(input.version === 2 ? { version: 2 as const } : {}),
    conversationId: safeText(input.conversationId),
    tool: safeText(input.tool) ?? "unknown",
    source: input.source,
    mode: input.mode,
    platform: input.platform,
    decision: input.decision,
    target: safeTarget(input.target),
    reason: safeText(input.reason),
    requestId: safeText(input.requestId),
    sessionId: safeText(input.sessionId),
    hostRunId: safeText(input.hostRunId),
    callId: safeText(input.callId),
    runtime: input.runtime,
    operation: input.operation,
    outcome: safeText(input.outcome),
    scope: safeScope(input.scope),
    affectedPaths: input.affectedPaths
      ?.slice(0, MAX_AUDIT_PATHS)
      .map((path) => safeText(path))
      .filter((path): path is string => Boolean(path)),
    affectedCount:
      typeof input.affectedCount === "number" &&
      Number.isSafeInteger(input.affectedCount) &&
      input.affectedCount >= 0
        ? input.affectedCount
        : undefined,
    authorityRevisionBefore: input.authorityRevisionBefore,
    authorityRevisionAfter: input.authorityRevisionAfter,
    mcp: input.mcp
      ? {
          serverId: safeText(input.mcp.serverId),
          serverName: safeText(input.mcp.serverName),
          toolTitle: safeText(input.mcp.toolTitle),
        }
      : undefined,
  };
}

function persistEntries(entries: readonly PermissionActivityEntry[]): void {
  if (
    typeof localStorage === "undefined" ||
    typeof localStorage.setItem !== "function"
  ) {
    throw new PermissionActivityStorageError();
  }
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.slice(-MAX_ENTRIES)),
    );
  } catch (error) {
    throw new PermissionActivityStorageError(
      error instanceof Error ? error.message : undefined,
    );
  }
  notifySubscribers();
}

export function getPermissionActivity(
  conversationId?: string,
): PermissionActivityEntry[] {
  if (
    typeof localStorage === "undefined" ||
    typeof localStorage.getItem !== "function"
  ) {
    return [];
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.slice(-MAX_ENTRIES) as PermissionActivityEntry[];
    return conversationId
      ? entries.filter((entry) => entry.conversationId === conversationId)
      : entries;
  } catch {
    return [];
  }
}

function readPermissionActivityStrict(): PermissionActivityEntry[] {
  if (
    typeof localStorage === "undefined" ||
    typeof localStorage.getItem !== "function"
  ) {
    throw new PermissionActivityStorageError();
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) {
      throw new Error("Permission audit data is invalid.");
    }
    return parsed.slice(-MAX_ENTRIES) as PermissionActivityEntry[];
  } catch (error) {
    throw new PermissionActivityStorageError(
      error instanceof Error ? error.message : undefined,
    );
  }
}

export function subscribePermissionActivity(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function notifySubscribers(): void {
  for (const listener of subscribers) listener();
}

export function recordPermissionActivity(input: PermissionActivityInput): void {
  try {
    recordPermissionActivityStrict(input);
  } catch {
    // Permission logging is best-effort and must never block a tool decision.
  }
}

/** Durable audit write used by the Project Permission Broker. Unlike the
 * legacy helper above, failure is observable so approval can fail closed. */
export function recordPermissionActivityStrict(
  input: PermissionActivityInput,
): PermissionActivityEntry {
  const entry = sanitizeEntry(input);
  persistEntries([...readPermissionActivityStrict(), entry]);
  return entry;
}

export function updatePermissionActivityStrict(
  id: string,
  patch: Partial<
    Pick<
      PermissionActivityEntry,
      | "decision"
      | "outcome"
      | "reason"
      | "authorityRevisionBefore"
      | "authorityRevisionAfter"
      | "scope"
    >
  >,
): PermissionActivityEntry {
  const entries = readPermissionActivityStrict();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) {
    throw new PermissionActivityStorageError(
      "Permission audit entry is unavailable.",
    );
  }
  const current = entries[index];
  const next = {
    ...current,
    ...(patch.decision ? { decision: patch.decision } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "reason")
      ? { reason: safeText(patch.reason) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "outcome")
      ? { outcome: safeText(patch.outcome) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "scope")
      ? { scope: safeScope(patch.scope) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "authorityRevisionBefore")
      ? { authorityRevisionBefore: patch.authorityRevisionBefore }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "authorityRevisionAfter")
      ? { authorityRevisionAfter: patch.authorityRevisionAfter }
      : {}),
  };
  entries[index] = next;
  persistEntries(entries);
  return next;
}

export function clearPermissionActivity(): void {
  if (
    typeof localStorage !== "undefined" &&
    typeof localStorage.removeItem === "function"
  ) {
    localStorage.removeItem(STORAGE_KEY);
    notifySubscribers();
  }
}
