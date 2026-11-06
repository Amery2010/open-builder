import { writeOpfsFileInWorker } from "./opfs-writer";

/** Binary archive storage. The manifest and ZIP writes share one origin lock.
 * Tombstones prevent an old tab or an in-flight build from reviving deleted owners. */
const ROOT = "project-archives";
const LOCK = "open-builder-project-archives";
const ROOT_STATE = "generation.json";

type Manifest = {
  epoch: string;
  deleted?: boolean;
  refs: Record<string, string>;
  /** Hash of committed ZIP bytes, separate from the project content digest. */
  hashes?: Record<string, string>;
  revoked: string[];
  pendingDeletes?: string[];
};
export interface ArchiveTicket {
  generation: string;
  epoch: string;
}
export interface ArchiveStorage {
  capture(projectId: string, snapshotId: string): Promise<ArchiveTicket>;
  write(
    projectId: string,
    snapshotId: string,
    digest: string,
    blob: Blob,
    ticket: ArchiveTicket,
  ): Promise<Blob>;
  read(projectId: string, snapshotId: string, digest: string): Promise<Blob>;
  release(projectId: string, snapshotId: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  clear(): Promise<void>;
  estimate(): Promise<{ items: number; bytes: number }>;
}

let tail: Promise<unknown> = Promise.resolve();
function locked<T>(operation: () => Promise<T>): Promise<T> {
  const run = () => {
    if (!available()) return operation();
    if (typeof navigator.locks?.request !== "function") {
      throw new Error(
        "Project archives require Web Locks for safe shared storage in this browser.",
      );
    }
    return navigator.locks.request(LOCK, operation);
  };
  const result = tail.then(run, run);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
function available() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}
function missing(error: unknown) {
  return error instanceof Error && error.name === "NotFoundError";
}
async function root(): Promise<FileSystemDirectoryHandle> {
  if (!available())
    throw new Error("Project archives require OPFS storage in this browser.");
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, {
    create: true,
  });
}
async function readJson<T>(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(
      await (await (await dir.getFileHandle(name)).getFile()).text(),
    ) as T;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function writeBlob(
  dir: FileSystemDirectoryHandle,
  name: string,
  blob: Blob | string,
  directoryPath: string[] = [ROOT],
) {
  let existing: FileSystemFileHandle | undefined;
  try {
    existing = await dir.getFileHandle(name);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const file = existing ?? (await dir.getFileHandle(name, { create: true }));
  try {
    if (typeof file.createWritable !== "function") {
      await writeOpfsFileInWorker([...directoryPath, name], blob);
      return;
    }
    const stream = await file.createWritable();
    try {
      await stream.write(blob);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    // getFileHandle(create) itself creates an empty file. Leaving a failed first
    // manifest write behind would make the next capture parse empty JSON forever.
    if (!existing) await remove(dir, name).catch(() => undefined);
    throw error;
  }
}
async function generation(dir: FileSystemDirectoryHandle): Promise<string> {
  const existing = await readJson<{ id: string }>(dir, ROOT_STATE);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await writeBlob(dir, ROOT_STATE, JSON.stringify({ id }));
  return id;
}
function projectName(id: string) {
  return encodeURIComponent(id);
}
function manifestName(id: string) {
  return `${projectName(id)}.json`;
}
async function manifest(
  dir: FileSystemDirectoryHandle,
  id: string,
): Promise<Manifest> {
  return (
    (await readJson<Manifest>(dir, manifestName(id))) ?? {
      epoch: crypto.randomUUID(),
      refs: {},
      revoked: [],
    }
  );
}
async function saveManifest(
  dir: FileSystemDirectoryHandle,
  id: string,
  state: Manifest,
) {
  await writeBlob(dir, manifestName(id), JSON.stringify(state));
}
async function remove(
  dir: FileSystemDirectoryHandle,
  name: string,
  recursive = false,
) {
  try {
    await dir.removeEntry(name, { recursive });
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
async function entries(dir: FileSystemDirectoryHandle) {
  const result: [string, FileSystemHandle][] = [];
  for await (const entry of (
    dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
  ).entries())
    result.push(entry);
  return result;
}
async function zipHash(blob: Blob): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function assertLive(state: Manifest, snapshotId: string) {
  if (state.deleted || state.revoked.includes(snapshotId))
    throw new Error("This project version has been removed.");
}

export const opfsArchiveStorage: ArchiveStorage = {
  capture: (projectId, snapshotId) =>
    locked(async () => {
      const dir = await root();
      const state = await manifest(dir, projectId);
      assertLive(state, snapshotId);
      await saveManifest(dir, projectId, state);
      return { generation: await generation(dir), epoch: state.epoch };
    }),
  write: (projectId, snapshotId, digest, blob, ticket) =>
    locked(async () => {
      const dir = await root();
      const state = await manifest(dir, projectId);
      assertLive(state, snapshotId);
      if (
        (await generation(dir)) !== ticket.generation ||
        state.epoch !== ticket.epoch
      )
        throw new Error("Project archive storage changed while packaging.");
      const project = await dir.getDirectoryHandle(projectName(projectId), {
        create: true,
      });
      const filename = `${digest}.zip`;
      // Verify actual ZIP bytes, not just the source digest or file length.
      // Regeneration must replace a damaged file at this content-addressed path.
      const expectedHash = await zipHash(blob);
      let existing: File | undefined;
      try {
        existing = await (await project.getFileHandle(filename)).getFile();
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (
        !existing ||
        existing.size !== blob.size ||
        (await zipHash(existing)) !== expectedHash
      )
        await writeBlob(project, filename, blob, [
          ROOT,
          projectName(projectId),
        ]);
      const stored = await (await project.getFileHandle(filename)).getFile();
      if (
        stored.size === 0 ||
        stored.size !== blob.size ||
        (await zipHash(stored)) !== expectedHash
      )
        throw new Error(
          "The project archive could not be verified after saving.",
        );
      state.refs[snapshotId] = digest;
      state.pendingDeletes = state.pendingDeletes?.filter(
        (value) => value !== digest,
      );
      state.hashes = { ...state.hashes, [digest]: expectedHash };
      await saveManifest(dir, projectId, state);
      return stored.slice(0, stored.size, "application/zip");
    }),
  read: (projectId, snapshotId, digest) =>
    locked(async () => {
      const dir = await root();
      const state = await manifest(dir, projectId);
      assertLive(state, snapshotId);
      if (state.refs[snapshotId] !== digest)
        throw new Error(
          "The saved project archive is missing. Generate it again.",
        );
      const project = await dir.getDirectoryHandle(projectName(projectId));
      const file = await (
        await project.getFileHandle(`${digest}.zip`)
      ).getFile();
      if (
        !state.hashes?.[digest] ||
        (await zipHash(file)) !== state.hashes[digest]
      )
        throw new Error(
          "The saved project archive failed verification. Generate it again.",
        );
      return file.slice(0, file.size, "application/zip");
    }),
  release: (projectId, snapshotId) =>
    locked(async () => {
      if (!available()) return;
      const dir = await root();
      const state = await manifest(dir, projectId);
      const digest = state.refs[snapshotId];
      delete state.refs[snapshotId];
      if (!state.revoked.includes(snapshotId)) state.revoked.push(snapshotId);
      if (digest && !Object.values(state.refs).includes(digest)) {
        state.pendingDeletes = [
          ...new Set([...(state.pendingDeletes ?? []), digest]),
        ];
        if (state.hashes) delete state.hashes[digest];
      }
      // Persist which bytes need removing before deleting their ownership link.
      // A failed removeEntry can then be retried even after the ref is gone.
      await saveManifest(dir, projectId, state);
      for (const pending of state.pendingDeletes ?? []) {
        if (Object.values(state.refs).includes(pending)) continue;
        try {
          await remove(
            await dir.getDirectoryHandle(projectName(projectId)),
            `${pending}.zip`,
          );
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      state.pendingDeletes = [];
      await saveManifest(dir, projectId, state);
    }),
  deleteProject: (projectId) =>
    locked(async () => {
      if (!available()) return;
      const dir = await root();
      await saveManifest(dir, projectId, {
        epoch: crypto.randomUUID(),
        deleted: true,
        refs: {},
        revoked: [],
      });
      await remove(dir, projectName(projectId), true);
    }),
  clear: () =>
    locked(async () => {
      if (!available()) return;
      const dir = await root();
      await writeBlob(
        dir,
        ROOT_STATE,
        JSON.stringify({ id: crypto.randomUUID() }),
      );
      for (const [name] of await entries(dir))
        if (name !== ROOT_STATE) await remove(dir, name, true);
    }),
  estimate: () =>
    locked(async () => {
      if (!available()) return { items: 0, bytes: 0 };
      let items = 0,
        bytes = 0;
      const walk = async (dir: FileSystemDirectoryHandle): Promise<void> => {
        for (const [name, entry] of await entries(dir)) {
          if (entry.kind === "directory")
            await walk(await dir.getDirectoryHandle(name));
          else if (name.endsWith(".zip")) {
            items++;
            bytes += (await (await dir.getFileHandle(name)).getFile()).size;
          }
        }
      };
      await walk(await root());
      return { items, bytes };
    }),
};
