import type { RuntimePlatform } from "../ai/tools-schema";
import { TOOL_POLICY_VERSION } from "../ai/tool-policy-version";
import { projectPermissionDecisionAdapter } from "../../store/project-permission";
import {
  recordPermissionActivityStrict,
  updatePermissionActivityStrict,
  type PermissionActivityEntry,
  type PermissionActivityInput,
} from "./activity-log";
import {
  createProjectPermissionBroker,
  type ProjectPermissionAuditEvent,
  type ProjectPermissionRuntime,
  type ProjectPermissionSession,
} from "./project-permission-broker";

function requestAuditBase(
  event: Extract<ProjectPermissionAuditEvent, { request: unknown }>,
  platform: RuntimePlatform,
): Omit<PermissionActivityInput, "decision"> {
  const { request } = event;
  return {
    version: 2,
    conversationId: request.conversationId,
    requestId: request.requestId,
    sessionId: request.sessionId,
    hostRunId: request.runId,
    callId: request.callId,
    runtime: request.runtime,
    tool: request.tool,
    source: "project",
    mode: "chat",
    platform,
    operation: request.operation,
    scope: request.scope,
    affectedPaths: request.affectedPaths,
    affectedCount: request.affectedCount,
  };
}

function recordBrokerAudit(
  event: ProjectPermissionAuditEvent,
  platform: RuntimePlatform,
  runtime: ProjectPermissionRuntime,
  requestEntries: Map<string, string>,
): void {
  if (event.type === "authority_changed") {
    if (event.reason === "project_revision") return;
    recordPermissionActivityStrict({
      version: 2,
      conversationId: event.conversationId,
      sessionId: event.sessionId,
      runtime,
      tool: "project_permission_authority",
      source: "project",
      mode: "chat",
      platform,
      decision:
        event.reason === "grant_revoked" ||
        event.reason === "session_revoked" ||
        event.reason === "session_closed"
          ? "revoked"
          : "allowed",
      authorityRevisionBefore: event.authorityRevisionBefore,
      authorityRevisionAfter: event.authorityRevisionAfter,
      outcome: event.reason,
    });
    return;
  }

  const base = requestAuditBase(event, platform);
  const createRequestEntry = (
    decision: PermissionActivityEntry["decision"],
    extra: Partial<PermissionActivityInput> = {},
  ) => {
    const entry = recordPermissionActivityStrict({
      ...base,
      ...extra,
      decision,
    });
    requestEntries.set(event.request.requestId, entry.id);
  };
  const updateRequestEntry = (
    patch: Parameters<typeof updatePermissionActivityStrict>[1],
  ) => {
    const entryId = requestEntries.get(event.request.requestId);
    if (!entryId) {
      throw new Error("Permission request audit entry is unavailable.");
    }
    updatePermissionActivityStrict(entryId, patch);
  };
  if (event.type === "requested") {
    createRequestEntry("requested", {
      authorityRevisionBefore: event.authorityRevision,
    });
    return;
  }
  if (event.type === "approved") {
    updateRequestEntry({
      decision:
        event.decision === "allow_session" ? "allowed_session" : "allowed_once",
      scope: event.grantedScope,
      authorityRevisionBefore: event.authorityRevisionBefore,
      authorityRevisionAfter: event.authorityRevisionAfter,
    });
    return;
  }
  if (event.type === "denied") {
    const patch = {
      decision: "denied" as const,
      reason: event.reason,
      outcome: "denied",
      authorityRevisionBefore: event.authorityRevision,
    };
    try {
      if (requestEntries.has(event.request.requestId)) {
        updateRequestEntry(patch);
      } else {
        createRequestEntry("denied", patch);
      }
    } finally {
      requestEntries.delete(event.request.requestId);
    }
    return;
  }
  if (event.type === "cancelled") {
    const patch = {
      decision: "cancelled" as const,
      reason: event.reason,
      outcome: event.reason,
      authorityRevisionBefore: event.authorityRevision,
    };
    try {
      if (requestEntries.has(event.request.requestId)) {
        updateRequestEntry(patch);
      } else {
        createRequestEntry("cancelled", patch);
      }
    } finally {
      requestEntries.delete(event.request.requestId);
    }
    return;
  }
  if (event.type === "bypassed") {
    const decision =
      event.reason === "session_grant" ? "allowed_session" : "bypassed";
    createRequestEntry(decision, {
      reason: event.reason,
      outcome: event.reason === "broker_disabled" ? "bypassed" : undefined,
      authorityRevisionBefore: event.authorityRevision,
    });
    if (event.reason === "broker_disabled") {
      requestEntries.delete(event.request.requestId);
    }
    return;
  }
  if (event.type === "execution_started") {
    const patch = {
      outcome: "execution_started",
      authorityRevisionBefore: event.authorityRevision,
    };
    if (requestEntries.has(event.request.requestId)) {
      updateRequestEntry(patch);
    } else {
      createRequestEntry(
        event.lifetime === "session" ? "allowed_session" : "allowed_once",
        patch,
      );
    }
    return;
  }
  try {
    updateRequestEntry({
      reason: event.errorCode,
      authorityRevisionAfter: event.authorityRevision,
      outcome: event.outcome,
    });
  } finally {
    requestEntries.delete(event.request.requestId);
  }
}

export function createHostProjectPermissionSession(input: {
  conversationId: string;
  platform: RuntimePlatform;
  runtime: ProjectPermissionRuntime;
  bypassEnabled: boolean;
}): ProjectPermissionSession {
  const requestEntries = new Map<string, string>();
  return createProjectPermissionBroker({
    decision: projectPermissionDecisionAdapter,
    audit: {
      record: (event) =>
        recordBrokerAudit(event, input.platform, input.runtime, requestEntries),
    },
  }).openSession({
    conversationId: input.conversationId,
    policyVersion: TOOL_POLICY_VERSION,
    projectRevision: 0,
    bypassEnabled: input.bypassEnabled,
  });
}
