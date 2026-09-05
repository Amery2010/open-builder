import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectPermissionAuthoritySnapshot,
  ProjectPermissionRequest,
  ProjectPermissionSession,
} from "../lib/security/project-permission-broker";
import {
  projectPermissionDecisionAdapter,
  publishProjectPermissionAuthority,
  registerProjectPermissionSession,
  revokeProjectPermissionGrant,
  useProjectPermissionStore,
} from "./project-permission";

function request(
  overrides: Partial<ProjectPermissionRequest> = {},
): ProjectPermissionRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    conversationId: "conversation-1",
    runId: "run-1",
    callId: "call-1",
    tool: "delete_file",
    runtime: "api",
    operation: "delete",
    sessionEligible: true,
    scope: { kind: "exact", paths: ["src/a.ts", "src/b.ts"] },
    affectedPaths: ["src/a.ts", "src/b.ts"],
    affectedCount: 2,
    projectRevision: 1,
    authorityId: "authority-1",
    requirementDigest: "digest",
    ...overrides,
  };
}

function authority(revision = 0): ProjectPermissionAuthoritySnapshot {
  return {
    id: `authority-${revision}`,
    digest: `digest-${revision}`,
    revision,
    sessionId: "session-1",
    conversationId: "conversation-1",
    policyVersion: "test",
    projectRevision: 1,
    bypassEnabled: false,
    closed: false,
    grants:
      revision === 0
        ? []
        : [
            {
              id: "grant-1",
              operation: "delete",
              scope: { kind: "exact", paths: ["src/a.ts"] },
            },
          ],
  };
}

describe("project permission UI store", () => {
  beforeEach(() => {
    useProjectPermissionStore.setState({ pending: null, authorities: {} });
  });

  it("presents one request and resolves the selected session scope", async () => {
    const decision = projectPermissionDecisionAdapter.decide(
      request(),
      new AbortController().signal,
    );
    expect(useProjectPermissionStore.getState().pending?.commonParent).toBe(
      "src",
    );

    useProjectPermissionStore.getState().submitDecision("request-1", {
      kind: "allow_session",
      scope: { kind: "subtree", path: "src" },
    });

    await expect(decision).resolves.toEqual({
      kind: "allow_session",
      scope: { kind: "subtree", path: "src" },
    });
    expect(useProjectPermissionStore.getState().pending?.submitting).toBe(true);
    useProjectPermissionStore.getState().finishRequest("call-1");
    expect(useProjectPermissionStore.getState().pending).toBeNull();
  });

  it("cancels and discards late UI decisions", async () => {
    const controller = new AbortController();
    const decision = projectPermissionDecisionAdapter.decide(
      request(),
      controller.signal,
    );
    controller.abort();
    await expect(decision).rejects.toMatchObject({ name: "AbortError" });
    expect(useProjectPermissionStore.getState().pending).toBeNull();
    useProjectPermissionStore.getState().submitDecision("request-1", {
      kind: "allow_once",
    });
  });

  it("keeps a submitted audit error visible until the user closes it", async () => {
    const decision = projectPermissionDecisionAdapter.decide(
      request(),
      new AbortController().signal,
    );
    useProjectPermissionStore.getState().submitDecision("request-1", {
      kind: "allow_once",
    });
    await expect(decision).resolves.toEqual({ kind: "allow_once" });

    useProjectPermissionStore
      .getState()
      .finishRequest("call-1", "Audit storage is unavailable.");
    expect(useProjectPermissionStore.getState().pending).toMatchObject({
      submitting: false,
      error: "Audit storage is unavailable.",
    });

    useProjectPermissionStore.getState().submitDecision("request-1", {
      kind: "deny",
    });
    expect(useProjectPermissionStore.getState().pending).toBeNull();
  });

  it("publishes and revokes an active grant while rotating Host authority", () => {
    let current = authority(1);
    const change = vi.fn((input: { type: string; grantId?: string }) => {
      if (input.type === "revoke_grant" && input.grantId === "grant-1") {
        current = authority(2);
        current = { ...current, grants: [] };
      }
    });
    const session = {
      authority: () => current,
      change,
      authorize: vi.fn(),
      settle: vi.fn(),
    } as unknown as ProjectPermissionSession;
    const rotate = vi.fn();
    registerProjectPermissionSession("conversation-1", session, rotate);

    expect(
      useProjectPermissionStore.getState().authorities["conversation-1"].grants,
    ).toHaveLength(1);
    expect(revokeProjectPermissionGrant("conversation-1", "grant-1")).toBe(
      true,
    );
    expect(rotate).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith({
      type: "revoke_grant",
      grantId: "grant-1",
    });
  });

  it("removes a closed session authority", () => {
    const closed = { ...authority(1), closed: true, grants: [] };
    const session = {
      authority: () => closed,
      change: vi.fn(),
      authorize: vi.fn(),
      settle: vi.fn(),
    } as unknown as ProjectPermissionSession;
    publishProjectPermissionAuthority("conversation-1", session);
    expect(
      useProjectPermissionStore.getState().authorities["conversation-1"],
    ).toBeUndefined();
  });

  it("ignores a late closed snapshot from a replaced session", () => {
    let oldAuthority = {
      ...authority(1),
      id: "old-authority",
      sessionId: "old-session",
    };
    const oldSession = {
      authority: () => oldAuthority,
      change: vi.fn((change: { type: string }) => {
        if (change.type === "close") {
          oldAuthority = { ...oldAuthority, closed: true, grants: [] };
        }
      }),
      authorize: vi.fn(),
      settle: vi.fn(),
    } as unknown as ProjectPermissionSession;
    const newAuthority = {
      ...authority(2),
      id: "new-authority",
      sessionId: "new-session",
    };
    const newSession = {
      authority: () => newAuthority,
      change: vi.fn(),
      authorize: vi.fn(),
      settle: vi.fn(),
    } as unknown as ProjectPermissionSession;

    registerProjectPermissionSession("race-conversation", oldSession, vi.fn());
    registerProjectPermissionSession("race-conversation", newSession, vi.fn());
    publishProjectPermissionAuthority("race-conversation", oldSession);

    expect(
      useProjectPermissionStore.getState().authorities["race-conversation"],
    ).toBe(newAuthority);
  });
});
