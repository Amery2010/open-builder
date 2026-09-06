import JSZip from "jszip";
import type { ProjectAssets, ProjectFiles } from "../../types";
import { readProjectAssetBytes } from "./core";

export async function buildProjectZip(
  files: ProjectFiles,
  assets: ProjectAssets = {},
): Promise<Blob> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  for (const asset of Object.values(assets)) {
    zip.file(asset.path, await readProjectAssetBytes(asset));
  }
  return zip.generateAsync({ type: "blob" });
}
