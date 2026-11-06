/** Safari/WebKit exposes synchronous OPFS writes only inside a dedicated worker. */
export async function writeOpfsFileInWorker(
  path: string[],
  value: Blob | string,
): Promise<void> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value).buffer
      : await value.arrayBuffer();
  const expectedBytes = bytes.byteLength;
  const worker = new Worker(
    new URL("./opfs-writer.worker.ts", import.meta.url),
    { type: "module" },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (
        event: MessageEvent<{
          ok: boolean;
          byteLength?: number;
          error?: string;
        }>,
      ) => {
        if (event.data?.ok && event.data.byteLength === expectedBytes)
          resolve();
        else
          reject(
            new Error(
              event.data?.error ||
                "The OPFS writer did not save the complete file.",
            ),
          );
      };
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message || "The OPFS writer failed."));
      };
      worker.onmessageerror = () =>
        reject(new Error("The OPFS writer response could not be read."));
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              "The OPFS writer did not respond. Retry saving the archive.",
            ),
          ),
        60_000,
      );
      worker.postMessage({ path, bytes }, [bytes]);
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    worker.terminate();
  }
}
