import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { useSnapshotStore } from "../../store/snapshot";
import { useProjectArchiveStore } from "../../store/project-archives";
import { projectArchiveManager, startProjectArchiveLifecycle } from "./service";
import type { ProjectSnapshot } from "../../types";
vi.mock("localforage", () => {
  const store = () => ({
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  });
  return { default: { ...store(), createInstance: store } };
});
let cleanup: (() => void) | undefined;
const snap = (id: string, conversationId: string): ProjectSnapshot => ({
  id,
  conversationId,
  messageId: id,
  patches: {},
  addedFiles: {},
  deletedFiles: [],
  createdAt: 1,
  kind: "checkpoint",
  fullFiles: { "index.html": id },
});
beforeEach(async () => {
  await Promise.all([
    useConversationStore.persist.rehydrate(),
    useSnapshotStore.persist.rehydrate(),
    useProjectArchiveStore.persist.rehydrate(),
  ]);
  useConversationStore.setState({
    conversations: {},
    activeId: null,
    _hasHydrated: true,
  });
  useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
  useProjectArchiveStore.setState({
    records: {},
    cleanup: {},
    _hasHydrated: true,
  });
});
afterEach(() => {
  cleanup?.();
  vi.restoreAllMocks();
});
describe("archive lifecycle", () => {
  it("leaves hydrated historical versions lazy and automatically queues every new version", () => {
    const id = useConversationStore.getState().createConversation();
    useSnapshotStore.setState({ snapshots: { [id]: [snap("old", id)] } });
    const ensure = vi.spyOn(projectArchiveManager, "ensure").mockResolvedValue({
      conversationId: id,
      snapshotId: "new",
      status: "ready",
      fileName: "project.zip",
      size: 1,
      createdAt: 1,
    });
    cleanup = startProjectArchiveLifecycle();
    expect(ensure).not.toHaveBeenCalled();
    useSnapshotStore.setState({
      snapshots: {
        [id]: [snap("old", id), { ...snap("new", id), kind: "patch" }],
      },
    });
    expect(ensure).toHaveBeenCalledExactlyOnceWith(id, "new");
    useSnapshotStore.setState({
      snapshots: {
        [id]: [snap("old", id), { ...snap("new", id), label: "renamed" }],
      },
    });
    expect(ensure).toHaveBeenCalledOnce();
  });
  it("recovers a persisted new-schema checkpoint with no archive record after restart", () => {
    const id = useConversationStore.getState().createConversation();
    useSnapshotStore.setState({
      snapshots: {
        [id]: [
          snap("legacy", id),
          { ...snap("interrupted", id), parentSnapshotId: null },
        ],
      },
    });
    const ensure = vi.spyOn(projectArchiveManager, "ensure").mockResolvedValue({
      conversationId: id,
      snapshotId: "interrupted",
      status: "ready",
      fileName: "project.zip",
      size: 1,
      createdAt: 1,
    });
    cleanup = startProjectArchiveLifecycle();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(id, "interrupted");
  });
  it("queues new-schema versions created before all owner stores finish hydration", () => {
    const id = useConversationStore.getState().createConversation();
    useProjectArchiveStore.setState({ _hasHydrated: false });
    const ensure = vi.spyOn(projectArchiveManager, "ensure").mockResolvedValue({
      conversationId: id,
      snapshotId: "new",
      status: "ready",
      fileName: "project.zip",
      size: 1,
      createdAt: 1,
    });
    cleanup = startProjectArchiveLifecycle();
    useSnapshotStore.setState({
      snapshots: { [id]: [{ ...snap("new", id), parentSnapshotId: null }] },
    });
    expect(ensure).not.toHaveBeenCalled();
    useProjectArchiveStore.setState({ _hasHydrated: true });
    expect(ensure).toHaveBeenCalledExactlyOnceWith(id, "new");
  });
  it("resumes pending records while leaving a failed archive available for manual retry", () => {
    const id = useConversationStore.getState().createConversation();
    useSnapshotStore.setState({
      snapshots: {
        [id]: [
          { ...snap("pending", id), parentSnapshotId: null },
          { ...snap("failed", id), parentSnapshotId: "pending" },
        ],
      },
    });
    for (const status of ["pending", "failed"] as const)
      useProjectArchiveStore.getState().put({
        conversationId: id,
        snapshotId: status,
        status,
        fileName: "project.zip",
        size: 0,
        createdAt: 1,
      });
    const ensure = vi.spyOn(projectArchiveManager, "ensure").mockResolvedValue({
      conversationId: id,
      snapshotId: "pending",
      status: "ready",
      fileName: "project.zip",
      size: 1,
      createdAt: 1,
    });
    cleanup = startProjectArchiveLifecycle();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(id, "pending");
  });
  it("releases removed snapshots while retaining hidden branch checkpoints", () => {
    const id = useConversationStore.getState().createConversation();
    useSnapshotStore.setState({
      snapshots: { [id]: [snap("old", id), snap("head", id)] },
    });
    const release = vi
      .spyOn(projectArchiveManager, "release")
      .mockResolvedValue();
    cleanup = startProjectArchiveLifecycle();
    useSnapshotStore.setState({
      snapshots: { [id]: [{ ...snap("head", id), hidden: true }] },
    });
    expect(release).toHaveBeenCalledExactlyOnceWith(id, "old");
  });
  it("retries a persisted cleanup task even when the source and archive record are gone", () => {
    useProjectArchiveStore.getState().putCleanup({
      id: "orphan",
      kind: "project",
      conversationId: "gone",
      createdAt: 1,
      error: "previous failure",
    });
    const remove = vi
      .spyOn(projectArchiveManager, "deleteProject")
      .mockResolvedValue();
    cleanup = startProjectArchiveLifecycle();
    expect(remove).toHaveBeenCalledExactlyOnceWith("gone");
  });
  it("removes all project archives when their conversation owner disappears", () => {
    const id = useConversationStore.getState().createConversation();
    useSnapshotStore.setState({ snapshots: { [id]: [snap("old", id)] } });
    const remove = vi
      .spyOn(projectArchiveManager, "deleteProject")
      .mockResolvedValue();
    cleanup = startProjectArchiveLifecycle();
    useConversationStore.setState({ conversations: {}, activeId: null });
    expect(remove).toHaveBeenCalledExactlyOnceWith(id);
  });
});
