import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const write = vi.fn();
const truncate = vi.fn();
const flush = vi.fn();
const close = vi.fn();
const getSize = vi.fn(() => 0);
const read = vi.fn(() => 0);
const open = vi.fn(async () => ({
  write,
  truncate,
  flush,
  close,
  getSize,
  read,
}));
const post = vi.fn();
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  const directory = {
    getDirectoryHandle: vi.fn(async () => directory),
    getFileHandle: vi.fn(async () => ({ createSyncAccessHandle: open })),
  };
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => directory },
  });
  vi.stubGlobal("onmessage", null);
  vi.stubGlobal("postMessage", post);
});
afterEach(() => vi.unstubAllGlobals());
async function send(path: string[], bytes: ArrayBuffer) {
  await import("./opfs-writer.worker");
  const scope = globalThis as unknown as {
    onmessage(event: MessageEvent): void;
  };
  scope.onmessage({ data: { path, bytes } } as MessageEvent);
  await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
}
describe("OPFS SyncAccessHandle worker", () => {
  it("handles partial writes, truncates old content, flushes and closes before acknowledging", async () => {
    write.mockImplementation((bytes: Uint8Array) => Math.min(2, bytes.length));
    await send(
      ["project-archives", "project", "code.zip"],
      new Uint8Array([1, 2, 3, 4, 5]).buffer,
    );
    expect(truncate).toHaveBeenCalledExactlyOnceWith(0);
    expect(write.mock.calls.map((call) => call[1].at)).toEqual([0, 2, 4]);
    expect(flush).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(
      post.mock.invocationCallOrder[0],
    );
    expect(post).toHaveBeenCalledWith({ ok: true, byteLength: 5 });
  });
  it("closes the handle and reports a failed write instead of looping", async () => {
    write.mockReturnValue(0);
    await send(["project-archives", "code.zip"], new Uint8Array([1]).buffer);
    expect(close).toHaveBeenCalledOnce();
    expect(flush).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({
      ok: false,
      error: "The OPFS writer could not finish writing the file.",
    });
  });
  it("restores previous manifest bytes when a quota error interrupts its replacement", async () => {
    const original = new TextEncoder().encode('{"epoch":"original","refs":{}}');
    let stored = original.slice();
    getSize.mockImplementation(() => stored.length);
    read.mockImplementation((...args: unknown[]) => {
      const target = args[0] as Uint8Array;
      target.set(stored);
      return stored.length;
    });
    truncate.mockImplementation((size: number) => {
      stored = stored.slice(0, size);
    });
    write
      .mockImplementationOnce(() => {
        throw new DOMException("Quota full", "QuotaExceededError");
      })
      .mockImplementation((value: Uint8Array) => {
        stored = value.slice();
        return value.length;
      });
    await send(
      ["project-archives", "project.json"],
      new TextEncoder().encode('{"epoch":"changed"}').buffer,
    );
    expect(stored).toEqual(original);
    expect(close).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ ok: false, error: "Quota full" });
  });
  it("rejects paths outside the archive domain", async () => {
    await send(["other-storage", "private"], new ArrayBuffer(0));
    expect(open).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({
      ok: false,
      error: "Invalid project archive storage path.",
    });
  });
});
