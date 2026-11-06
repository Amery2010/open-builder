import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOpfsFileInWorker } from "./opfs-writer";

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.last = this;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("dedicated OPFS writer lifecycle", () => {
  it("transfers exact bytes to a module worker and terminates it after acknowledgement", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const pending = writeOpfsFileInWorker(
      ["project-archives", "project", "code.zip"],
      new Blob([new Uint8Array([0, 255, 4])]),
    );
    await vi.waitFor(() =>
      expect(FakeWorker.last.postMessage).toHaveBeenCalledOnce(),
    );
    const [message, transfers] = FakeWorker.last.postMessage.mock.calls[0];
    expect(message.path).toEqual(["project-archives", "project", "code.zip"]);
    expect(new Uint8Array(message.bytes)).toEqual(new Uint8Array([0, 255, 4]));
    expect(transfers).toEqual([message.bytes]);
    expect(FakeWorker.last.options).toEqual({ type: "module" });
    FakeWorker.last.onmessage!({
      data: { ok: true, byteLength: 3 },
    } as MessageEvent);
    await pending;
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it("propagates sync-handle errors and always terminates the worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const pending = writeOpfsFileInWorker(
      ["project-archives", "generation.json"],
      "metadata",
    );
    FakeWorker.last.onmessage!({
      data: { ok: false, error: "Quota full" },
    } as MessageEvent);
    await expect(pending).rejects.toThrow("Quota full");
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it("bounds an unresponsive worker without leaving an archive write pending", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const pending = writeOpfsFileInWorker(
      ["project-archives", "generation.json"],
      "metadata",
    );
    const assertion = expect(pending).rejects.toThrow("did not respond");
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
