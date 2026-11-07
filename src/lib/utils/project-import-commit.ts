import { useConversationStore } from "../../store/conversation";
import {
  materializeStagedProjectAssets,
  releaseMaterializedProjectAssets,
} from "../project-assets/import";
import { digestProjectSnapshot } from "../project-runtime/snapshot";
import type { ProjectAssets } from "../../types";
import type {
  ProjectImportCommitResult,
  StagedProjectImport,
} from "./project-import";

/** Validation precedes durable writes; the existing Conversation is never replaced. */
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
    const validation = project.validation;
    if (
      !validation ||
      !validation.capabilities.preview.supported ||
      validation.previewMode !== "sandpack"
    ) {
      throw new Error(
        "The project must pass Sandpack verification before it can be imported.",
      );
    }
    const digest = await digestProjectSnapshot(files, stagedAssets);
    assertCurrent();
    if (
      digest !== validation.digest ||
      validation.template !== project.template
    ) {
      throw new Error(
        "The project changed after verification. Verify it again before importing.",
      );
    }
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
      template: validation.template,
      previewMode: "sandpack",
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
