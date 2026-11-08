export interface BlobSaveOptions {
  preferFilePicker?: boolean;
  signal?: AbortSignal;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable(): Promise<{
      write(blob: Blob): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
  }>;
}

export async function saveBlob(
  blob: Blob,
  fileName: string,
  format: { mimeType: string; extension: string; description: string },
  options: BlobSaveOptions = {},
): Promise<boolean> {
  options.signal?.throwIfAborted();
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const [{ save }, { writeFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    options.signal?.throwIfAborted();
    const path = await save({
      defaultPath: fileName,
      filters: [{ name: format.description, extensions: [format.extension] }],
    });
    if (!path) return false;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    options.signal?.throwIfAborted();
    await writeFile(path, bytes);
    return true;
  }
  const pickerWindow = window as SaveFilePickerWindow;
  if (options.preferFilePicker && pickerWindow.showSaveFilePicker) {
    try {
      // Keep the picker before the first await so the click's user activation survives.
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: format.description,
            accept: { [format.mimeType]: [`.${format.extension}`] },
          },
        ],
      });
      options.signal?.throwIfAborted();
      const writable = await handle.createWritable();
      try {
        options.signal?.throwIfAborted();
        await writable.write(blob);
        options.signal?.throwIfAborted();
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      return true;
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError" &&
        !options.signal?.aborted
      )
        return false;
      throw error;
    }
  }
  options.signal?.throwIfAborted();
  const url = URL.createObjectURL(new Blob([blob], { type: format.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}
