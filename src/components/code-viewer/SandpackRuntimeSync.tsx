import { useEffect, useRef } from "react";
import { useSandpack } from "@codesandbox/sandpack-react";
import { loadSandpackClient } from "@codesandbox/sandpack-client";
import type { ProjectFiles } from "../../types";

type Sandpack = ReturnType<typeof useSandpack>["sandpack"];
type Client = Sandpack["clients"][string];
type Setup = Client["sandboxSetup"];

export interface SandpackCompilationState {
  status: "starting" | "compiling" | "ready" | "synced" | "failed";
  detail?: string;
  /** Mount-local identity of the clients supplying this result. */
  runtime?: object;
}

export interface SandpackRuntimeSyncHandle {
  isSynchronized: (expected: ProjectFiles) => boolean;
  restart: () => Promise<void>;
  bootstrapIsolatedPreview: (
    frame: HTMLIFrameElement,
    signal: AbortSignal,
  ) => Promise<() => void>;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        equalValue(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}
function copySetup(setup: Setup): Setup {
  return {
    ...setup,
    files: Object.fromEntries(
      Object.entries(setup.files).map(([path, file]) => [path, { ...file }]),
    ),
    ...(setup.dependencies ? { dependencies: { ...setup.dependencies } } : {}),
    ...(setup.devDependencies
      ? { devDependencies: { ...setup.devDependencies } }
      : {}),
  };
}
function filesEqual(left: Setup["files"], right: Setup["files"]): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((path) => left[path].code === right[path]?.code)
  );
}
interface Delivery {
  submitted: Setup;
  completed: Setup | null;
  completedBy: "compilation" | "file-ack";
  inFlight: boolean;
  started: boolean;
  error: string | null;
  pending: {
    setup: Setup;
    options: Client["options"];
    initial?: boolean;
  } | null;
  flush: () => void;
  restore: () => void;
}

/** Repairs skipped writes while serializing Provider and repair submissions. */
export function SandpackRuntimeSync({
  onChange,
  expectedFiles,
  onCompilationChange,
}: {
  onChange?: (handle: SandpackRuntimeSyncHandle | null) => void;
  expectedFiles?: ProjectFiles;
  onCompilationChange?: (state: SandpackCompilationState) => void;
}) {
  const { sandpack, listen } = useSandpack();
  const deliveries = useRef(new Map<Client, Delivery>());
  const latest = useRef(sandpack);
  latest.current = sandpack;
  const reconcileRef = useRef<(() => void) | null>(null);
  const isolatedClients = useRef(new Set<() => void>());
  const compilationObserver = useRef({ expectedFiles, onCompilationChange });
  compilationObserver.current = { expectedFiles, onCompilationChange };
  const observedRuntime = useRef({ clients: [] as Client[], identity: {} });
  const expectedInput = useRef({
    files: expectedFiles,
    providerFiles: sandpack.files,
    awaitingProvider: false,
  });
  const previousInput = expectedInput.current;
  if (
    expectedFiles !== previousInput.files &&
    !equalValue(expectedFiles, previousInput.files)
  ) {
    previousInput.awaitingProvider =
      sandpack.files === previousInput.providerFiles;
    previousInput.files = expectedFiles;
  }
  if (sandpack.files !== previousInput.providerFiles)
    previousInput.awaitingProvider = false;
  previousInput.providerFiles = sandpack.files;

  useEffect(() => {
    onChange?.({
      restart: () => latest.current.runSandpack(),
      async bootstrapIsolatedPreview(frame, signal) {
        signal.throwIfAborted();
        const source = Object.values(latest.current.clients)[0];
        if (!source) throw new Error("The preview client is unavailable.");
        const setup = copySetup(source.sandboxSetup);
        const options = {
          ...source.options,
          ...(source.options.externalResources
            ? { externalResources: [...source.options.externalResources] }
            : {}),
          ...(source.options.customNpmRegistries
            ? {
                customNpmRegistries: source.options.customNpmRegistries.map(
                  (registry) => ({ ...registry }),
                ),
              }
            : {}),
        };
        let client: Awaited<ReturnType<typeof loadSandpackClient>> | undefined;
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          signal.removeEventListener("abort", dispose);
          isolatedClients.current.delete(dispose);
          client?.destroy();
        };
        isolatedClients.current.add(dispose);
        signal.addEventListener("abort", dispose, { once: true });
        try {
          client = await loadSandpackClient(frame, setup, options);
          // Client construction imports a runtime asynchronously and cannot be
          // cancelled. A client that arrives after abort/unmount is never kept.
          if (disposed) {
            client.destroy();
            throw (
              signal.reason ??
              new DOMException("Preview runtime was removed.", "AbortError")
            );
          }
          signal.throwIfAborted();
          return dispose;
        } catch (error) {
          dispose();
          throw error;
        }
      },
      isSynchronized(expected) {
        const current = latest.current;
        if (
          !Object.entries(expected).every(
            ([path, code]) =>
              current.files[`/${path.replace(/^\/+/, "")}`]?.code === code,
          )
        )
          return false;
        const clients = Object.values(current.clients);
        return (
          clients.length > 0 &&
          clients.every((client) => {
            const delivery = deliveries.current.get(client);
            return (
              client.status === "done" &&
              delivery &&
              !delivery.error &&
              !delivery.inFlight &&
              !delivery.pending &&
              delivery.completed !== null &&
              filesEqual(delivery.completed.files, current.files)
            );
          })
        );
      },
    });
    return () => onChange?.(null);
  }, [onChange]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function notify(): void {
      queueMicrotask(() => reconcileRef.current?.());
    }
    function publishCompilation(clients: Client[]): void {
      const { expectedFiles: expected, onCompilationChange: publish } =
        compilationObserver.current;
      if (!publish) return;
      if (
        clients.length !== observedRuntime.current.clients.length ||
        clients.some(
          (client, index) => client !== observedRuntime.current.clients[index],
        )
      ) {
        observedRuntime.current = { clients, identity: {} };
      }
      const runtime = observedRuntime.current.identity;
      const current = latest.current;
      const matchesExpected =
        !expected ||
        Object.entries(expected).every(
          ([path, code]) =>
            current.files[`/${path.replace(/^\/+/, "")}`]?.code === code,
        );
      if (
        expectedInput.current.awaitingProvider ||
        !matchesExpected ||
        clients.length === 0
      ) {
        publish({ status: "starting", runtime });
        return;
      }
      const records = clients.map((client) => deliveries.current.get(client));
      const failed = records.find(
        (record) =>
          record?.error &&
          !record.pending &&
          filesEqual(record.submitted.files, current.files),
      );
      if (failed?.error) {
        publish({ status: "failed", detail: failed.error, runtime });
      } else if (
        clients.every((client, index) => {
          const record = records[index];
          return (
            client.status === "done" &&
            record &&
            !record.inFlight &&
            !record.pending &&
            record.completed &&
            filesEqual(record.completed.files, current.files)
          );
        })
      ) {
        publish({
          status: records.some((record) => record?.completedBy === "file-ack")
            ? "synced"
            : "ready",
          runtime,
        });
      } else {
        publish({
          runtime,
          status: clients.every((client) => client.status === "initializing")
            ? "starting"
            : "compiling",
        });
      }
    }
    function attach(client: Client): Delivery {
      const original = client.updateSandbox;
      let submittedOptions = { ...client.options };
      let fileAcks = new Map<string, string | undefined>();
      const initial = copySetup(client.sandboxSetup);
      // Runtime may finish before it is registered with the Provider. Its own
      // cached errors belong to this client, unlike the Provider's global error.
      const initialErrors =
        "errors" in client && Array.isArray(client.errors) ? client.errors : [];
      const initialError = initialErrors.length
        ? String(initialErrors[0]?.message || "Sandpack compilation failed.")
        : null;
      const delivery: Delivery = {
        submitted: initial,
        completed: client.status === "done" && !initialError ? initial : null,
        completedBy: "compilation",
        inFlight: client.status !== "done",
        started: true, // Initial compilation can start before registration.
        error: initialError,
        pending: null,
        flush() {
          if (!delivery.pending) return;
          // Runtime's initialized handshake starts the first compile. It must
          // also replace work from the previous document after a refresh.
          if (
            !delivery.pending.initial &&
            (delivery.inFlight || client.status !== "done")
          )
            return;
          const next = delivery.pending;
          delivery.pending = null;
          if (
            !next.initial &&
            equalValue(next.setup, delivery.submitted) &&
            equalValue(next.options, submittedOptions)
          )
            return;
          const previous = delivery.submitted;
          fileAcks = new Map();
          for (const path of new Set([
            ...Object.keys(previous.files),
            ...Object.keys(next.setup.files),
          ])) {
            const code = next.setup.files[path]?.code;
            if (previous.files[path]?.code !== code) fileAcks.set(path, code);
          }
          delivery.submitted = next.setup;
          delivery.error = null;
          if (next.initial) delivery.completed = null;
          submittedOptions = next.options;
          delivery.inFlight = true;
          delivery.started =
            next.setup.template === "static" || next.setup.template === "node";
          try {
            original.call(client, next.setup, next.initial);
          } catch (error) {
            delivery.inFlight = false;
            delivery.completed = null;
            throw error;
          }
        },
        restore() {
          unsubscribe();
          if (client.updateSandbox === observeUpdate)
            client.updateSandbox = original;
        },
      };
      function complete(completedBy: Delivery["completedBy"]): void {
        if (!delivery.inFlight) return;
        delivery.completed = delivery.error ? null : delivery.submitted;
        delivery.completedBy = completedBy;
        delivery.inFlight = false;
        fileAcks.clear();
        notify();
      }
      const unsubscribe = client.listen((message) => {
        // A removed client's late messages never update its replacement.
        if (!Object.values(latest.current.clients).includes(client)) return;
        if (message.type === "action" && message.action === "show-error") {
          delivery.error = message.message || "Sandpack compilation failed.";
          notify();
        } else if (
          message.type === "action" &&
          message.action === "notification" &&
          message.notificationType === "error"
        ) {
          delivery.error = message.title || "Sandpack compilation failed.";
          notify();
        }
        if (!delivery.inFlight) return;
        if (
          message.type === "start" ||
          (message.type === "status" && message.status !== "done")
        ) {
          delivery.started = true;
          notify();
        }
        if (message.type === "done" && delivery.started) {
          if (message.compilatonError)
            delivery.error ||= "Sandpack compilation failed.";
          complete("compilation");
        }
        // Node's running shell writes files directly: it emits fs/change rather
        // than another compile/done pair. Wait for each changed file's echo.
        if (delivery.submitted.template === "node" && fileAcks.size > 0) {
          if (
            message.type === "fs/change" &&
            fileAcks.has(message.path) &&
            fileAcks.get(message.path) === message.content
          )
            fileAcks.delete(message.path);
          if (
            message.type === "fs/remove" &&
            fileAcks.has(message.path) &&
            fileAcks.get(message.path) === undefined
          )
            fileAcks.delete(message.path);
          if (fileAcks.size === 0) complete("file-ack");
        }
      });
      const observeUpdate: typeof client.updateSandbox = (
        setup,
        isInitializationCompile,
      ) => {
        const next = copySetup({
          ...(delivery.pending?.setup ?? delivery.submitted),
          ...(setup ?? client.sandboxSetup),
          ...(isInitializationCompile
            ? {
                files: latest.current.files,
                template: latest.current.environment,
              }
            : {}),
        });
        const options = { ...client.options };
        if (
          !isInitializationCompile &&
          equalValue(next, delivery.submitted) &&
          equalValue(options, submittedOptions)
        )
          return;
        delivery.pending = {
          setup: next,
          options,
          initial: isInitializationCompile,
        };
        delivery.flush();
      };
      client.updateSandbox = observeUpdate;
      return delivery;
    }
    function reconcile(): void {
      if (disposed) return;
      clearTimeout(timer);
      const current = latest.current;
      const clients = Object.values(current.clients);
      for (const [client, delivery] of deliveries.current) {
        if (!clients.includes(client)) {
          delivery.restore();
          deliveries.current.delete(client);
        }
      }
      for (const client of clients) {
        let delivery = deliveries.current.get(client);
        if (!delivery) {
          delivery = attach(client);
          deliveries.current.set(client, delivery);
        }
        const desired = delivery.pending?.setup ?? delivery.submitted;
        if (!filesEqual(desired.files, current.files)) {
          const setup = {
            ...desired,
            files: current.files,
            template: current.environment,
          };
          if (delivery.pending)
            delivery.pending = { ...delivery.pending, setup: copySetup(setup) };
          client.updateSandbox(setup);
        }
        delivery.flush();
      }
      publishCompilation(clients);
      // Poll only for asynchronously installed clients, never to infer completion.
      if (
        clients.length === 0 &&
        current.status !== "timeout" &&
        current.status !== "idle"
      )
        timer = setTimeout(reconcile, 50);
    }
    reconcileRef.current = reconcile;
    const unsubscribe = listen(notify);
    reconcile();
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      reconcileRef.current = null;
    };
  }, [
    sandpack.files,
    sandpack.environment,
    expectedFiles,
    onCompilationChange,
    listen,
  ]);
  useEffect(() => {
    const records = deliveries.current;
    const temporary = isolatedClients.current;
    return () => {
      for (const dispose of temporary) dispose();
      for (const record of records.values()) record.restore();
      records.clear();
    };
  }, []);
  return null;
}
