import { invoke } from "@tauri-apps/api/core";
import type { ProjectFiles } from "../../types";
import { isTauriMcpHost } from "../mcp/tauri-host";

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
): Promise<DesignExportResult | null> {
  if (!isTauriMcpHost()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const parentPath = await open({ directory: true, multiple: false });
  if (typeof parentPath !== "string") return null;
  return invoke<DesignExportResult>("design_export_project", {
    parentPath,
    projectName,
    files,
  });
}
