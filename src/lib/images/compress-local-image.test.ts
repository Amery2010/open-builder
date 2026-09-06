// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  compressImageOnce: vi.fn(),
}));

vi.mock("./compression-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("./compression-core")>();
  return { ...original, compressImageOnce: coreMocks.compressImageOnce };
});

import { compressLocalImage } from "./compress-local-image";
import type {
  CompressionWorkerRequest,
  CompressionWorkerResponse,
} from "./worker-protocol";

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly listeners = {
    message: [] as Array<
      (event: MessageEvent<CompressionWorkerResponse>) => void
    >,
    error: [] as Array<() => void>,
  };
  request?: CompressionWorkerRequest;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: "message" | "error", listener: never) {
    this.listeners[type].push(listener);
  }

  postMessage(request: CompressionWorkerRequest) {
    this.request = request;
  }

  respond(
    response:
      | { status: "compressed"; file: File }
      | { status: "unchanged" }
      | { status: "unsupported" },
  ) {
    const data = {
      ...response,
      id: this.request?.id ?? "",
    } as CompressionWorkerResponse;
    this.listeners.message.forEach((listener) =>
      listener({ data } as MessageEvent<CompressionWorkerResponse>),
    );
  }

  fail() {
    this.listeners.error.forEach((listener) => listener());
  }

  terminate() {
    this.terminated = true;
  }
}

class ThrowingWorker extends FakeWorker {
  postMessage(_request: CompressionWorkerRequest) {
    throw new DOMException("The value could not be cloned.", "DataCloneError");
  }
}

function file(name = "image.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

describe("compressLocalImage worker orchestration", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.instances = [];
    coreMocks.compressImageOnce.mockReset();
    coreMocks.compressImageOnce.mockResolvedValue({ status: "unchanged" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the original object without starting work when disabled", async () => {
    const source = file();
    vi.stubGlobal("Worker", FakeWorker);

    await expect(
      compressLocalImage(source, { enabled: false, quality: 0.85 }),
    ).resolves.toBe(source);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(coreMocks.compressImageOnce).not.toHaveBeenCalled();
  });

  it("does not load compression code for unsupported image MIME types", async () => {
    const source = new File(["gif"], "animated.gif", { type: "image/gif" });
    vi.stubGlobal("Worker", FakeWorker);

    await expect(
      compressLocalImage(source, { enabled: true, quality: 0.85 }),
    ).resolves.toBe(source);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(coreMocks.compressImageOnce).not.toHaveBeenCalled();
  });

  it("returns a worker result and terminates the task worker", async () => {
    const source = file();
    const compressed = file("compressed.png");
    vi.stubGlobal("Worker", FakeWorker);
    const pending = compressLocalImage(source, {
      enabled: true,
      quality: 0.72,
    });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    expect(worker.request?.quality).toBe(0.72);
    worker.respond({ status: "compressed", file: compressed });

    await expect(pending).resolves.toBe(compressed);
    expect(worker.terminated).toBe(true);
    expect(coreMocks.compressImageOnce).not.toHaveBeenCalled();
  });

  it("falls back to the main-thread core only for worker capability failure", async () => {
    const source = file();
    const compressed = file("compressed.png");
    vi.stubGlobal("Worker", FakeWorker);
    coreMocks.compressImageOnce.mockResolvedValue({
      status: "compressed",
      file: compressed,
    });
    const pending = compressLocalImage(source, {
      enabled: true,
      quality: Number.NaN,
    });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    FakeWorker.instances[0].respond({ status: "unsupported" });

    await expect(pending).resolves.toBe(compressed);
    expect(coreMocks.compressImageOnce).toHaveBeenCalledWith(
      source,
      0.85,
      undefined,
    );
  });

  it("terminates the worker and falls back when posting the file fails", async () => {
    const source = file();
    vi.stubGlobal("Worker", ThrowingWorker);
    coreMocks.compressImageOnce.mockResolvedValue({ status: "unchanged" });

    await expect(
      compressLocalImage(source, { enabled: true, quality: 0.85 }),
    ).resolves.toBe(source);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(coreMocks.compressImageOnce).toHaveBeenCalledWith(
      source,
      0.85,
      undefined,
    );
  });

  it("uses the original object for an unchanged worker result", async () => {
    const source = file();
    vi.stubGlobal("Worker", FakeWorker);
    const pending = compressLocalImage(source, {
      enabled: true,
      quality: 0.85,
    });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    FakeWorker.instances[0].respond({ status: "unchanged" });

    await expect(pending).resolves.toBe(source);
    expect(coreMocks.compressImageOnce).not.toHaveBeenCalled();
  });

  it("serializes worker tasks", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const firstFile = file("first.png");
    const secondFile = file("second.png");
    const first = compressLocalImage(firstFile, {
      enabled: true,
      quality: 0.85,
    });
    const second = compressLocalImage(secondFile, {
      enabled: true,
      quality: 0.85,
    });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    FakeWorker.instances[0].respond({ status: "unchanged" });
    await expect(first).resolves.toBe(firstFile);
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    FakeWorker.instances[1].respond({ status: "unchanged" });
    await expect(second).resolves.toBe(secondFile);
  });

  it("terminates the worker and propagates AbortError", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new AbortController();
    const pending = compressLocalImage(
      file(),
      { enabled: true, quality: 0.85 },
      controller.signal,
    );
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("terminates a hung worker after 30 seconds and falls back", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const source = file();
    coreMocks.compressImageOnce.mockResolvedValue({ status: "unchanged" });
    const pending = compressLocalImage(source, {
      enabled: true,
      quality: 0.85,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toBe(source);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(coreMocks.compressImageOnce).toHaveBeenCalledOnce();
  });
});
