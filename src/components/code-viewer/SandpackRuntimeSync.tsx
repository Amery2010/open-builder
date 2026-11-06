import { useEffect, useRef } from "react";
import { useSandpack } from "@codesandbox/sandpack-react";
import type { ProjectFiles } from "../../types";

type Sandpack = ReturnType<typeof useSandpack>["sandpack"];
type Client = Sandpack["clients"][string];
type Setup = Client["sandboxSetup"];

export interface SandpackRuntimeSyncHandle {
  isSynchronized: (expected: ProjectFiles) => boolean;
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
  inFlight: boolean;
  started: boolean;
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
}: {
  onChange?: (handle: SandpackRuntimeSyncHandle | null) => void;
}) {
  const { sandpack, listen } = useSandpack();
  const deliveries = useRef(new Map<Client, Delivery>());
  const latest = useRef(sandpack);
  latest.current = sandpack;
  const reconcileRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onChange?.({
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
    function attach(client: Client): Delivery {
      const original = client.updateSandbox;
      let submittedOptions = { ...client.options };
      let fileAcks = new Map<string, string | undefined>();
      const initial = copySetup(client.sandboxSetup);
      const delivery: Delivery = {
        submitted: initial,
        completed: client.status === "done" ? initial : null,
        inFlight: client.status !== "done",
        started: true, // Initial compilation can start before registration.
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
      function complete(): void {
        if (!delivery.inFlight) return;
        delivery.completed = delivery.submitted;
        delivery.inFlight = false;
        fileAcks.clear();
        notify();
      }
      const unsubscribe = client.listen((message) => {
        if (!delivery.inFlight) return;
        if (
          message.type === "start" ||
          (message.type === "status" && message.status !== "done")
        )
          delivery.started = true;
        if (message.type === "done" && delivery.started) complete();
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
          if (fileAcks.size === 0) complete();
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
  }, [sandpack.files, sandpack.environment, listen]);
  useEffect(() => {
    const records = deliveries.current;
    return () => {
      for (const record of records.values()) record.restore();
      records.clear();
    };
  }, []);
  return null;
}
