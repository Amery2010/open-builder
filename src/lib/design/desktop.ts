import { invoke } from "@tauri-apps/api/core";
import type { ProjectAssets, ProjectFiles } from "../../types";
import { isTauriMcpHost } from "../mcp/tauri-host";
import { readProjectAssetBytes } from "../project-assets/core";

export interface DesignExportResult {
  path: string;
  directoryName: string;
  fileCount: number;
}

export function supportsDesktopDesignTools(): boolean {
  return isTauriMcpHost();
}

export async function exportProjectToUniqueDirectory(
  files: ProjectFiles,
  projectName: string,
  assets: ProjectAssets = {},
): Promise<DesignExportResult | null> {
  if (!isTauriMcpHost()) return null;
  const projectAssets = await Promise.all(
    Object.values(assets).map(async (asset) => ({
      path: asset.path,
      mimeType: asset.mimeType,
      bytes: Array.from(await readProjectAssetBytes(asset)),
    })),
  );
  // The native folder picker runs inside the Rust command, so the webview
  // never chooses the destination path. A cancelled dialog resolves to null.
  return invoke<DesignExportResult | null>("design_export_project", {
    projectName,
    files,
    assets: projectAssets,
  });
}
