// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandpackProvider, useSandpack } from "@codesandbox/sandpack-react";
import { useSettingsStore } from "../../store/settings";
import type { ProjectFiles } from "../../types";
import { PreviewCompilationStatus } from "./PreviewCompilationStatus";
import type { SandpackRuntimeSyncHandle } from "./SandpackRuntimeSync";

type Sandpack = ReturnType<typeof useSandpack>["sandpack"];
type Client = Sandpack["clients"][string];
type Message = Parameters<Parameters<Client["listen"]>[0]>[0];

function clientFixture(status: Client["status"] = "initializing") {
  const listeners = new Set<(message: Message) => void>();
  const updates: Client["sandboxSetup"][] = [];
  const client = {
    status,
    options: {},
    sandboxSetup: { files: {}, template: "parcel" },
    listen(listener: (message: Message) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateSandbox(this: Client, setup: Client["sandboxSetup"]) {
      updates.push(setup);
      this.sandboxSetup = setup;
      // A running Node shell acknowledges filesystem writes without a new done.
      if (setup.template !== "node") this.status = "initializing";
    },
  } as unknown as Client;
  return { client, listeners, updates };
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function mountPreview(
  cachedError?: string,
  environment: "parcel" | "node" = "parcel",
) {
  const initial = clientFixture(cachedError ? "done" : "initializing");
  if (cachedError)
    Object.assign(initial.client, { errors: [{ message: cachedError }] });
  let currentClient = initial.client;
  let state!: Sandpack;
  let handle: SandpackRuntimeSyncHandle | null = null;
  const retry = vi.fn();
  const register = (value: SandpackRuntimeSyncHandle | null) => {
    handle = value;
  };
  function MountClient() {
    const { sandpack } = useSandpack();
    state = sandpack;
    useEffect(() => {
      currentClient.sandboxSetup = {
        files: sandpack.files,
        template: environment,
      };
      sandpack.clients.preview = currentClient;
      return () => {
        delete sandpack.clients.preview;
      };
    }, []);
    return null;
  }
  const files = { "index.html": "<main>Imported</main>", "obsolete.js": "old" };
  function content(nextFiles: ProjectFiles, identity = "conversation:1") {
    return (
      <SandpackProvider
        template="static"
        customSetup={{ environment }}
        files={nextFiles}
      >
        <MountClient />
        <PreviewCompilationStatus
          identity={identity}
          files={nextFiles}
          onRuntimeChange={register}
          onRetry={retry}
        />
      </SandpackProvider>
    );
  }
  const mounted = render(content(files));
  async function send(
    message: Message,
    target = initial,
    status?: Client["status"],
  ) {
    await act(async () => {
      if (status) target.client.status = status;
      for (const listener of [...target.listeners]) listener(message);
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  return {
    ...mounted,
    initial,
    files,
    retry,
    send,
    handle: () => handle,
    state: () => state,
    update: (nextFiles: ProjectFiles, identity?: string) =>
      mounted.rerender(content(nextFiles, identity)),
    replaceClient: (replacement: Client) => {
      replacement.sandboxSetup = { files: state.files, template: environment };
      currentClient = replacement;
      state.clients.preview = replacement;
    },
  };
}

describe("preview compilation status on the existing runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });
  afterEach(() => vi.useRealTimers());

  it("reports Node file acknowledgements as synchronization without claiming another compilation", async () => {
    const preview = mountPreview(undefined, "node");
    await preview.send(
      { type: "done", compilatonError: false },
      undefined,
      "done",
    );
    const nextFiles = { "index.html": "<main>Updated in Node</main>" };
    preview.update(nextFiles);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(preview.initial.updates).toHaveLength(1);
    await preview.send({
      type: "fs/change",
      path: "/index.html",
      content: nextFiles["index.html"],
    });
    expect(preview.handle()!.isSynchronized(nextFiles)).toBe(false);
    await preview.send({ type: "fs/remove", path: "/obsolete.js" });
    expect(preview.handle()!.isSynchronized(nextFiles)).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(
      /files.*synced|files.*synchronized/i,
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "compilation complete",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(preview.initial.updates).toHaveLength(1);
    await preview.send({
      type: "action",
      action: "notification",
      notificationType: "error",
      title: "Server compilation failed",
    });
    expect(screen.getByRole("status")).toHaveTextContent(/failed/i);
    preview.unmount();
  });

  it("reads a client's cached failure if it finished before registration", async () => {
    const preview = mountPreview("Early compilation failure");
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent(/failed/i);
    expect(screen.getByText("Early compilation failure")).toBeInTheDocument();
    expect(preview.handle()!.isSynchronized(preview.files)).toBe(false);
    preview.unmount();
  });

  it("reports actual compilation completion and only generates the runtime package manifest", async () => {
    const preview = mountPreview();
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Starting");
    expect(preview.state().files["/package.json"].code).toContain(
      '"dependencies": {}',
    );
    expect(preview.files).not.toHaveProperty("package.json");
    await preview.send(
      { type: "start", firstLoad: true },
      undefined,
      "transpiling",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Compiling");
    await preview.send(
      { type: "done", compilatonError: false },
      undefined,
      "done",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "compilation complete",
    );
    expect(preview.handle()!.isSynchronized(preview.files)).toBe(true);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    preview.unmount();
  });

  it("times out without destroying the project, retries through the owner, and accepts late success", async () => {
    const preview = mountPreview();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      /taking longer|timed out/i,
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(preview.retry).toHaveBeenCalledOnce();
    await preview.send(
      { type: "done", compilatonError: false },
      undefined,
      "done",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "compilation complete",
    );
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    preview.unmount();
    expect(preview.initial.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains compilation failures after done and never reports them synchronized", async () => {
    const preview = mountPreview();
    await preview.send({
      type: "action",
      action: "show-error",
      title: "Compile error",
      message: "Missing ./app.js",
      path: "/index.html",
    } as Message);
    await preview.send(
      { type: "done", compilatonError: true },
      undefined,
      "done",
    );
    expect(screen.getByRole("status")).toHaveTextContent(/failed/i);
    expect(screen.getByText("Missing ./app.js")).toBeInTheDocument();
    expect(preview.handle()!.isSynchronized(preview.files)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/failed/i);
    preview.unmount();
  });

  it("does not reuse an old success while deleted files await Provider reconciliation", async () => {
    const preview = mountPreview();
    await preview.send(
      { type: "done", compilatonError: false },
      undefined,
      "done",
    );
    preview.update({ "index.html": preview.files["index.html"] });
    await flush();
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "compilation complete",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await preview.send(
      { type: "start", firstLoad: false },
      undefined,
      "transpiling",
    );
    await preview.send(
      { type: "done", compilatonError: false },
      undefined,
      "done",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "compilation complete",
    );
    preview.unmount();
  });

  it("ignores an old file's failure and waits for the newly submitted source", async () => {
    const preview = mountPreview();
    const next = { "index.html": "<main>New source</main>" };
    preview.update(next);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await preview.send(
      { type: "done", compilatonError: true },
      undefined,
      "done",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      /failed|compilation complete/i,
    );
    await preview.send(
      { type: "start", firstLoad: false },
      undefined,
      "transpiling",
    );
    await preview.send(
      { type: "done", compilatonError: false },
      undefined,
      "done",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "compilation complete",
    );
    preview.unmount();
  });

  it("ignores removed client messages and resets the timeout for a new preview identity", async () => {
    const preview = mountPreview();
    const late = [...preview.initial.listeners];
    const replacement = clientFixture();
    preview.replaceClient(replacement.client);
    preview.update(preview.files, "conversation:2");
    await flush();
    await act(async () => {
      for (const listener of late)
        listener({ type: "done", compilatonError: true });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status")).not.toHaveTextContent(
      /failed|compilation complete/i,
    );
    await preview.send(
      { type: "done", compilatonError: false },
      replacement,
      "done",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "compilation complete",
    );
    preview.unmount();
  });
});
