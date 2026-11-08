import { useConversationStore } from "../../store/conversation";
import {
  materializeStagedProjectAssets,
  releaseMaterializedProjectAssets,
} from "../project-assets/import";
import { digestProjectSnapshot } from "../project-runtime/snapshot";
import { assessProjectRuntime } from "../project-runtime/capabilities";
import {
  PROJECT_ASSET_LIMITS,
  stageProjectAsset,
} from "../project-assets/core";
import { PROJECT_FILE_LIMITS, validateProjectFiles } from "./project-files";
import type { ProjectAssets } from "../../types";
import type {
  ProjectImportCommitResult,
  StagedProjectImport,
} from "./project-import";

/** Local integrity checks precede durable writes; compilation belongs to preview. */
export async function commitImportedProject(
  project: StagedProjectImport,
  options: { signal?: AbortSignal; isCurrent: () => boolean },
): Promise<ProjectImportCommitResult> {
  let assets: ProjectAssets | undefined;
  function assertCurrent(): void {
    options.signal?.throwIfAborted();
    if (!options.isCurrent())
      throw new Error(
        "The import was cancelled because the active project changed.",
      );
  }
  try {
    assertCurrent();
    const files = { ...project.files };
    const stagedAssets = (project.assets ?? []).map((asset) => ({ ...asset }));
    const expectedDigest = project.preflight?.digest;
    if (!expectedDigest) {
      throw new Error(
        "The project must pass local checks before it can be imported.",
      );
    }
    const checked = validateProjectFiles(files);
    if (!checked.ok) throw new Error(checked.error);
    if (checked.stats.fileCount === 0)
      throw new Error(
        "The selected project contains no importable text files.",
      );
    const digest = await digestProjectSnapshot(files, stagedAssets);
    assertCurrent();
    if (digest !== expectedDigest) {
      throw new Error(
        "The project changed after checking. Select it again before importing.",
      );
    }
    if (stagedAssets.length > PROJECT_ASSET_LIMITS.maxAssets)
      throw new Error("The project contains too many assets.");
    const paths = new Set(Object.keys(files));
    let totalBytes = checked.stats.totalBytes;
    for (const asset of stagedAssets) {
      assertCurrent();
      if (paths.has(asset.path))
        throw new Error(`Project path "${asset.path}" is duplicated.`);
      paths.add(asset.path);
      const verified = await stageProjectAsset(
        asset.path,
        asset.blob,
        asset.mimeType,
      );
      assertCurrent();
      if (
        verified.path !== asset.path ||
        verified.mimeType !== asset.mimeType ||
        verified.size !== asset.size ||
        verified.digest !== asset.digest ||
        verified.moduleDigest !== asset.moduleDigest
      ) {
        throw new Error(
          `Project asset "${asset.path}" changed after checking. Select it again before importing.`,
        );
      }
      totalBytes += verified.size;
    }
    if (totalBytes > PROJECT_FILE_LIMITS.maxTotalBytes)
      throw new Error(
        `Project files are too large in total (max ${PROJECT_FILE_LIMITS.maxTotalBytes} bytes).`,
      );
    const capabilities = assessProjectRuntime(files);
    const materialized = await materializeStagedProjectAssets(
      stagedAssets,
      files,
    );
    assets = materialized.assets;
    assertCurrent();
    const now = Date.now();
    useConversationStore.getState().addConversation({
      id: crypto.randomUUID(),
      title: project.name,
      messages: [],
      files: materialized.files,
      assets,
      template: capabilities.template,
      previewMode: capabilities.previewMode,
      activeFile: project.activeFile,
      isProjectInitialized: true,
      defaultPreviewView: "desktop",
      workspaceMode: "auto",
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true };
  } catch (error) {
    if (assets) await releaseMaterializedProjectAssets(assets);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
