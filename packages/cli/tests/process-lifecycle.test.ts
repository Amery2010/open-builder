import { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import spawn from "cross-spawn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyProjectTask, type VerifyResult } from "../src/node/process.js";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));

let root: string;
let child: ChildProcess;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "builder-lifecycle-")),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { build: "node task.cjs" } }),
  );
  child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  Object.defineProperty(child, "pid", { value: 12345 });
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  child.stdout?.destroy();
  child.stderr?.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function startVerification(
  options: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{
  outcome: Promise<{ result?: VerifyResult; error?: unknown }>;
}> {
  let launched!: () => void;
  const ready = new Promise<void>((resolve) => {
    launched = resolve;
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    launched();
    return child;
  });
  const outcome = verifyProjectTask(root, {
    task: "build",
    timeoutMs: 100,
    ...options,
  }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await ready;
  return { outcome };
}

describe.skipIf(process.platform === "win32")(
  "POSIX verification settlement",
  () => {
    it.each([0, 7])(
      "preserves exit code %i when cleanup crosses the execution deadline",
      async (exitCode) => {
        const { outcome } = await startVerification();
        await vi.advanceTimersByTimeAsync(90);
        child.emit("exit", exitCode, null);
        child.emit("close", exitCode, null);
        await vi.advanceTimersByTimeAsync(160);
        expect(await outcome).toMatchObject({
          result: { status: exitCode === 0 ? "passed" : "failed", exitCode },
        });
      },
    );

    it("preserves a completed result when cancellation arrives during cleanup", async () => {
      const controller = new AbortController();
      const { outcome } = await startVerification({
        signal: controller.signal,
      });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      controller.abort();
      await vi.advanceTimersByTimeAsync(160);
      expect(await outcome).toMatchObject({
        result: { status: "passed", exitCode: 0 },
      });
    });

    it("retains progress errors from buffered output after execution ends", async () => {
      const { outcome } = await startVerification({
        onProgress: () => {
          throw new Error("Observer failed");
        },
      });
      child.emit("exit", 0, null);
      child.stdout?.emit("data", Buffer.from("buffered output\n"));
      child.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(160);
      expect(await outcome).toMatchObject({
        error: { code: "PROGRESS_FAILED" },
      });
    });

    it("keeps a separate cleanup deadline when inherited streams never close", async () => {
      const { outcome } = await startVerification();
      child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await outcome).toMatchObject({
        error: { code: "PROCESS_CLEANUP_FAILED" },
      });
    });
  },
);
