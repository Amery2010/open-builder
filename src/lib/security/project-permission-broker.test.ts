import { describe, expect, it, vi } from "vitest";

import {
  createProjectPermissionBroker,
  projectPermissionScopeCovers,
  type ProjectPermissionAuditAdapter,
  type ProjectPermissionAuditEvent,
  type ProjectPermissionDecision,
  type ProjectPermissionDecisionAdapter,
  type ProjectPermissionSession,
} from "./project-permission-broker";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function harness(input?: {
  decisions?: ProjectPermissionDecision[];
  decision?: ProjectPermissionDecisionAdapter;
  audit?: ProjectPermissionAuditAdapter;
  bypassEnabled?: boolean;
}) {
  let id = 0;
  const events: ProjectPermissionAuditEvent[] = [];
  const decisions = [...(input?.decisions ?? [])];
  const decision: ProjectPermissionDecisionAdapter = input?.decision ?? {
    decide: vi.fn(
      (): ProjectPermissionDecision => decisions.shift() ?? { kind: "deny" },
    ),
  };
  const audit =
    input?.audit ??
    ({
      record: vi.fn((event: ProjectPermissionAuditEvent) => {
        events.push(event);
      }),
    } satisfies ProjectPermissionAuditAdapter);
  const session = createProjectPermissionBroker({
    decision,
    audit,
    createId: () => `id-${++id}`,
    now: () => 1000 + id,
  }).openSession({
    conversationId: "conversation-a",
    policyVersion: "test-policy",
    projectRevision: 1,
    bypassEnabled: input?.bypassEnabled ?? false,
  });
  return { session, decision, audit, events };
}

function request(
  operation: "delete" | "move" | "replace_project" = "delete",
  overrides: Partial<Parameters<ProjectPermissionSession["authorize"]>[0]> = {},
) {
  return {
    runId: "run-1",
    callId: "call-1",
    tool: "delete_file",
    runtime: "api" as const,
    operation,
    sessionEligible: operation !== "replace_project",
    scope: { kind: "exact" as const, paths: ["src/App.tsx"] },
    affectedPaths: ["src/App.tsx"],
    affectedCount: 1,
    projectRevision: 1,
    authorityId: "stale-unless-overridden",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function authorizedRequest(
  session: ProjectPermissionSession,
  operation: "delete" | "move" | "replace_project" = "delete",
  overrides: Partial<Parameters<ProjectPermissionSession["authorize"]>[0]> = {},
) {
  return request(operation, {
    authorityId: session.authority().id,
    ...overrides,
  });
}

describe("Project Permission Broker", () => {
  it("issues a call- and revision-bound once permit without a session grant", async () => {
    const { session, decision, events } = harness({
      decisions: [{ kind: "allow_once" }, { kind: "allow_once" }],
    });
    const initial = session.authority();
    const permit = await session.authorize(authorizedRequest(session));

    expect(permit).toMatchObject({
      callId: "call-1",
      projectRevision: 1,
      lifetime: "once",
    });
    expect(permit.grantIds).toHaveLength(1);
    expect(permit.requirementDigest).toHaveLength(64);
    expect(session.authority()).not.toBe(initial);
    expect(session.authority().grants).toEqual([]);
    expect(Object.isFrozen(session.authority())).toBe(true);
    expect(Object.isFrozen(permit)).toBe(true);

    const next = await session.authorize(
      authorizedRequest(session, "delete", { callId: "call-2" }),
    );
    expect(next.requirementDigest).toBe(permit.requirementDigest);
    expect(next.callId).not.toBe(permit.callId);
    expect(decision.decide).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toContain("execution_started");
    const approved = events.find((event) => event.type === "approved");
    expect(approved).toMatchObject({
      authorityRevisionBefore: 0,
      authorityRevisionAfter: 1,
    });
  });

  it("honors a UI-selected broader session scope for only the same operation", async () => {
    const { session, decision, events } = harness({
      decisions: [
        { kind: "allow_session", scope: { kind: "subtree", path: "src" } },
        { kind: "allow_once" },
      ],
    });
    await session.authorize(authorizedRequest(session));
    const granted = session.authority();
    const covered = await session.authorize(
      authorizedRequest(session, "delete", {
        callId: "call-2",
        scope: { kind: "exact", paths: ["src/nested/Other.tsx"] },
        affectedPaths: ["src/nested/Other.tsx"],
      }),
    );
    expect(covered.lifetime).toBe("session");
    expect(decision.decide).toHaveBeenCalledTimes(1);
    expect(
      events.some(
        (event) =>
          event.type === "bypassed" && event.reason === "session_grant",
      ),
    ).toBe(true);
    expect(session.authority()).toBe(granted);

    await session.authorize(
      authorizedRequest(session, "move", {
        callId: "call-3",
        tool: "move_file",
      }),
    );
    expect(decision.decide).toHaveBeenCalledTimes(2);
  });

  it("matches exact sets and subtrees by path segment", () => {
    expect(
      projectPermissionScopeCovers(
        { kind: "exact", paths: ["a.ts", "b.ts"] },
        { kind: "exact", paths: ["b.ts"] },
      ),
    ).toBe(true);
    expect(
      projectPermissionScopeCovers(
        { kind: "subtree", path: "src/app" },
        { kind: "exact", paths: ["src/app/file.ts"] },
      ),
    ).toBe(true);
    expect(
      projectPermissionScopeCovers(
        { kind: "subtree", path: "src/app" },
        { kind: "exact", paths: ["src/application/file.ts"] },
      ),
    ).toBe(false);
  });

  it("normalizes exact paths and rejects traversal", async () => {
    const { session, decision } = harness({
      decisions: [{ kind: "allow_once" }],
    });
    await session.authorize(
      authorizedRequest(session, "move", {
        scope: {
          kind: "exact",
          paths: ["src//feature/file.ts", "src/feature/file.ts"],
        },
        affectedPaths: ["src/feature/file.ts"],
        affectedCount: 1,
      }),
    );
    expect(vi.mocked(decision.decide).mock.calls[0]![0].scope).toEqual({
      kind: "exact",
      paths: ["src/feature/file.ts"],
    });

    await expect(
      session.authorize(
        authorizedRequest(session, "delete", {
          callId: "unsafe",
          scope: { kind: "exact", paths: ["../secret"] },
          affectedPaths: ["../secret"],
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("binds real affected paths and count into the requirement digest", async () => {
    const first = harness({ decisions: [{ kind: "allow_once" }] });
    const second = harness({ decisions: [{ kind: "allow_once" }] });
    await first.session.authorize(
      authorizedRequest(first.session, "replace_project", {
        tool: "init_project",
        scope: { kind: "project" },
        affectedPaths: ["index.html"],
        affectedCount: 2,
      }),
    );
    await second.session.authorize(
      authorizedRequest(second.session, "replace_project", {
        tool: "init_project",
        scope: { kind: "project" },
        affectedPaths: ["index.html", "src/App.tsx"],
        affectedCount: 2,
      }),
    );
    const left = vi.mocked(first.decision.decide).mock.calls[0]![0];
    const right = vi.mocked(second.decision.decide).mock.calls[0]![0];
    expect(left.affectedCount).toBe(2);
    expect(left.requirementDigest).not.toBe(right.requirementDigest);
  });

  it("allows only one pending prompt", async () => {
    const pending = deferred<ProjectPermissionDecision>();
    const { session } = harness({
      decision: { decide: vi.fn(() => pending.promise) },
    });
    const first = session.authorize(authorizedRequest(session));
    await Promise.resolve();
    await expect(
      session.authorize(
        authorizedRequest(session, "delete", { callId: "call-2" }),
      ),
    ).rejects.toMatchObject({ code: "permission_busy" });
    pending.resolve({ kind: "allow_once" });
    await expect(first).resolves.toMatchObject({ lifetime: "once" });
  });

  it("caches denial by operation and scope within a run", async () => {
    const { session, decision, events } = harness({
      decisions: [{ kind: "deny" }, { kind: "allow_once" }],
    });
    await expect(
      session.authorize(authorizedRequest(session)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      session.authorize(
        authorizedRequest(session, "delete", { callId: "call-2" }),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(decision.decide).toHaveBeenCalledTimes(1);
    expect(
      events.some(
        (event) => event.type === "denied" && event.reason === "cached",
      ),
    ).toBe(true);

    await session.authorize(
      authorizedRequest(session, "delete", {
        runId: "run-2",
        callId: "call-3",
      }),
    );
    expect(decision.decide).toHaveBeenCalledTimes(2);
  });

  it("does not reuse denial for a different affected path set", async () => {
    const { session, decision } = harness({
      decisions: [{ kind: "deny" }, { kind: "allow_once" }],
    });
    await expect(
      session.authorize(authorizedRequest(session)),
    ).rejects.toMatchObject({ code: "permission_denied" });

    await expect(
      session.authorize(
        authorizedRequest(session, "delete", {
          callId: "call-2",
          scope: { kind: "exact", paths: ["src/Other.tsx"] },
          affectedPaths: ["src/Other.tsx"],
        }),
      ),
    ).resolves.toMatchObject({ lifetime: "once" });
    expect(decision.decide).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale Host authority and a stale pending project revision", async () => {
    const pending = deferred<ProjectPermissionDecision>();
    const { session } = harness({
      decision: { decide: () => pending.promise },
    });
    await expect(session.authorize(request())).rejects.toMatchObject({
      code: "permission_authority_stale",
    });

    const oldAuthority = session.authority();
    const authorization = session.authorize(authorizedRequest(session));
    await Promise.resolve();
    session.change({ type: "project_revision", revision: 2 });
    await expect(authorization).rejects.toMatchObject({
      code: "permission_stale",
    });
    expect(oldAuthority.projectRevision).toBe(1);
    expect(session.authority().projectRevision).toBe(2);
    expect(session.authority().digest).not.toBe(oldAuthority.digest);
  });

  it("propagates cancellation and closes with grants revoked", async () => {
    const pending = deferred<ProjectPermissionDecision>();
    const controller = new AbortController();
    const { session } = harness({
      decision: { decide: () => pending.promise },
    });
    const authorization = session.authorize(
      authorizedRequest(session, "delete", { signal: controller.signal }),
    );
    await Promise.resolve();
    controller.abort();
    await expect(authorization).rejects.toMatchObject({
      name: "AbortError",
      code: "permission_cancelled",
    });

    const allowed = harness({
      decisions: [{ kind: "allow_session", scope: { kind: "project" } }],
    });
    await allowed.session.authorize(authorizedRequest(allowed.session));
    expect(allowed.session.authority().grants).toHaveLength(1);
    allowed.session.change({ type: "close" });
    expect(allowed.session.authority()).toMatchObject({
      closed: true,
      grants: [],
    });
    await expect(
      allowed.session.authorize(authorizedRequest(allowed.session)),
    ).rejects.toMatchObject({ code: "permission_cancelled" });
  });

  it("revokes one grant without affecting another operation grant", async () => {
    const { session } = harness({
      decisions: [
        { kind: "allow_session", scope: { kind: "project" } },
        { kind: "allow_session", scope: { kind: "project" } },
      ],
    });
    await session.authorize(authorizedRequest(session));
    await session.authorize(
      authorizedRequest(session, "move", {
        authorityId: session.authority().id,
        callId: "move-call",
      }),
    );
    const [first, second] = session.authority().grants;
    session.change({ type: "revoke_grant", grantId: first.id });
    expect(session.authority().grants).toEqual([second]);
  });

  it("does not issue a session permit after its grant is revoked", async () => {
    const executionAudit = deferred<void>();
    const audit: ProjectPermissionAuditAdapter = {
      record: vi.fn((event) =>
        event.type === "execution_started"
          ? executionAudit.promise
          : Promise.resolve(),
      ),
    };
    const { session } = harness({
      decisions: [{ kind: "allow_session", scope: { kind: "project" } }],
      audit,
    });
    const authorization = session.authorize(authorizedRequest(session));
    await vi.waitFor(() => expect(session.authority().grants).toHaveLength(1));
    const grantId = session.authority().grants[0].id;

    session.change({ type: "revoke_grant", grantId });
    executionAudit.resolve();

    await expect(authorization).rejects.toMatchObject({
      code: "permission_authority_stale",
    });
  });

  it("rejects session approval for whole-project replacement", async () => {
    const { session } = harness({
      decisions: [{ kind: "allow_session", scope: { kind: "project" } }],
    });
    await expect(
      session.authorize(
        authorizedRequest(session, "replace_project", {
          tool: "init_project",
          scope: { kind: "project" },
          affectedPaths: ["index.html", "src/App.tsx"],
          affectedCount: 2,
        }),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(session.authority().grants).toEqual([]);
  });

  it.each(["requested", "approved", "execution_started"] as const)(
    "fails closed when %s audit cannot be recorded",
    async (failedType) => {
      const audit: ProjectPermissionAuditAdapter = {
        record: vi.fn((event) => {
          if (event.type === failedType) throw new Error("storage unavailable");
        }),
      };
      const { session, decision } = harness({
        decisions: [{ kind: "allow_session", scope: { kind: "project" } }],
        audit,
      });
      await expect(
        session.authorize(authorizedRequest(session)),
      ).rejects.toMatchObject({ code: "permission_audit_unavailable" });
      if (failedType === "requested") {
        expect(decision.decide).not.toHaveBeenCalled();
      }
      if (failedType === "approved") {
        expect(session.authority().grants).toEqual([]);
      }
      if (failedType === "execution_started") {
        expect(session.authority().grants).toEqual([]);
      }
    },
  );

  it("bypasses decision, grants, stale checks and required audit", async () => {
    const counts = new Map<string, number>();
    const audit: ProjectPermissionAuditAdapter = {
      record: vi.fn((event) => {
        counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
        throw new Error("audit unavailable");
      }),
    };
    const { session, decision } = harness({ audit, bypassEnabled: true });
    const controller = new AbortController();
    controller.abort();
    const permit = await session.authorize(
      request("delete", {
        authorityId: "stale-authority",
        projectRevision: 999,
        signal: controller.signal,
      }),
    );

    expect(permit.lifetime).toBe("bypass");
    await session.settle(permit, { outcome: "succeeded" });
    expect(decision.decide).not.toHaveBeenCalled();
    expect(session.authority().grants).toEqual([]);
    expect(counts).toEqual(new Map([["bypassed", 1]]));
  });

  it("attempts final outcome audit only once", async () => {
    const counts = new Map<string, number>();
    const audit: ProjectPermissionAuditAdapter = {
      record: vi.fn((event) => {
        counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
        if (event.type === "settled") throw new Error("storage unavailable");
      }),
    };
    const { session } = harness({
      decisions: [{ kind: "allow_once" }],
      audit,
    });
    const permit = await session.authorize(authorizedRequest(session));
    await session.settle(permit, { outcome: "succeeded" });
    await session.settle(permit, { outcome: "failed" });
    expect(counts.get("settled")).toBe(1);
  });

  it("does not let a forged permit consume the real settlement", async () => {
    const { session, events } = harness({
      decisions: [{ kind: "allow_once" }],
    });
    const permit = await session.authorize(authorizedRequest(session));
    const forged = { ...permit } as typeof permit;

    await session.settle(forged, { outcome: "failed" });
    await session.settle(permit, { outcome: "succeeded" });

    const settled = events.filter((event) => event.type === "settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: "succeeded" });
  });

  it("maps decision adapter failures to a stable error", async () => {
    const { session, events } = harness({
      decision: { decide: () => Promise.reject(new Error("UI unavailable")) },
    });
    await expect(
      session.authorize(authorizedRequest(session)),
    ).rejects.toMatchObject({ code: "permission_prompt_unavailable" });
    expect(events.at(-1)).toMatchObject({
      type: "cancelled",
      reason: "prompt_unavailable",
    });
  });

  it("rejects replay of an already authorized call id", async () => {
    const { session } = harness({
      decisions: [{ kind: "allow_once" }, { kind: "allow_once" }],
    });
    await session.authorize(authorizedRequest(session));

    await expect(
      session.authorize(
        authorizedRequest(session, "delete", {
          authorityId: session.authority().id,
        }),
      ),
    ).rejects.toMatchObject({ code: "permission_authority_stale" });
  });

  it("rejects replay of an already authorized logical call after run rotation", async () => {
    const { session, decision } = harness({
      decisions: [{ kind: "allow_once" }, { kind: "allow_once" }],
    });
    const permit = await session.authorize(authorizedRequest(session));

    await expect(
      session.authorize(
        authorizedRequest(session, "delete", {
          runId: "run-2",
          authorityId: session.authority().id,
        }),
      ),
    ).rejects.toMatchObject({ code: "permission_authority_stale" });
    expect(decision.decide).toHaveBeenCalledOnce();
    expect(permit.runId).toBe("run-1");
  });

  it("rejects an unknown runtime before prompting", async () => {
    const { session, decision } = harness({
      decisions: [{ kind: "allow_once" }],
    });

    await expect(
      session.authorize(
        authorizedRequest(session, "delete", {
          runtime: "shell" as "api",
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(decision.decide).not.toHaveBeenCalled();
  });

  it("revokes grants and cancels a prompt when bypass changes", async () => {
    const allowed = harness({
      decisions: [{ kind: "allow_session", scope: { kind: "project" } }],
    });
    await allowed.session.authorize(authorizedRequest(allowed.session));
    expect(allowed.session.authority().grants).toHaveLength(1);
    allowed.session.change({ type: "set_bypass", enabled: true });
    expect(allowed.session.authority()).toMatchObject({
      bypassEnabled: true,
      grants: [],
    });

    const pending = deferred<ProjectPermissionDecision>();
    const waiting = harness({ decision: { decide: () => pending.promise } });
    const authorization = waiting.session.authorize(
      authorizedRequest(waiting.session),
    );
    await Promise.resolve();
    waiting.session.change({ type: "set_bypass", enabled: true });
    await expect(authorization).rejects.toMatchObject({
      name: "AbortError",
      code: "permission_cancelled",
    });
  });
});
