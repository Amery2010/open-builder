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
  /** Cancels the copy before it can commit to project authority. */
  signal?: AbortSignal;
  /** Host run/currentness guard. Return false after Stop, run replacement, or
   * any other authority change that is not represented by project state. */
  isCurrent?: () => boolean;
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

function abortError(signal: AbortSignal | undefined, message: string): Error {
  if (signal?.aborted && signal.reason instanceof Error) return signal.reason;
  return new DOMException(message, "AbortError");
}

function assertImportCurrent(
  input: ImportGeneratedImageAssetInput,
  expectedConversation: object,
): void {
  if (input.signal?.aborted) {
    throw abortError(input.signal, "The project image import was cancelled.");
  }
  if (input.isCurrent && !input.isCurrent()) {
    throw abortError(
      input.signal,
      "The project image import is no longer current.",
    );
  }
  const current =
    useConversationStore.getState().conversations[input.conversationId];
  if (current !== expectedConversation) {
    throw abortError(
      input.signal,
      "The project changed while importing the image.",
    );
  }
}

export async function importGeneratedImageAsset(
  input: ImportGeneratedImageAssetInput,
): Promise<ImportGeneratedImageAssetResult> {
  const conversation =
    useConversationStore.getState().conversations[input.conversationId];
  if (!conversation) throw new Error("The target conversation does not exist.");
  assertImportCurrent(input, conversation);
  if (!conversation.isProjectInitialized) {
    throw new Error(
      "Initialize the project before importing a generated image.",
    );
  }
  const path = normalizeProjectAssetPath(
    input.path ??
      `public/generated/${safeFileName(input.name, input.mimeType)}`,
  );
  if (!path.startsWith("public/")) {
    throw new Error(
      "Generated images must be imported below public/ so their exported URL remains stable.",
    );
  }
  if (conversation.files[path] !== undefined || conversation.assets?.[path]) {
    throw new Error(`Project path "${path}" already exists.`);
  }
  const blob = await getAttachmentBlob(input.imageId);
  assertImportCurrent(input, conversation);
  if (!blob)
    throw new Error("The generated image is no longer available locally.");

  let materialized: ProjectAssets = {};
  try {
    const staged = await stageProjectAsset(path, blob, input.mimeType);
    assertImportCurrent(input, conversation);
    const blobRef = await storeStagedProjectAsset(staged);
    const asset = createProjectAssetRecord(staged, blobRef);
    materialized = { [asset.path]: asset };
    assertImportCurrent(input, conversation);
    const result = useConversationStore
      .getState()
      .addProjectAsset(input.conversationId, asset);
    if (!result.ok) throw new Error(result.error);
    return {
      asset,
      modulePath: asset.modulePath,
      publicPath: asset.publicPath,
    };
  } catch (error) {
    if (Object.keys(materialized).length > 0) {
      try {
        await releaseMaterializedProjectAssets(materialized);
      } catch (cleanupError) {
        console.warn(
          "Failed to release a cancelled project image import:",
          cleanupError,
        );
      }
    }
    throw error;
  }
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
  const [{ useSnapshotStore }, { useProjectTemplateStore }] = await Promise.all(
    [import("../../store/snapshot"), import("../../store/project-templates")],
  );
  await releaseUnreferencedProjectAssetBlobs(
    Object.values(assets).map((asset) => asset.blobRef),
    () => {
      const conversations = useConversationStore.getState();
      const snapshots = useSnapshotStore.getState();
      const templates = useProjectTemplateStore.getState();
      if (
        !conversations._hasHydrated ||
        !snapshots._hasHydrated ||
        !templates._hasHydrated
      ) {
        return null;
      }
      return [
        ...Object.values(conversations.conversations).map(
          (conversation) => conversation.assets,
        ),
        ...Object.values(snapshots.snapshots)
          .flat()
          .map((snapshot) => snapshot.assets),
        ...Object.values(templates.templates).map(
          (template) => template.assets,
        ),
      ];
    },
  );
}
