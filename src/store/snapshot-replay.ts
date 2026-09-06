import { applyPatch, createPatch } from "diff";
import type { ProjectAssets, ProjectFiles, ProjectSnapshot } from "../types";

/** Reconstruct full file state by replaying snapshots up to (and including)
 *  `targetId`. Starts from the nearest preceding checkpoint when available;
 *  otherwise replays from the head of the chain. */
export function replaySnapshots(
  chain: ProjectSnapshot[],
  targetId: string,
): ProjectFiles {
  // Locate target index. If not found, replay everything (best-effort).
  let targetIdx = chain.findIndex((s) => s.id === targetId);
  if (targetIdx < 0) targetIdx = chain.length - 1;

  // Walk backwards to find the nearest checkpoint at or before targetIdx.
  let startIdx = 0;
  let files: ProjectFiles = {};
  for (let i = targetIdx; i >= 0; i--) {
    if (chain[i].kind === "checkpoint" && chain[i].fullFiles) {
      files = { ...chain[i].fullFiles! };
      startIdx = i + 1;
      break;
    }
  }

  for (let i = startIdx; i <= targetIdx; i++) {
    const snap = chain[i];
    for (const [path, content] of Object.entries(snap.addedFiles)) {
      files[path] = content;
    }
    for (const [path, patch] of Object.entries(snap.patches)) {
      const old = files[path] ?? "";
      const result = applyPatch(old, patch);
      if (typeof result === "string") {
        files[path] = result;
      }
    }
    for (const path of snap.deletedFiles) {
      delete files[path];
    }
  }
  return files;
}

/** Reconstruct the binary asset reference table at a snapshot. Asset metadata
 * is stored in full because the bytes themselves remain in Blob storage. */
export function replaySnapshotAssets(
  snapshots: ProjectSnapshot[],
  targetSnapshotId: string,
): ProjectAssets {
  const target = snapshots.find((snapshot) => snapshot.id === targetSnapshotId);
  return { ...(target?.assets ?? {}) };
}

function diffFiles(
  prevFiles: ProjectFiles,
  currentFiles: ProjectFiles,
): Pick<ProjectSnapshot, "patches" | "addedFiles" | "deletedFiles"> {
  const patches: Record<string, string> = {};
  const addedFiles: Record<string, string> = {};
  const deletedFiles: string[] = [];

  for (const [path, content] of Object.entries(currentFiles)) {
    if (!(path in prevFiles)) {
      addedFiles[path] = content;
    } else if (prevFiles[path] !== content) {
      patches[path] = createPatch(path, prevFiles[path], content);
    }
  }

  for (const path of Object.keys(prevFiles)) {
    if (!(path in currentFiles)) {
      deletedFiles.push(path);
    }
  }

  return { patches, addedFiles, deletedFiles };
}

/** Remove a snapshot and rebuild the remaining patch chain so later snapshots
 *  still replay correctly. This is more work than filtering an array, but it
 *  preserves the git-like invariant that each patch is relative to its direct
 *  predecessor. */
export function rebuildSnapshotChainWithoutSnapshot(
  chain: ProjectSnapshot[],
  snapshotId: string,
  checkpointInterval = 10,
): ProjectSnapshot[] {
  const targetIndex = chain.findIndex((snapshot) => snapshot.id === snapshotId);
  if (targetIndex < 0) return chain;

  const filesBySnapshot = new Map(
    chain.map((snapshot) => [snapshot.id, replaySnapshots(chain, snapshot.id)]),
  );
  const kept = chain.filter((snapshot) => snapshot.id !== snapshotId);

  let prevFiles: ProjectFiles = {};
  let patchesSinceCheckpoint = 0;
  return kept.map((snapshot, index) => {
    const currentFiles = filesBySnapshot.get(snapshot.id) ?? {};
    const delta = diffFiles(prevFiles, currentFiles);
    const asCheckpoint =
      index === 0 || patchesSinceCheckpoint >= checkpointInterval;
    const rebuilt: ProjectSnapshot = {
      ...snapshot,
      ...delta,
      kind: asCheckpoint ? "checkpoint" : "patch",
    };
    if (asCheckpoint) {
      rebuilt.fullFiles = { ...currentFiles };
      patchesSinceCheckpoint = 0;
    } else {
      delete rebuilt.fullFiles;
      patchesSinceCheckpoint++;
    }
    prevFiles = currentFiles;
    return rebuilt;
  });
}
