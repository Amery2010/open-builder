interface SyncAccessHandle {
  truncate(size: number): void;
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}
interface WriteRequest {
  path: string[];
  bytes: ArrayBuffer;
}
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WriteRequest>) => void) | null;
  postMessage(response: {
    ok: boolean;
    byteLength?: number;
    error?: string;
  }): void;
};
scope.onmessage = (event) => {
  void (async () => {
    const { path, bytes } = event.data;
    if (
      !Array.isArray(path) ||
      path.length < 2 ||
      path[0] !== "project-archives" ||
      path.some(
        (part) => !part || part === "." || part === ".." || part.includes("/"),
      )
    ) {
      throw new Error("Invalid project archive storage path.");
    }
    let directory = await navigator.storage.getDirectory();
    for (const part of path.slice(0, -1))
      directory = await directory.getDirectoryHandle(part, { create: true });
    const file = await directory.getFileHandle(path[path.length - 1], {
      create: true,
    });
    const open = (
      file as unknown as {
        createSyncAccessHandle?: () => Promise<SyncAccessHandle>;
      }
    ).createSyncAccessHandle;
    if (!open)
      throw new Error("This browser does not provide an OPFS file writer.");
    const handle = await open.call(file);
    const writeAll = (content: Uint8Array) => {
      handle.truncate(0);
      let written = 0;
      while (written < content.length) {
        const count = handle.write(content.subarray(written), { at: written });
        if (
          !Number.isInteger(count) ||
          count <= 0 ||
          count > content.length - written
        )
          throw new Error("The OPFS writer could not finish writing the file.");
        written += count;
      }
      handle.flush();
    };
    try {
      // SyncAccessHandle writes in place. Preserve small ownership manifests so
      // an ordinary quota/write failure does not destroy the state needed to retry.
      let previous: Uint8Array | undefined;
      if (path[path.length - 1].endsWith(".json")) {
        previous = new Uint8Array(handle.getSize());
        let offset = 0;
        while (offset < previous.length) {
          const count = handle.read(previous.subarray(offset), { at: offset });
          if (
            !Number.isInteger(count) ||
            count <= 0 ||
            count > previous.length - offset
          )
            throw new Error(
              "The previous OPFS metadata could not be read safely.",
            );
          offset += count;
        }
      }
      try {
        writeAll(new Uint8Array(bytes));
      } catch (error) {
        if (previous) {
          try {
            writeAll(previous);
          } catch {
            throw new Error(
              "OPFS metadata could not be saved or restored. Clear project archive storage before retrying.",
            );
          }
        }
        throw error;
      }
    } finally {
      handle.close();
    }
    scope.postMessage({ ok: true, byteLength: bytes.byteLength });
  })().catch((error: unknown) =>
    scope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};
export {};
