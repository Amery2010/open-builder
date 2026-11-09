import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { BUILD_STATUS_PATH, COMPATIBILITY_BUILD_SCRIPT } from "./build-script";

type Write = (bytes: Uint8Array, callback: (error?: Error) => void) => boolean;
type Child = { stdin: { write: Write } };
type Spawn = (...args: unknown[]) => Child;
type ChildProcess = { spawn: Spawn };

async function runBuildScript(
  spawn: Spawn,
  build: (getChildProcess: () => ChildProcess) => Promise<void>,
) {
  // Nodebox exports its built-ins as non-configurable, read-only getters.
  let childProcess = Object.defineProperty({}, "spawn", {
    get: () => spawn,
    enumerable: true,
  }) as ChildProcess;
  let status!: { ok: boolean; error: string | null };
  let exited!: (code: number) => void;
  const exit = new Promise<number>((resolve) => {
    exited = resolve;
  });
  runInNewContext(COMPATIBILITY_BUILD_SCRIPT, {
    require: (name: string) => {
      if (name === "fs")
        return {
          writeFileSync(path: string, content: string) {
            if (path === BUILD_STATUS_PATH) status = JSON.parse(content);
          },
        };
      if (name === "child_process") return childProcess;
      if (name === "module")
        return {
          addPatchedModule(name: string, replacement: ChildProcess) {
            expect(name).toBe("child_process");
            childProcess = replacement;
          },
        };
      if (name === "vite") return { build: () => build(() => childProcess) };
      throw new Error(`Unexpected runtime module: ${name}`);
    },
    setTimeout: (callback: () => void) => callback(),
    process: { exit: exited },
  });
  return { exitCode: await exit, status };
}

it("delivers concurrent large esbuild packets without truncation or interleaving", async () => {
  const packets = [Buffer.alloc(30_000, 120), Buffer.alloc(24_000, 121)];
  const received: Buffer[] = [];
  const child: Child = {
    stdin: {
      write(bytes, callback) {
        // Model Nodebox's stdin reader consuming a chunk with a 16 KiB buffer.
        received.push(Buffer.from(bytes.subarray(0, 16_384)));
        queueMicrotask(() => callback());
        return true;
      },
    },
  };
  const result = await runBuildScript(
    () => child,
    async (getChildProcess) => {
      const service = getChildProcess().spawn("esbuild", ["--service=0.17.19"]);
      await Promise.all(
        packets.map(
          (packet) =>
            new Promise<void>((resolve, reject) => {
              service.stdin.write(packet, (error) =>
                error ? reject(error) : resolve(),
              );
            }),
        ),
      );
      if (!Buffer.concat(received).equals(Buffer.concat(packets)))
        throw new Error(
          "The esbuild input packets were truncated or interleaved.",
        );
    },
  );
  expect(result).toEqual({ exitCode: 0, status: { ok: true, error: null } });
});

it.each(["callback", "throw"])(
  "propagates a %s write error once to queued and future packets",
  async (mode) => {
    const problem = new Error("The esbuild input pipe is closed.");
    const errors: Array<Error | undefined> = [];
    const write = vi.fn<Write>((_bytes, callback) => {
      if (mode === "throw") throw problem;
      queueMicrotask(() => callback(problem));
      return true;
    });
    const child: Child = { stdin: { write } };
    const result = await runBuildScript(
      () => child,
      async (getChildProcess) => {
        const service = getChildProcess().spawn("node", [
          "esbuild",
          "--service=0.17.19",
        ]);
        const send = () =>
          new Promise<void>((resolve) => {
            service.stdin.write(Buffer.alloc(30_000), (error) => {
              errors.push(error);
              resolve();
            });
          });
        await Promise.all([send(), send()]);
        await send();
        throw problem;
      },
    );
    expect(errors).toEqual([problem, problem, problem]);
    expect(write).toHaveBeenCalledOnce();
    expect(result).toEqual({
      exitCode: 1,
      status: { ok: false, error: problem.message },
    });
  },
);

it("preserves other child processes and both spawn argument forms", async () => {
  const child: Child = { stdin: { write: vi.fn<Write>(() => false) } };
  const originalWrite = child.stdin.write;
  const spawn = vi.fn<Spawn>(() => child);
  const calls = [
    ["tool", { stdio: "pipe" }],
    ["tool", ["--version"], { cwd: "/nodebox" }],
  ];
  await runBuildScript(spawn, async (getChildProcess) => {
    for (const args of calls) {
      const returned = getChildProcess().spawn(...args);
      expect(returned).toBe(child);
      expect(returned.stdin.write).toBe(originalWrite);
    }
  });
  expect(spawn.mock.calls).toEqual(calls);
});
