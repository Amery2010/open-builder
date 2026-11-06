import { projectArchiveManager } from "./service";

export async function saveProjectArchive(
  blob: Blob,
  fileName: string,
): Promise<boolean> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const [{ save }, { writeFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const path = await save({
      defaultPath: fileName,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!path) return false;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return true;
  }
  const url = URL.createObjectURL(
    new Blob([blob], { type: "application/zip" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}
export async function downloadSnapshotArchive(
  conversationId: string,
  snapshotId: string,
): Promise<boolean> {
  const { record, blob } = await projectArchiveManager.read(
    conversationId,
    snapshotId,
  );
  return saveProjectArchive(blob, record.fileName);
}
