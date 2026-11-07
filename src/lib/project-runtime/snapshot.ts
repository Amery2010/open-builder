import type { ProjectFiles } from "../../types";

export interface ProjectSnapshotAsset {
  path: string;
  digest: string;
  mimeType: string;
  size: number;
}

export async function digestProjectSnapshot(
  files: ProjectFiles,
  assets: readonly ProjectSnapshotAsset[] = [],
): Promise<string> {
  const value = JSON.stringify({
    files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
    assets: assets
      .map(({ path, digest, mimeType, size }) => ({
        path,
        digest,
        mimeType,
        size,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createRuntimeFrame(title: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0;pointer-events:none";
  document.body.append(frame);
  return frame;
}

/** Every async operation observes cancellation even when a vendor RPC cannot. */
export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason ?? new DOMException("Operation cancelled.", "AbortError"),
      );
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
