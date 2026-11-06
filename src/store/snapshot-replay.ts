import { applyPatch, createPatch } from "diff";
import type { ProjectAssets, ProjectFiles, ProjectSnapshot } from "../types";

/** Follow explicit branch ancestry, retaining the linear interpretation for legacy records. */
export function snapshotLineage(
  chain: ProjectSnapshot[],
  targetId: string,
): ProjectSnapshot[] {
  const byId = new Map(chain.map((snapshot) => [snapshot.id, snapshot]));
  const reversed: ProjectSnapshot[] = [];
  const seen = new Set<string>();
  let id: string | null = targetId;
  while (id !== null) {
    if (seen.has(id))
      throw new Error("Project snapshot ancestry contains a cycle.");
    seen.add(id);
    const snapshot = byId.get(id);
    if (!snapshot) throw new Error(`Project snapshot "${id}" does not exist.`);
    if (snapshot.parentSnapshotId === undefined) {
      return [
        ...chain.slice(0, chain.indexOf(snapshot) + 1),
        ...reversed.reverse(),
      ];
    }
    reversed.push(snapshot);
    id = snapshot.parentSnapshotId;
  }
  return reversed.reverse();
}

/** Reconstruct full file state by replaying snapshots up to (and including)
 *  `targetId`. Starts from the nearest preceding checkpoint when available;
 *  otherwise replays from the head of the chain. */
export function replaySnapshots(
  chain: ProjectSnapshot[],
  targetId: string,
): ProjectFiles {
  chain = snapshotLineage(chain, targetId);
  const targetIdx = chain.length - 1;

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
      if (typeof result !== "string")
        throw new Error(
          `Cannot reconstruct snapshot "${snap.id}": invalid patch for "${path}".`,
        );
      files[path] = result;
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
  if (!target)
    throw new Error(`Project snapshot "${targetSnapshotId}" does not exist.`);
  return { ...(target.assets ?? {}) };
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
  _checkpointInterval = 10,
): ProjectSnapshot[] {
  const targetIndex = chain.findIndex((snapshot) => snapshot.id === snapshotId);
  if (targetIndex < 0) return chain;

  const filesBySnapshot = new Map(
    chain.map((snapshot) => [snapshot.id, replaySnapshots(chain, snapshot.id)]),
  );
  const kept = chain.filter((snapshot) => snapshot.id !== snapshotId);

  // Re-anchor each surviving version independently. Content and IDs stay immutable,
  // and deleting an ancestor cannot make another branch depend on a missing patch.
  return kept.map((snapshot) => ({
    ...snapshot,
    ...diffFiles({}, filesBySnapshot.get(snapshot.id)!),
    kind: "checkpoint" as const,
    fullFiles: filesBySnapshot.get(snapshot.id),
    parentSnapshotId:
      snapshot.parentSnapshotId === snapshotId
        ? chain[targetIndex].parentSnapshotId !== undefined
          ? chain[targetIndex].parentSnapshotId
          : (chain[targetIndex - 1]?.id ?? null)
        : snapshot.parentSnapshotId,
  }));
}
