import { getAttachmentBlob } from "../attachments/store";
import { useConversationStore } from "../../store/conversation";
import type { ProjectAsset, ProjectAssets, ProjectFiles } from "../../types";
import {
  addProjectAssetModules,
  createProjectAssetRecord,
  normalizeProjectAssetPath,
  releaseUnreferencedProjectAssetBlobs,
  stageProjectAsset,
  storeStagedProjectAsset,
  type StagedProjectAsset,
} from "./core";

export interface ImportGeneratedImageAssetInput {
  conversationId: string;
  /** Opaque id in the existing attachment Blob domain. */
  imageId: string;
  mimeType: string;
  name: string;
  /** Defaults to public/generated/<sanitized name>. */
  path?: string;
}

export interface ImportGeneratedImageAssetResult {
  asset: ProjectAsset;
  modulePath: string;
  publicPath: string;
}

function safeFileName(name: string, mimeType: string): string {
  const fallbackExtension =
    mimeType === "image/png"
      ? "png"
      : mimeType === "image/webp"
        ? "webp"
        : "jpg";
  const rawBase = (name.split(/[\\/]/).pop() || "generated-image")
    .replace(/\.(?:png|jpe?g|webp)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${rawBase || "generated-image"}.${fallbackExtension}`;
}

export async function importGeneratedImageAsset(
  input: ImportGeneratedImageAssetInput,
): Promise<ImportGeneratedImageAssetResult> {
  const conversation =
    useConversationStore.getState().conversations[input.conversationId];
  if (!conversation) throw new Error("The target conversation does not exist.");
  if (!conversation.isProjectInitialized) {
    throw new Error(
      "Initialize the project before importing a generated image.",
    );
  }
  const path = normalizeProjectAssetPath(
    input.path ??
      `public/generated/${safeFileName(input.name, input.mimeType)}`,
  );
  if (conversation.files[path] !== undefined || conversation.assets?.[path]) {
    throw new Error(`Project path "${path}" already exists.`);
  }
  const blob = await getAttachmentBlob(input.imageId);
  if (!blob)
    throw new Error("The generated image is no longer available locally.");

  const staged = await stageProjectAsset(path, blob, input.mimeType);
  const blobRef = await storeStagedProjectAsset(staged);
  const asset = createProjectAssetRecord(staged, blobRef);
  const result = useConversationStore
    .getState()
    .addProjectAsset(input.conversationId, asset);
  if (!result.ok) {
    await releaseMaterializedProjectAssets({ [asset.path]: asset });
    throw new Error(result.error);
  }
  return { asset, modulePath: asset.modulePath, publicPath: asset.publicPath };
}

export async function materializeStagedProjectAssets(
  stagedAssets: readonly StagedProjectAsset[],
  files: ProjectFiles,
): Promise<{ assets: ProjectAssets; files: ProjectFiles }> {
  const assets: ProjectAssets = {};
  try {
    for (const staged of stagedAssets) {
      if (assets[staged.path] || files[staged.path] !== undefined) {
        throw new Error(`Project path "${staged.path}" is duplicated.`);
      }
      const blobRef = await storeStagedProjectAsset(staged);
      assets[staged.path] = createProjectAssetRecord(staged, blobRef);
    }
    return { assets, files: addProjectAssetModules(files, assets) };
  } catch (error) {
    await releaseMaterializedProjectAssets(assets);
    throw error;
  }
}

export async function releaseMaterializedProjectAssets(
  assets: ProjectAssets,
): Promise<void> {
  const { useSnapshotStore } = await import("../../store/snapshot");
  const state = useConversationStore.getState();
  await releaseUnreferencedProjectAssetBlobs(
    Object.values(assets).map((asset) => asset.blobRef),
    [
      ...Object.values(state.conversations).map(
        (conversation) => conversation.assets,
      ),
      ...Object.values(useSnapshotStore.getState().snapshots)
        .flat()
        .map((snapshot) => snapshot.assets),
    ],
  );
}
