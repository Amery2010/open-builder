import { webcrypto } from "node:crypto";
// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SandpackProvider,
  SandpackReactContext,
  useSandpack,
} from "@codesandbox/sandpack-react";
import { projectSandpackRuntime } from "./sandpack-runtime-preview";
import { waitForPreviewSynchronization } from "../../lib/design/preview-capture";
import {
  SandpackRuntimeSync,
  type SandpackRuntimeSyncHandle,
} from "./SandpackRuntimeSync";

const loader = vi.hoisted(() => ({ load: vi.fn() }));
// Keep the real Provider's delayed compile effect; replace only browser client creation.
vi.mock("@codesandbox/sandpack-react", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const moduleRuntime = require("node:module") as {
    _load: (
      name: string,
      parent: unknown,
      main: boolean,
    ) => Record<string, unknown>;
  };
  const original = moduleRuntime._load;
  moduleRuntime._load = function (name, parent, main) {
    const actual = original.call(this, name, parent, main);
    return name === "@codesandbox/sandpack-client"
      ? { ...actual, loadSandpackClient: loader.load }
      : actual;
  };
  try {
    return require("@codesandbox/sandpack-react");
  } finally {
    moduleRuntime._load = original;
  }
});

describe("Sandpack runtime file delivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it.each(["timeout", "idle"] as const)(
    "does not keep polling an empty %s runtime",
    (status) => {
      const schedule = vi.spyOn(globalThis, "setTimeout");
      function InactiveRuntime() {
        const context = useContext(SandpackReactContext)!;
        return (
          <SandpackReactContext value={{ ...context, status }}>
            <SandpackRuntimeSync />
          </SandpackReactContext>
        );
      }
      const { unmount } = render(
        <SandpackProvider template="static">
          <InactiveRuntime />
        </SandpackProvider>,
      );
      expect(
        schedule.mock.calls.filter(([, delay]) => delay === 50),
      ).toHaveLength(0);
      unmount();
      schedule.mockRestore();
    },
  );
  it("delivers the latest files after a busy client finishes without a compile loop", async () => {
    type Sandpack = ReturnType<typeof useSandpack>["sandpack"];
    let state: Sandpack;
    const updates: string[] = [];
    const listeners = new Set<(message: { type: "done" }) => void>();
    const client = {
      status: "done",
      listen: (listener: (message: { type: "done" }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sandboxSetup: { files: {} as Sandpack["files"] },
      updateSandbox(setup: { files: Sandpack["files"] }) {
        this.status = "compiling";
        updates.push(setup.files["/index.html"].code);
      },
    };
    function Client() {
      const { sandpack } = useSandpack();
      state = sandpack;
      useEffect(() => {
        client.sandboxSetup = { files: sandpack.files };
        sandpack.clients.preview =
          client as unknown as Sandpack["clients"][string];
        return () => {
          delete sandpack.clients.preview;
        };
      }, []);
      return null;
    }
    const originalUpdate = client.updateSandbox;
    let handle: SandpackRuntimeSyncHandle | null = null;
    function register(value: SandpackRuntimeSyncHandle | null) {
      handle = value;
    }
    const initialFiles = { "index.html": "initial" };
    const { rerender, unmount } = render(
      <SandpackProvider template="static" files={initialFiles}>
        <Client />
        <SandpackRuntimeSync onChange={register} />
      </SandpackProvider>,
    );
    await act(async () => {
      state!.updateFile("/index.html", "edit-A");
    });
    await waitFor(() => expect(updates).toEqual(["edit-A"]));
    await act(async () => {
      state!.updateFile("/index.html", "edit-B");
    });
    expect(updates).toEqual(["edit-A"]);
    expect(handle!.isSynchronized({ "index.html": "edit-B" })).toBe(false);
    await act(async () => {
      state!.updateFile("/index.html", "edit-C");
    });
    await act(async () => {
      client.status = "done";
      for (const listener of listeners) listener({ type: "done" });
    });
    await waitFor(() => expect(updates).toEqual(["edit-A", "edit-C"]));
    await act(async () => {
      client.status = "done";
      for (const listener of listeners) listener({ type: "done" });
    });
    rerender(
      <SandpackProvider template="static" files={initialFiles}>
        <Client />
        <SandpackRuntimeSync onChange={register} />
      </SandpackProvider>,
    );
    expect(updates).toEqual(["edit-A", "edit-C"]);
    expect(handle!.isSynchronized({ "index.html": "edit-C" })).toBe(true);
    await act(async () => {
      client.status = "compiling";
      state!.updateFile("/index.html", "cancelled");
    });
    unmount();
    expect(client.updateSandbox).toBe(originalUpdate);
    expect(handle).toBeNull();
    client.status = "done";
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(updates).toEqual(["edit-A", "edit-C"]);
  });
});

describe("real Provider delayed submissions", () => {
  it.each([20, 200])(
    "deduplicates a %dms Provider update and waits for actual completion despite lagging done status",
    async (delay) => {
      vi.stubGlobal("crypto", webcrypto);
      type Sandpack = ReturnType<typeof useSandpack>["sandpack"];
      type Client = Sandpack["clients"][string];
      let state!: Sandpack;
      let client!: Client;
      let handle: SandpackRuntimeSyncHandle | null = null;
      const updates: Client["sandboxSetup"][] = [];
      const listeners = new Set<Parameters<Client["listen"]>[0]>();
      loader.load.mockImplementation(async (iframe, setup, options) => {
        client = {
          iframe,
          iframeSelector: iframe,
          updateOptions() {},
          dispatch() {},
          sandboxSetup: setup,
          options,
          status: "done",
          destroy() {},
          listen(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          updateSandbox(next) {
            updates.push(next!);
          },
        } as Client;
        return client;
      });
      function ClientMount() {
        const { sandpack } = useSandpack();
        state = sandpack;
        useEffect(() => {
          const iframe = document.createElement("iframe");
          document.body.appendChild(iframe);
          void sandpack
            .registerBundler(iframe, "test-client")
            .then(() => sandpack.runSandpack());
          return () => iframe.remove();
        }, []);
        return null;
      }
      function register(value: SandpackRuntimeSyncHandle | null) {
        handle = value;
      }
      const { unmount } = render(
        <SandpackProvider
          template="static"
          customSetup={{ environment: "parcel" }}
          files={{ "index.html": "initial" }}
          options={{ autorun: false, recompileDelay: delay }}
        >
          <ClientMount />
          <SandpackRuntimeSync onChange={register} />
        </SandpackProvider>,
      );
      await waitFor(() => expect(state.status).toBe("running"));
      await act(async () => {
        state.updateFile("/index.html", "edit-A");
      });
      expect(updates.map((setup) => setup.files["/index.html"].code)).toEqual([
        "edit-A",
      ]);
      expect(client.status).toBe("done");
      expect(handle!.isSynchronized({ "index.html": "edit-A" })).toBe(false);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, delay + 20));
      });
      expect(updates).toHaveLength(1);
      await act(async () => {
        for (const listener of listeners)
          listener({ type: "done", compilatonError: false });
      });
      expect(handle!.isSynchronized({ "index.html": "edit-A" })).toBe(false);
      await act(async () => {
        for (const listener of listeners)
          listener({ type: "start", firstLoad: false });
      });
      expect(handle!.isSynchronized({ "index.html": "edit-A" })).toBe(false);
      await act(async () => {
        state.updateFile("/index.html", "edit-B");
        state.updateFile("/index.html", "edit-C");
      });
      expect(updates).toHaveLength(1);
      await act(async () => {
        for (const listener of listeners)
          listener({ type: "done", compilatonError: false });
      });
      expect(updates.map((setup) => setup.files["/index.html"].code)).toEqual([
        "edit-A",
        "edit-C",
      ]);
      expect(handle!.isSynchronized({ "index.html": "edit-C" })).toBe(false);
      await act(async () => {
        for (const type of ["start", "done"] as const)
          for (const listener of listeners)
            listener(
              type === "start"
                ? { type, firstLoad: false }
                : { type, compilatonError: false },
            );
      });
      expect(handle!.isSynchronized({ "index.html": "edit-C" })).toBe(true);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, delay + 20));
      });
      expect(updates).toHaveLength(2);
      const withDependencies = {
        ...updates[1],
        dependencies: { example: "1" },
        entry: "/index.html",
      };
      await act(async () => {
        client.updateSandbox(withDependencies);
      });
      expect(updates).toHaveLength(3);
      expect(updates[2]).toMatchObject({
        dependencies: { example: "1" },
        entry: "/index.html",
      });
      unmount();
    },
  );
});

describe("Node file delivery completion", () => {
  it("waits for matching filesystem echoes instead of a compile event that Node does not emit", async () => {
    type Sandpack = ReturnType<typeof useSandpack>["sandpack"];
    type Client = Sandpack["clients"][string];
    let state!: Sandpack;
    let handle: SandpackRuntimeSyncHandle | null = null;
    const listeners = new Set<Parameters<Client["listen"]>[0]>();
    const updates: Client["sandboxSetup"][] = [];
    const client = {
      status: "done",
      options: {},
      sandboxSetup: {} as Client["sandboxSetup"],
      listen(listener: Parameters<Client["listen"]>[0]) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      updateSandbox(setup: Client["sandboxSetup"]) {
        updates.push(setup);
      },
    };
    function MountClient() {
      const { sandpack } = useSandpack();
      state = sandpack;
      useEffect(() => {
        client.sandboxSetup = { files: sandpack.files, template: "node" };
        sandpack.clients.node = client as unknown as Client;
        return () => {
          delete sandpack.clients.node;
        };
      }, []);
      return null;
    }
    const { unmount } = render(
      <SandpackProvider
        template="static"
        customSetup={{ environment: "node" }}
        files={{ "index.html": "initial" }}
      >
        <MountClient />
        <SandpackRuntimeSync
          onChange={(value) => {
            handle = value;
          }}
        />
      </SandpackProvider>,
    );
    await act(async () => {
      state.updateFile("/index.html", "node-edit");
    });
    expect(updates).toHaveLength(1);
    expect(handle!.isSynchronized({ "index.html": "node-edit" })).toBe(false);
    await act(async () => {
      for (const listener of listeners)
        listener({ type: "fs/change", path: "/index.html", content: "stale" });
    });
    expect(handle!.isSynchronized({ "index.html": "node-edit" })).toBe(false);
    await act(async () => {
      for (const listener of listeners)
        listener({
          type: "fs/change",
          path: "/index.html",
          content: "node-edit",
        });
    });
    expect(handle!.isSynchronized({ "index.html": "node-edit" })).toBe(true);
    unmount();
  });
});

describe("preview package projection matches the real Provider", () => {
  it.each([
    { template: "vite-react" as const, command: "vite" },
    { template: "vite-react" as const, command: "vite --clearScreen false" },
    { template: "vite-react" as const, command: "node server.js" },
    { template: "static" as const, command: null },
  ])(
    "matches Provider bytes and restores source formatting for $template / $command",
    ({ template, command }) => {
      type Sandpack = ReturnType<typeof useSandpack>["sandpack"];
      type Client = Sandpack["clients"][string];
      const source =
        JSON.stringify(
          command ? { scripts: { dev: command } } : { name: "static-fixture" },
          null,
          4,
        ) + "\n";
      const files = { "package.json": source, "index.html": "<main />" };
      const projection = projectSandpackRuntime(files, true, template);
      let handle: SandpackRuntimeSyncHandle | null = null;
      let state!: Sandpack;
      function MountClient() {
        const { sandpack } = useSandpack();
        state = sandpack;
        useEffect(() => {
          const client = {
            status: "done",
            options: {},
            sandboxSetup: { files: sandpack.files, template: "node" },
            updateSandbox() {},
            listen: () => () => {},
          } as unknown as Client;
          sandpack.clients.preview = client;
          return () => {
            delete sandpack.clients.preview;
          };
        }, []);
        return null;
      }
      const { unmount } = render(
        <SandpackProvider
          template={template}
          files={projection.files}
          options={{ autorun: false }}
        >
          <MountClient />
          <SandpackRuntimeSync
            onChange={(value) => {
              handle = value;
            }}
          />
        </SandpackProvider>,
      );
      try {
        expect(state.files["/package.json"].code).toBe(
          projection.files["package.json"],
        );
        expect(handle!.isSynchronized(projection.files)).toBe(true);
        expect(files["package.json"]).toBe(source);
        expect(
          projection.restore("package.json", state.files["/package.json"].code),
        ).toBe(source);
      } finally {
        unmount();
      }
    },
  );
});

describe("capture recovery after a Node deletion", () => {
  it("rebuilds once with the exact current files when Node never acknowledges a removal", async () => {
    vi.stubGlobal("crypto", webcrypto);
    type Sandpack = ReturnType<typeof useSandpack>["sandpack"];
    type Client = Sandpack["clients"][string];
    let state!: Sandpack;
    let handle: SandpackRuntimeSyncHandle | null = null;
    const clients: Array<{ client: Client; disk: Record<string, string> }> = [];
    loader.load.mockImplementation(async (iframe, setup, options) => {
      const listeners = new Set<Parameters<Client["listen"]>[0]>();
      const disk = Object.fromEntries(
        Object.entries(setup.files as Client["sandboxSetup"]["files"]).map(
          ([path, file]) => [path, file.code],
        ),
      );
      const client = {
        iframe,
        iframeSelector: iframe,
        sandboxSetup: setup,
        options,
        status: "done",
        destroy: vi.fn(() => listeners.clear()),
        updateOptions() {},
        dispatch() {},
        listen(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        updateSandbox(next) {
          // Match running SandpackNode: write present modules, but never delete
          // omitted modules or emit a compile/done pair for file updates.
          this.sandboxSetup = next!;
          for (const [path, file] of Object.entries(next!.files)) {
            disk[path] = file.code;
            queueMicrotask(() => {
              for (const listener of listeners)
                listener({ type: "fs/change", path, content: file.code });
            });
          }
        },
      } as Client;
      clients.push({ client, disk });
      return client;
    });
    function Mount() {
      const { sandpack } = useSandpack();
      state = sandpack;
      useEffect(() => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        void sandpack
          .registerBundler(iframe, "node-capture")
          .then(() => sandpack.runSandpack());
        return () => iframe.remove();
      }, []);
      return null;
    }
    const { unmount } = render(
      <SandpackProvider
        template="static"
        customSetup={{ environment: "node" }}
        files={{ "index.html": "current", "obsolete.ts": "old" }}
        options={{ autorun: false, recompileDelay: 20 }}
      >
        <Mount />
        <SandpackRuntimeSync
          onChange={(value) => {
            handle = value;
          }}
        />
      </SandpackProvider>,
    );
    try {
      await waitFor(() => expect(state.status).toBe("running"));
      await act(async () => {
        state.deleteFile("/obsolete.ts");
      });
      const expected = { "index.html": "current" };
      expect(state.files["/obsolete.ts"]).toBeUndefined();
      expect(clients[0].disk["/obsolete.ts"]).toBe("old");
      expect(handle!.isSynchronized(expected)).toBe(false);
      const restart = vi.fn(() => handle!.restart());
      let result: Promise<void>;
      await act(async () => {
        result = waitForPreviewSynchronization({
          isReady: () => handle!.isSynchronized(expected),
          canRestart: () => true,
          restart,
          isCurrent: () => true,
          signal: new AbortController().signal,
          timeoutMs: 50,
        });
        await new Promise((resolve) => setTimeout(resolve, 170));
      });
      await act(async () => {
        await result!;
      });
      expect(restart).toHaveBeenCalledOnce();
      expect(clients).toHaveLength(2);
      expect(clients[0].client.destroy).toHaveBeenCalledOnce();
      expect(clients[1].disk["/obsolete.ts"]).toBeUndefined();
      expect(clients[1].disk["/index.html"]).toBe("current");
      expect(handle!.isSynchronized(expected)).toBe(true);
    } finally {
      unmount();
      vi.unstubAllGlobals();
    }
  });
});

describe("Runtime initialized handshake", () => {
  it("starts initial compilation before done and replaces old-document work on refresh", async () => {
    vi.stubGlobal("crypto", webcrypto);
    type Sandpack = ReturnType<typeof useSandpack>["sandpack"];
    type Client = Sandpack["clients"][string];
    let state!: Sandpack;
    let client!: Client;
    let handle: SandpackRuntimeSyncHandle | null = null;
    const updates: Array<{ setup: Client["sandboxSetup"]; initial?: boolean }> =
      [];
    const listeners = new Set<Parameters<Client["listen"]>[0]>();
    loader.load.mockImplementation(async (iframe, setup, options) => {
      client = {
        iframe,
        iframeSelector: iframe,
        sandboxSetup: setup,
        options,
        status: "initializing",
        destroy() {},
        updateOptions() {},
        dispatch() {},
        listen(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        updateSandbox(next, initial) {
          this.sandboxSetup = next!;
          updates.push({ setup: next!, initial });
        },
      } as Client;
      return client;
    });
    function Mount() {
      const { sandpack } = useSandpack();
      state = sandpack;
      useEffect(() => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        void sandpack
          .registerBundler(iframe, "cold-preview")
          .then(() => sandpack.runSandpack());
        return () => iframe.remove();
      }, []);
      return null;
    }
    const { unmount } = render(
      <SandpackProvider
        template="static"
        customSetup={{ environment: "parcel" }}
        files={{ "index.html": "initial" }}
        options={{ autorun: false, recompileDelay: 20 }}
      >
        <Mount />
        <SandpackRuntimeSync
          onChange={(value) => {
            handle = value;
          }}
        />
      </SandpackProvider>,
    );
    await waitFor(() => expect(state.status).toBe("running"));
    await act(async () => {
      state.updateFile("/index.html", "before-initialized");
    });
    expect(updates).toHaveLength(0);
    await act(async () => {
      client.updateSandbox(client.sandboxSetup, true);
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      initial: true,
      setup: { files: { "/index.html": { code: "before-initialized" } } },
    });
    expect(handle!.isSynchronized({ "index.html": "before-initialized" })).toBe(
      false,
    );
    await act(async () => {
      for (const listener of listeners)
        listener({ type: "start", firstLoad: true });
      state.updateFile("/index.html", "latest-before-refresh");
    });
    expect(updates).toHaveLength(1);
    await act(async () => {
      client.status = "initializing";
      client.updateSandbox(client.sandboxSetup, true);
    });
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      initial: true,
      setup: { files: { "/index.html": { code: "latest-before-refresh" } } },
    });
    await act(async () => {
      client.status = "done";
      for (const listener of listeners)
        listener({ type: "done", compilatonError: false });
    });
    expect(
      handle!.isSynchronized({ "index.html": "latest-before-refresh" }),
    ).toBe(false);
    await act(async () => {
      for (const listener of listeners)
        listener({ type: "start", firstLoad: true });
      for (const listener of listeners)
        listener({ type: "done", compilatonError: false });
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(
      handle!.isSynchronized({ "index.html": "latest-before-refresh" }),
    ).toBe(true);
    expect(updates).toHaveLength(2);
    unmount();
  });
});
