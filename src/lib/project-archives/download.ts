import { projectArchiveManager } from "./service";
import { saveBlob, type BlobSaveOptions } from "../utils/save-blob";

export function saveProjectArchive(
  blob: Blob,
  fileName: string,
  options: BlobSaveOptions = {},
): Promise<boolean> {
  return saveBlob(
    blob,
    fileName,
    { mimeType: "application/zip", extension: "zip", description: "ZIP" },
    options,
  );
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
