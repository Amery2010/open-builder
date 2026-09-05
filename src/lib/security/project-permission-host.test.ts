// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPermissionActivity, clearPermissionActivity } from "./activity-log";
import { createHostProjectPermissionSession } from "./project-permission-host";
import { useProjectPermissionStore } from "../../store/project-permission";
import { WebAppGenerator } from "../ai/generator";
import { BUILTIN_TOOLS } from "../ai/tools-schema";

function authorizeInput(
  session: ReturnType<typeof createHostProjectPermissionSession>,
  runtime: "api" | "local_cli",
) {
  return {
    runId: "run-1",
    callId: "call-1",
    tool: "delete_file",
    runtime,
    operation: "delete" as const,
    sessionEligible: true,
    scope: { kind: "exact" as const, paths: ["src/old.ts"] },
    affectedPaths: ["src/old.ts"],
    affectedCount: 1,
    projectRevision: 0,
    authorityId: session.authority().id,
    signal: new AbortController().signal,
  };
}

describe("Host Project Permission Session", () => {
  beforeEach(() => {
    localStorage.clear();
    clearPermissionActivity();
    useProjectPermissionStore.setState({ pending: null, authorities: {} });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["api", "local_cli"] as const)(
    "records one shared v2 audit shape for the %s runtime",
    async (runtime) => {
      const persistedStates: string[] = [];
      const nativeSetItem = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        persistedStates.push(value);
        return nativeSetItem.call(this, key, value);
      });
      const session = createHostProjectPermissionSession({
        conversationId: `conversation-${runtime}`,
        platform: runtime === "api" ? "web" : "desktop",
        runtime,
        bypassEnabled: false,
      });
      const authorization = session.authorize(authorizeInput(session, runtime));
      await vi.waitFor(() =>
        expect(useProjectPermissionStore.getState().pending).not.toBeNull(),
      );
      const requestId =
        useProjectPermissionStore.getState().pending!.request.requestId;
      useProjectPermissionStore.getState().submitDecision(requestId, {
        kind: "allow_once",
      });
      const permit = await authorization;
      await session.settle(permit, { outcome: "succeeded" });

      const entries = getPermissionActivity(`conversation-${runtime}`);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        version: 2,
        runtime,
        operation: "delete",
        decision: "allowed_once",
        outcome: "succeeded",
        affectedPaths: ["src/old.ts"],
        affectedCount: 1,
      });
      expect(
        persistedStates.map((serialized) => {
          const stored = JSON.parse(serialized) as Array<{
            decision: string;
            outcome?: string;
          }>;
          const latest = stored.at(-1);
          return [latest?.decision, latest?.outcome];
        }),
      ).toEqual([
        ["requested", undefined],
        ["allowed_once", undefined],
        ["allowed_once", "execution_started"],
        ["allowed_once", "succeeded"],
      ]);
    },
  );

  it("fails closed before prompting when required audit storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    const session = createHostProjectPermissionSession({
      conversationId: "conversation-fail-closed",
      platform: "web",
      runtime: "api",
      bypassEnabled: false,
    });

    await expect(
      session.authorize(authorizeInput(session, "api")),
    ).rejects.toMatchObject({ code: "permission_audit_unavailable" });
    expect(useProjectPermissionStore.getState().pending).toBeNull();
  });

  it("keeps full-permission bypass available when audit storage fails", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    const session = createHostProjectPermissionSession({
      conversationId: "conversation-bypass",
      platform: "desktop",
      runtime: "local_cli",
      bypassEnabled: true,
    });

    await expect(
      session.authorize(authorizeInput(session, "local_cli")),
    ).resolves.toMatchObject({ lifetime: "bypass" });
    expect(useProjectPermissionStore.getState().pending).toBeNull();
  });

  it("closes the pending UI after a single deny decision", async () => {
    const session = createHostProjectPermissionSession({
      conversationId: "conversation-denied",
      platform: "web",
      runtime: "api",
      bypassEnabled: false,
    });
    const generator = new WebAppGenerator({
      apiBaseUrl: "https://example.test/v1",
      apiKey: "test",
      model: "test",
      conversationId: "conversation-denied",
      initialFiles: { "src/old.ts": "old" },
      tools: { delete_file: BUILTIN_TOOLS.delete_file },
      projectPermissionSession: session,
      onProjectPermissionRequestFinished: (callId, error) =>
        useProjectPermissionStore.getState().finishRequest(callId, error),
    });
    const execution = generator.executeToolCall({
      id: "deny-delete",
      type: "function",
      function: {
        name: "delete_file",
        arguments: JSON.stringify({ path: "src/old.ts" }),
      },
    });
    await vi.waitFor(() =>
      expect(useProjectPermissionStore.getState().pending).not.toBeNull(),
    );
    const requestId =
      useProjectPermissionStore.getState().pending!.request.requestId;

    useProjectPermissionStore.getState().submitDecision(requestId, {
      kind: "deny",
    });

    await expect(execution).resolves.toMatchObject({
      result: { isError: true },
      changes: [],
    });
    expect(useProjectPermissionStore.getState().pending).toBeNull();
    expect(generator.getFiles()).toEqual({ "src/old.ts": "old" });
  });

  it("leaves execution-started durable when final outcome audit fails", async () => {
    let writes = 0;
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      writes += 1;
      if (writes === 4) throw new Error("final audit unavailable");
      return nativeSetItem.call(this, key, value);
    });
    const session = createHostProjectPermissionSession({
      conversationId: "conversation-final-audit",
      platform: "web",
      runtime: "api",
      bypassEnabled: false,
    });
    const authorization = session.authorize(authorizeInput(session, "api"));
    await vi.waitFor(() =>
      expect(useProjectPermissionStore.getState().pending).not.toBeNull(),
    );
    useProjectPermissionStore
      .getState()
      .submitDecision(
        useProjectPermissionStore.getState().pending!.request.requestId,
        { kind: "allow_once" },
      );
    const permit = await authorization;

    await expect(
      session.settle(permit, { outcome: "succeeded" }),
    ).resolves.toBeUndefined();

    expect(getPermissionActivity("conversation-final-audit")).toEqual([
      expect.objectContaining({
        decision: "allowed_once",
        outcome: "execution_started",
      }),
    ]);
  });
});
