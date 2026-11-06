import { expect, test, type Page } from "@playwright/test";
import type {
  LocalAgentEvent,
  LocalAgentStartRequest,
  LocalToolResolution,
} from "../src/lib/local-agent/types";
import { waitForAppReady } from "./helpers/app-ready";

test.use({
  browserName:
    process.env.PLAYWRIGHT_BROWSER === "webkit" ? "webkit" : "chromium",
  channel: process.env.PLAYWRIGHT_CHANNEL,
});

type Subscriber = {
  documentId: string;
  channel: number;
  index: number;
  replay: boolean;
};

/** Lives in the test process, so page.reload() really destroys the consumer
 * without destroying the simulated desktop process. Native lifecycle and
 * tool-claim correctness are covered separately by the Rust tests. */
async function installDesktopFixture(
  page: Page,
  options: { holdToolResults?: boolean } = {},
) {
  const calls: string[] = [];
  let currentDocument = "";
  let run:
    | {
        id: string;
        request: LocalAgentStartRequest;
        subscriber: Subscriber;
        events: LocalAgentEvent[];
        terminal: boolean;
        acknowledged: boolean;
        context: unknown;
        lease: { owner: string; epoch: number };
        claimed: Set<string>;
        resolutions: Record<string, LocalToolResolution>;
      }
    | undefined;
  let starts = 0;
  let cancellations = 0;
  let attachments = 0;
  let activeAttachments = 0;
  const toolExecutions: string[] = [];
  const pendingResults: Array<() => void> = [];
  const pendingDiscovery: Array<() => void> = [];
  let holdDiscovery = false;

  const emit = async (event: LocalAgentEvent) => {
    if (!run) throw new Error("No native run");
    run.events.push(event);
    if (event.type === "done") run.terminal = true;
    const subscriber = run.subscriber;
    if (subscriber.documentId !== currentDocument) return;
    await page.evaluate(
      ({ channel, index, event }) => {
        const host = window as unknown as {
          __desktopFixtureDeliver: (channel: number, message: unknown) => void;
        };
        host.__desktopFixtureDeliver?.(channel, { index, message: event });
      },
      {
        channel: subscriber.channel,
        index: subscriber.index++,
        event: subscriber.replay
          ? { runId: run.id, sequence: run.events.length, event }
          : event,
      },
    );
  };

  await page.exposeBinding(
    "__desktopFixtureInvoke",
    async (
      _source,
      command: string,
      args: Record<string, unknown>,
      documentId: string,
    ) => {
      currentDocument = documentId;
      calls.push(command);
      if (command === "mcp_platform_capabilities") {
        return {
          remoteStreaming: false,
          stdio: false,
          oauthLoopback: false,
          skillScripts: false,
          localAgents: true,
        };
      }
      if (command === "local_agent_probe") {
        return {
          provider: "codex",
          availability: "ready",
          status: "ready",
          version: "fixture",
          catalogAuthority: "authoritative",
          checkedAt: Date.now(),
          models: [
            {
              id: "fixture",
              displayName: "Fixture",
              isDefault: true,
              efforts: [],
            },
          ],
          efforts: [],
          preferenceDecision: { kind: "keep", unverified: false },
          capabilities: {
            sessions: true,
            reasoning: true,
            tools: true,
            nativeSearch: false,
            imageGeneration: false,
            imageEditing: false,
            mediaCapabilitiesVerified: true,
          },
        };
      }
      if (command === "local_agent_start") {
        if (run && !run.terminal)
          throw new Error("Duplicate active native run");
        starts += 1;
        run = {
          id: "native-reconnect-fixture",
          request: args.request as LocalAgentStartRequest,
          subscriber: {
            documentId,
            channel: Number(String(args.onEvent).split(":")[1]),
            index: 0,
            replay: false,
          },
          events: [],
          terminal: false,
          acknowledged: false,
          context: (args.recovery as { context?: unknown } | undefined)
            ?.context,
          lease: {
            owner:
              (args.recovery as { owner?: string } | undefined)?.owner ?? "",
            epoch: 1,
          },
          claimed: new Set(),
          resolutions: {},
        };
        return run.id;
      }
      if (command === "local_agent_cancel") {
        if (!run || run.terminal) return false;
        cancellations += 1;
        await emit({ type: "done", aborted: true });
        return true;
      }
      if (command === "local_agent_list_recoverable") {
        if (holdDiscovery && run) {
          await new Promise<void>((resolve) => pendingDiscovery.push(resolve));
        }
        return !run || run.acknowledged
          ? []
          : [
              {
                runId: run.id,
                request: run.request,
                context: run.context,
                terminal: run.terminal,
              },
            ];
      }
      if (command === "local_agent_attach") {
        if (!run || args.runId !== run.id) throw new Error("Run unavailable");
        attachments += 1;
        if (!run.terminal) activeAttachments += 1;
        if (run.lease.owner !== String(args.owner)) {
          run.lease = { owner: String(args.owner), epoch: run.lease.epoch + 1 };
        }
        run.subscriber = {
          documentId,
          channel: Number(String(args.onEvent).split(":")[1]),
          index: 0,
          replay: true,
        };
        const uncertain = [...run.claimed].some((id) => !run!.resolutions[id]);
        if (uncertain) {
          cancellations += 1;
          setTimeout(() => {
            void emit({ type: "done", aborted: true });
          }, 0);
        }
        return {
          runId: run.id,
          request: run.request,
          context: run.context,
          terminal: run.terminal,
          lease: run.lease,
          events: run.events.map((event, index) => ({
            runId: run!.id,
            sequence: index + 1,
            event,
          })),
          resolutions: run.resolutions,
          uncertain,
        };
      }
      if (command === "local_agent_claim_tool") {
        if (!run) throw new Error("Run unavailable");
        const callId = String(args.callId);
        if (JSON.stringify(args.lease) !== JSON.stringify(run.lease))
          throw new Error("Stale owner");
        if (run.resolutions[callId])
          return { status: "resolved", resolution: run.resolutions[callId] };
        if (run.claimed.has(callId)) throw new Error("Unknown tool outcome");
        run.claimed.add(callId);
        toolExecutions.push(callId);
        return { status: "execute" };
      }
      if (command === "local_agent_resolve_tool") {
        if (!run) throw new Error("Run unavailable");
        if (options.holdToolResults) {
          await new Promise<void>((resolve) => pendingResults.push(resolve));
        }
        if (
          args.lease &&
          JSON.stringify(args.lease) !== JSON.stringify(run.lease)
        )
          throw new Error("Stale owner");
        run.resolutions[String(args.callId)] =
          args.result as LocalToolResolution;
        if (args.recoveryContext) run.context = args.recoveryContext;
        return null;
      }
      if (command === "local_agent_acknowledge_terminal") {
        if (run) run.acknowledged = true;
        return null;
      }
      if (command.startsWith("plugin:event|")) return 1;
      if (command === "plugin:fs|read_dir") return [];
      if (command === "plugin:fs|exists") return false;
      if (
        command === "plugin:fs|mkdir" ||
        command === "plugin:fs|write_text_file"
      )
        return null;
      if (command === "plugin:path|resolve_directory") return "/fixture";
      if (
        command === "set_proxy_policy" ||
        command === "mcp_set_remote_policy" ||
        command === "mcp_close_all" ||
        command === "cancel_all_skill_scripts" ||
        command === "sse_disconnect_all"
      )
        return 0;
      throw new Error(`Unhandled desktop fixture command: ${command}`);
    },
  );
  await page.addInitScript(() => {
    const documentId = crypto.randomUUID();
    const callbacks = new Map<number, (value: unknown) => void>();
    let callbackId = 0;
    const host = window as unknown as {
      __desktopFixtureInvoke: (
        command: string,
        args: unknown,
        documentId: string,
      ) => Promise<unknown>;
      __desktopFixtureDeliver: (id: number, message: unknown) => void;
      __TAURI_INTERNALS__: unknown;
    };
    host.__desktopFixtureDeliver = (id, message) =>
      callbacks.get(id)?.(message);
    host.__TAURI_INTERNALS__ = {
      transformCallback(callback: (value: unknown) => void) {
        const id = ++callbackId;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      invoke(command: string, args: unknown = {}) {
        return host.__desktopFixtureInvoke(
          command,
          JSON.parse(JSON.stringify(args)),
          documentId,
        );
      },
      convertFileSrc(path: string) {
        return path;
      },
    };
  });
  return {
    emit,
    get starts() {
      return starts;
    },
    get cancellations() {
      return cancellations;
    },
    get attachments() {
      return attachments;
    },
    get activeAttachments() {
      return activeAttachments;
    },
    get toolExecutions() {
      return toolExecutions;
    },
    get run() {
      return run;
    },
    releaseResults() {
      for (const resolve of pendingResults.splice(0)) resolve();
    },
    holdDiscovery() {
      holdDiscovery = true;
    },
    releaseDiscovery() {
      holdDiscovery = false;
      for (const resolve of pendingDiscovery.splice(0)) resolve();
    },
    get discoveryWaiting() {
      return pendingDiscovery.length;
    },
    get calls() {
      return calls;
    },
  };
}

async function seedLocalProject(page: Page) {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const settingsUrl = "/src/store/settings/index.ts";
    const conversationUrl = "/src/store/conversation.ts";
    const { useSettingsStore } = await import(settingsUrl);
    const { useConversationStore } = await import(conversationUrl);
    const settings = useSettingsStore.getState();
    useSettingsStore.setState({
      system: { ...settings.system, language: "en", autoQaEnabled: false },
      ai: {
        ...settings.ai,
        runtime: "localCli",
        localAgent: {
          ...settings.ai.localAgent,
          provider: "codex",
          preferences: {
            ...settings.ai.localAgent.preferences,
            codex: { model: "fixture", effort: "" },
          },
        },
      },
    });
    const store = useConversationStore.getState();
    store.renameConversation(store.activeId, "Reconnect regression");
    store.setWorkspaceMode("auto");
    store.replaceProject({
      files: { "index.html": "<main>Before reconnect</main>" },
      template: "static",
      previewMode: "code-only",
    });
  });
}

async function projectFile(page: Page, path: string) {
  return page.evaluate(async (filePath) => {
    const url = "/src/store/conversation.ts";
    const { useConversationStore } = await import(url);
    const store = useConversationStore.getState();
    return store.conversations[store.activeId].files[filePath];
  }, path);
}

async function beginFixtureRun(
  page: Page,
  desktop: Awaited<ReturnType<typeof installDesktopFixture>>,
) {
  await seedLocalProject(page);
  await page.locator("textarea").fill("Continue the local fixture task");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => desktop.starts).toBe(1);
  await desktop.emit({
    type: "prepared",
    compatibilityKey: "fixture-key",
    installationFingerprint: "fixture-installation",
    cliVersion: "fixture",
    resumed: false,
  });
  await desktop.emit({
    type: "textDelta",
    delta: "Output before page reload.",
  });
  await expect(
    page.getByText("Output before page reload.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
}

test("reconnects the same native run after a full page reload and can stop it", async ({
  page,
}) => {
  const desktop = await installDesktopFixture(page);
  await beginFixtureRun(page, desktop);

  await page.reload();
  await waitForAppReady(page);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await desktop.emit({ type: "textDelta", delta: " Output after reconnect." });
  await expect(
    page.getByText("Output before page reload. Output after reconnect.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(desktop.starts).toBe(1);
  await expect(
    page.getByText("Continue the local fixture task", { exact: true }),
  ).toHaveCount(1);

  await page.reload();
  await waitForAppReady(page);
  await expect(
    page.getByText("Output before page reload. Output after reconnect.", {
      exact: true,
    }),
  ).toHaveCount(1);
  expect(desktop.starts).toBe(1);
  await expect.poll(() => desktop.activeAttachments).toBeGreaterThanOrEqual(2);
  await desktop.emit({ type: "textDelta", delta: " Second page reconnected." });
  await expect(
    page.getByText(
      "Output before page reload. Output after reconnect. Second page reconnected.",
      { exact: true },
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => desktop.cancellations).toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
  await expect.poll(() => desktop.run?.acknowledged).toBe(true);
  await expect(page.getByText(/Local CLI runtime error/)).toHaveCount(0);
});

test("executes an offline queued tool once and replays its confirmed result after another reload", async ({
  page,
}) => {
  const desktop = await installDesktopFixture(page);
  await beginFixtureRun(page, desktop);
  await page.goto("about:blank");
  await desktop.emit({
    type: "toolRequest",
    runId: "native-reconnect-fixture",
    callId: "write-after-disconnect",
    name: "write_file",
    arguments: {
      path: "index.html",
      content: "<main>Reconnected tool completed</main>",
    },
  });
  await page.goto("/");
  await waitForAppReady(page);
  await expect
    .poll(
      () =>
        desktop.run?.resolutions["write-after-disconnect"]?.isError === false ||
        Boolean(desktop.run?.resolutions["write-after-disconnect"]?.text),
    )
    .toBe(true);
  expect(desktop.run?.resolutions["write-after-disconnect"]?.isError).not.toBe(
    true,
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = "/src/store/conversation.ts";
        const { useConversationStore } = await import(url);
        const store = useConversationStore.getState();
        return store.conversations[store.activeId].files["index.html"];
      }),
    )
    .toBe("<main>Reconnected tool completed</main>");
  expect(desktop.toolExecutions).toEqual(["write-after-disconnect"]);

  await page.reload();
  await waitForAppReady(page);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  expect(desktop.toolExecutions).toEqual(["write-after-disconnect"]);
  expect(desktop.starts).toBe(1);
  await desktop.emit({
    type: "textDelta",
    delta: "Queued tool finished after reconnect.",
  });
  await desktop.emit({ type: "done", aborted: false });
  await expect(
    page.getByText("Queued tool finished after reconnect.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
});

test("recovers a terminal result produced while the page was closed", async ({
  page,
}) => {
  const desktop = await installDesktopFixture(page);
  await beginFixtureRun(page, desktop);
  await page.goto("about:blank");
  await desktop.emit({
    type: "textDelta",
    delta: " Completed while the page was closed.",
  });
  await desktop.emit({ type: "done", aborted: false });
  await page.goto("/");
  await waitForAppReady(page);
  await expect(
    page.getByText(
      "Output before page reload. Completed while the page was closed.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
  await expect.poll(() => desktop.run?.acknowledged).toBe(true);
  expect(desktop.starts).toBe(1);
});

test("keeps a completed write and reports an unknown result without running it again", async ({
  page,
}) => {
  const desktop = await installDesktopFixture(page, { holdToolResults: true });
  try {
    await beginFixtureRun(page, desktop);
    await desktop.emit({
      type: "toolRequest",
      runId: "native-reconnect-fixture",
      callId: "write-with-unconfirmed-result",
      name: "write_file",
      arguments: {
        path: "index.html",
        content: "<main>Keep this completed write</main>",
      },
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const url = "/src/store/conversation.ts";
          const { useConversationStore } = await import(url);
          const store = useConversationStore.getState();
          return store.conversations[store.activeId].files["index.html"];
        }),
      )
      .toBe("<main>Keep this completed write</main>");
    expect(
      desktop.run?.resolutions["write-with-unconfirmed-result"],
    ).toBeUndefined();
    await page.reload();
    await waitForAppReady(page);
    await expect(
      page.getByText(/A tool may have run before the page disconnected/),
    ).toBeVisible();
    expect(await projectFile(page, "index.html")).toBe(
      "<main>Keep this completed write</main>",
    );
    expect(desktop.toolExecutions).toEqual(["write-with-unconfirmed-result"]);
    expect(desktop.starts).toBe(1);
    await expect.poll(() => desktop.cancellations).toBeGreaterThan(0);
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeVisible();
  } finally {
    desktop.releaseResults();
  }
});

test("honors Stop while a refreshed page is still discovering the background run", async ({
  page,
}) => {
  const desktop = await installDesktopFixture(page);
  try {
    await beginFixtureRun(page, desktop);
    desktop.holdDiscovery();
    await page.reload();
    await waitForAppReady(page);
    await expect.poll(() => desktop.discoveryWaiting).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    desktop.releaseDiscovery();
    await expect.poll(() => desktop.cancellations).toBeGreaterThan(0);
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeVisible();
    expect(desktop.activeAttachments).toBe(0);
    expect(desktop.toolExecutions).toEqual([]);
    await expect.poll(() => desktop.run?.acknowledged).toBe(true);
    expect(desktop.starts).toBe(1);
  } finally {
    desktop.releaseDiscovery();
  }
});

test("preserves an acknowledged user update exactly once across reconnection", async ({
  page,
}) => {
  const desktop = await installDesktopFixture(page);
  await beginFixtureRun(page, desktop);
  await page.locator("textarea").fill("Use green accents in the existing task");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await desktop.emit({
    type: "toolRequest",
    runId: "native-reconnect-fixture",
    callId: "deliver-user-update",
    name: "list_files",
    arguments: {},
  });
  await expect
    .poll(() =>
      desktop.run?.resolutions["deliver-user-update"]?.text.includes(
        "Use green accents in the existing task",
      ),
    )
    .toBe(true);
  await expect(
    page.getByText("Use green accents in the existing task", { exact: true }),
  ).toHaveCount(1);
  await page.reload();
  await waitForAppReady(page);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Use green accents in the existing task", { exact: true }),
  ).toHaveCount(1);
  expect(desktop.toolExecutions).toEqual(["deliver-user-update"]);
  expect(desktop.starts).toBe(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});
