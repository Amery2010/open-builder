import type { ProjectAssets, ProjectFiles, ProjectSnapshot } from "../../types";
import { useConversationStore } from "../../store/conversation";
import { useSnapshotStore } from "../../store/snapshot";
import {
  archiveRecordKey,
  useProjectArchiveStore,
  type ProjectArchiveRecord,
  type ProjectArchiveCleanupTask,
} from "../../store/project-archives";
import { buildProjectZip } from "../project-assets/archive";
import { opfsArchiveStorage, type ArchiveStorage } from "./opfs";

export interface ArchiveSource {
  title: string;
  snapshot: ProjectSnapshot;
  files: ProjectFiles;
  assets: ProjectAssets;
}
interface ArchiveManagerOptions {
  storage: ArchiveStorage;
  source(conversationId: string, snapshotId: string): ArchiveSource | undefined;
  records(): Record<string, ProjectArchiveRecord>;
  put(record: ProjectArchiveRecord): void;
  remove(keys: string[]): void;
  build?: typeof buildProjectZip;
  cleanupTasks?(): Record<string, ProjectArchiveCleanupTask>;
  putCleanup?(task: ProjectArchiveCleanupTask): void;
  removeCleanup?(ids: string[]): void;
}
export function projectArchiveFileName(
  title: string,
  snapshot: Pick<ProjectSnapshot, "id" | "createdAt">,
): string {
  const name =
    title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 80) || "project";
  const date = new Date(snapshot.createdAt).toISOString().replace(/[:.]/g, "-");
  const version =
    snapshot.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "version";
  return `${name}-${date}-${version}.zip`;
}
async function contentDigest(source: ArchiveSource): Promise<string> {
  const text = JSON.stringify({
    files: Object.entries(source.files).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    assets: Object.entries(source.assets)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, asset]) => [path, asset.path, asset.digest, asset.size]),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

export class ProjectArchiveManager {
  private pending = new Map<string, Promise<ProjectArchiveRecord>>();
  private builds = new Map<string, Promise<Blob>>();
  private cleanups = new Map<string, Promise<void>>();
  private epoch = 0;
  private revoked = new Set<string>();
  private deletedProjects = new Set<string>();
  constructor(private readonly options: ArchiveManagerOptions) {}

  ensure(
    conversationId: string,
    snapshotId: string,
  ): Promise<ProjectArchiveRecord> {
    const key = archiveRecordKey(conversationId, snapshotId);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = this.create(conversationId, snapshotId).finally(() => {
      if (this.pending.get(key) === work) this.pending.delete(key);
    });
    this.pending.set(key, work);
    return work;
  }

  private async create(
    conversationId: string,
    snapshotId: string,
  ): Promise<ProjectArchiveRecord> {
    const key = archiveRecordKey(conversationId, snapshotId);
    const epoch = this.epoch;
    let record = this.options.records()[key];
    try {
      const found = this.options.source(conversationId, snapshotId);
      if (this.revoked.has(key) || this.deletedProjects.has(conversationId))
        throw new Error("This project version no longer exists.");
      const source = found && {
        ...found,
        files: { ...found.files },
        assets: Object.fromEntries(
          Object.entries(found.assets).map(([path, asset]) => [
            path,
            { ...asset },
          ]),
        ),
      };
      if (!source) throw new Error("This project version no longer exists.");
      record ??= {
        conversationId,
        snapshotId,
        branchId: source.snapshot.branchId,
        fileName: projectArchiveFileName(source.title, source.snapshot),
        size: 0,
        status: "pending",
        createdAt: source.snapshot.createdAt,
      };
      const ticket = await this.options.storage.capture(
        conversationId,
        snapshotId,
      );
      if (record?.status === "ready" && record.contentDigest) {
        try {
          const saved = await this.options.storage.read(
            conversationId,
            snapshotId,
            record.contentDigest,
          );
          if (saved.size === record.size && saved.size > 0) return record;
        } catch {
          /* The OPFS data may have been cleared; regenerate from the exact version. */
        }
      }
      record = {
        conversationId,
        snapshotId,
        branchId: source.snapshot.branchId,
        fileName:
          record?.fileName ??
          projectArchiveFileName(source.title, source.snapshot),
        size: 0,
        status: "pending",
        createdAt: source.snapshot.createdAt,
      };
      const live = () =>
        epoch === this.epoch &&
        !this.revoked.has(key) &&
        !this.deletedProjects.has(conversationId) &&
        Boolean(this.options.source(conversationId, snapshotId));
      if (!live()) throw new Error("This project version no longer exists.");
      this.options.put(record);
      const digest = await contentDigest(source);
      const buildKey = JSON.stringify([conversationId, digest]);
      let build = this.builds.get(buildKey);
      if (!build) {
        build = (async () => {
          const reusable = Object.values(this.options.records()).find(
            (item) =>
              item.conversationId === conversationId &&
              item.contentDigest === digest &&
              item.status === "ready",
          );
          if (reusable) {
            try {
              return await this.options.storage.read(
                conversationId,
                reusable.snapshotId,
                digest,
              );
            } catch {
              /* Rebuild a missing archive from its authoritative source. */
            }
          }
          return (this.options.build ?? buildProjectZip)(
            source.files,
            source.assets,
          );
        })();
        this.builds.set(buildKey, build);
        void build
          .finally(() => {
            if (this.builds.get(buildKey) === build)
              this.builds.delete(buildKey);
          })
          .catch(() => undefined);
      }
      const blob = await build;
      if (!live())
        throw new Error("This project version was removed while packaging.");
      const saved = await this.options.storage.write(
        conversationId,
        snapshotId,
        digest,
        blob,
        ticket,
      );
      if (!live()) {
        await this.release(conversationId, snapshotId);
        throw new Error("This project version was removed while packaging.");
      }
      const ready: ProjectArchiveRecord = {
        ...record,
        contentDigest: digest,
        size: saved.size,
        status: "ready",
      };
      this.options.put(ready);
      return ready;
    } catch (error) {
      // A strict reconstruction failure must still be visible and retryable.
      const message = error instanceof Error ? error.message : String(error);
      const fallback: ProjectArchiveRecord = record ?? {
        conversationId,
        snapshotId,
        fileName: "project.zip",
        size: 0,
        createdAt: Date.now(),
        status: "failed",
      };
      const failed: ProjectArchiveRecord = {
        ...fallback,
        status: "failed",
        error: message,
      };
      let retained = true;
      try {
        retained = Boolean(this.options.source(conversationId, snapshotId));
      } catch {
        /* A corrupt retained version still needs an error card. */
      }
      if (
        epoch === this.epoch &&
        retained &&
        !this.revoked.has(key) &&
        !this.deletedProjects.has(conversationId)
      )
        this.options.put(failed);
      throw error;
    }
  }

  async read(
    conversationId: string,
    snapshotId: string,
  ): Promise<{ record: ProjectArchiveRecord; blob: Blob }> {
    const record = await this.ensure(conversationId, snapshotId);
    const blob = await this.options.storage.read(
      conversationId,
      snapshotId,
      record.contentDigest!,
    );
    if (blob.size !== record.size)
      throw new Error(
        "The saved project archive is incomplete. Generate it again.",
      );
    return { record, blob };
  }
  private runCleanup(
    task: ProjectArchiveCleanupTask,
    operation: () => Promise<void>,
  ): Promise<void> {
    const existing = this.cleanups.get(task.id);
    if (existing) return existing;
    // Keep both the task and archive metadata until OPFS cleanup succeeds.
    // The task also covers in-flight archives which have no metadata yet.
    this.options.putCleanup?.(task);
    const pending = operation()
      .then(
        () => {
          this.options.removeCleanup?.([task.id]);
        },
        (cause: unknown) => {
          this.options.putCleanup?.({
            ...task,
            error: cause instanceof Error ? cause.message : String(cause),
          });
          throw cause;
        },
      )
      .finally(() => {
        if (this.cleanups.get(task.id) === pending)
          this.cleanups.delete(task.id);
      });
    this.cleanups.set(task.id, pending);
    return pending;
  }
  release(conversationId: string, snapshotId: string): Promise<void> {
    const key = archiveRecordKey(conversationId, snapshotId);
    this.revoked.add(key);
    return this.runCleanup(
      {
        id: JSON.stringify(["snapshot", conversationId, snapshotId]),
        kind: "snapshot",
        conversationId,
        snapshotId,
        createdAt: Date.now(),
      },
      async () => {
        await this.options.storage.release(conversationId, snapshotId);
        this.options.remove([key]);
      },
    );
  }
  deleteProject(conversationId: string): Promise<void> {
    this.deletedProjects.add(conversationId);
    return this.runCleanup(
      {
        id: JSON.stringify(["project", conversationId]),
        kind: "project",
        conversationId,
        createdAt: Date.now(),
      },
      async () => {
        await this.options.storage.deleteProject(conversationId);
        this.options.remove(
          Object.keys(this.options.records()).filter(
            (key) =>
              this.options.records()[key].conversationId === conversationId,
          ),
        );
        const snapshotTasks = Object.values(this.options.cleanupTasks?.() ?? {})
          .filter(
            (task) =>
              task.kind === "snapshot" &&
              task.conversationId === conversationId,
          )
          .map((task) => task.id);
        this.options.removeCleanup?.(snapshotTasks);
      },
    );
  }
  clear(): Promise<void> {
    this.epoch++;
    this.pending.clear();
    this.builds.clear();
    return this.runCleanup(
      { id: "all", kind: "all", createdAt: Date.now() },
      async () => {
        await this.options.storage.clear();
        this.options.remove(Object.keys(this.options.records()));
        this.options.removeCleanup?.(
          Object.keys(this.options.cleanupTasks?.() ?? {}),
        );
      },
    );
  }
  async retryCleanup(): Promise<void> {
    const tasks = Object.values(this.options.cleanupTasks?.() ?? {});
    if (tasks.some((task) => task.kind === "all")) {
      await this.clear();
      return;
    }
    await Promise.all(
      tasks.map((task) =>
        task.kind === "snapshot"
          ? this.release(task.conversationId, task.snapshotId)
          : task.kind === "project"
            ? this.deleteProject(task.conversationId)
            : Promise.resolve(),
      ),
    );
  }
}

function source(
  conversationId: string,
  snapshotId: string,
): ArchiveSource | undefined {
  const conversation =
    useConversationStore.getState().conversations[conversationId];
  const store = useSnapshotStore.getState();
  const snapshot = store.snapshots[conversationId]?.find(
    (entry) => entry.id === snapshotId,
  );
  if (!conversation || !snapshot) return undefined;
  return {
    title: conversation.title,
    snapshot,
    files: store.reconstructFiles(conversationId, snapshotId),
    assets: store.reconstructAssets(conversationId, snapshotId),
  };
}
export const projectArchiveManager = new ProjectArchiveManager({
  storage: opfsArchiveStorage,
  source,
  records: () => useProjectArchiveStore.getState().records,
  put: (record) => useProjectArchiveStore.getState().put(record),
  remove: (keys) => useProjectArchiveStore.getState().remove(keys),
  cleanupTasks: () => useProjectArchiveStore.getState().cleanup,
  putCleanup: (task) => useProjectArchiveStore.getState().putCleanup(task),
  removeCleanup: (ids) => useProjectArchiveStore.getState().removeCleanup(ids),
});
export const ensureSnapshotArchive = (
  conversationId: string,
  snapshotId: string,
) => projectArchiveManager.ensure(conversationId, snapshotId);
export const clearProjectArchiveStorage = () => projectArchiveManager.clear();
export const retryProjectArchiveCleanup = () =>
  projectArchiveManager.retryCleanup();
export const estimateProjectArchiveStorage = async () => {
  const estimate = await opfsArchiveStorage.estimate();
  const failed = Object.values(
    useProjectArchiveStore.getState().cleanup,
  ).filter((task) => task.error).length;
  return {
    ...estimate,
    ...(failed > 0
      ? { error: `${failed} project archive cleanup operation(s) need retry.` }
      : {}),
  };
};

/** Mount once at the app boundary. Hydration establishes a baseline: old versions
 * stay lazy, while interrupted pending work is resumed and new versions enqueue. */
export function startProjectArchiveLifecycle(): () => void {
  let initialized = false;
  let previous = new Map<string, ProjectSnapshot>();
  let projects = new Set<string>();
  const report = (promise: Promise<unknown>) => {
    void promise.catch((error) =>
      console.warn(
        "Project archive operation failed:",
        error instanceof Error ? error.message : String(error),
      ),
    );
  };
  const update = () => {
    const conv = useConversationStore.getState();
    const snaps = useSnapshotStore.getState();
    const archives = useProjectArchiveStore.getState();
    if (!conv._hasHydrated || !snaps._hasHydrated || !archives._hasHydrated)
      return;
    const current = new Map<string, ProjectSnapshot>();
    for (const [id, chain] of Object.entries(snaps.snapshots)) {
      if (conv.conversations[id])
        for (const snapshot of chain)
          current.set(archiveRecordKey(id, snapshot.id), snapshot);
    }
    const currentProjects = new Set(Object.keys(conv.conversations));
    if (!initialized) {
      initialized = true;
      previous = current;
      projects = currentProjects;
      report(projectArchiveManager.retryCleanup());
      for (const [key, snapshot] of current) {
        // New immutable versions carry a durable marker even if the process
        // stopped before an archive request record could be persisted.
        if (snapshot.parentSnapshotId !== undefined && !archives.records[key])
          report(ensureSnapshotArchive(snapshot.conversationId, snapshot.id));
      }
      for (const record of Object.values(archives.records)) {
        if (!currentProjects.has(record.conversationId))
          report(projectArchiveManager.deleteProject(record.conversationId));
        else if (
          !current.has(
            archiveRecordKey(record.conversationId, record.snapshotId),
          )
        )
          report(
            projectArchiveManager.release(
              record.conversationId,
              record.snapshotId,
            ),
          );
        else if (record.status === "pending")
          report(
            ensureSnapshotArchive(record.conversationId, record.snapshotId),
          );
      }
      return;
    }
    const removedProjects = [...projects].filter(
      (id) => !currentProjects.has(id),
    );
    const removed = [...previous].filter(([key]) => !current.has(key));
    const added = [...current].filter(([key]) => !previous.has(key));
    // Update before invoking stores, since metadata publication is synchronous.
    previous = current;
    projects = currentProjects;
    for (const id of removedProjects)
      report(projectArchiveManager.deleteProject(id));
    for (const [, snapshot] of removed)
      if (!removedProjects.includes(snapshot.conversationId))
        report(
          projectArchiveManager.release(snapshot.conversationId, snapshot.id),
        );
    for (const [, snapshot] of added)
      report(ensureSnapshotArchive(snapshot.conversationId, snapshot.id));
  };
  const unsubscribers = [
    useConversationStore.subscribe(update),
    useSnapshotStore.subscribe(update),
    useProjectArchiveStore.subscribe(update),
  ];
  const hydration = [
    useConversationStore.persist.onFinishHydration(update),
    useSnapshotStore.persist.onFinishHydration(update),
    useProjectArchiveStore.persist.onFinishHydration(update),
  ];
  update();
  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    hydration.forEach((unsubscribe) => unsubscribe());
  };
}
