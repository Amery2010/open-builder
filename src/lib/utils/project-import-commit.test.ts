import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { useSnapshotStore } from "../../store/snapshot";
import { digestProjectSnapshot } from "../project-runtime/snapshot";
import { commitImportedProject } from "./project-import-commit";
import type { StagedProjectImport } from "./project-import";

const mocks = vi.hoisted(() => ({ materialize: vi.fn(), release: vi.fn() }));
vi.mock("../project-assets/import", () => ({
  materializeStagedProjectAssets: mocks.materialize,
  releaseMaterializedProjectAssets: mocks.release,
}));
vi.mock("localforage", () => {
  const values = new Map();
  const adapter = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: unknown) => values.set(key, value),
    removeItem: async (key: string) => values.delete(key),
    iterate: async () => undefined,
  };
  return { default: { ...adapter, createInstance: () => adapter } };
});

async function fixture(): Promise<StagedProjectImport> {
  const files = { "index.html": "<h1>Imported</h1>" };
  return {
    name: "Imported project",
    files,
    template: "static",
    previewMode: "sandpack",
    activeFile: "index.html",
    report: {
      importedFiles: 1,
      totalBytes: 17,
      redactedFiles: 0,
      skipped: { ignored: 0, sensitive: 0, binary: 0, symlink: 0 },
    },
    validation: {
      digest: await digestProjectSnapshot(files),
      template: "static",
      previewMode: "sandpack",
      capabilities: {
        template: "static",
        previewMode: "sandpack",
        preview: { supported: true },
        staticBuild: { supported: true },
      },
    },
  };
}

describe("validated project import commit", () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
    });
    useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
    mocks.materialize.mockReset();
    mocks.materialize.mockImplementation(async (_assets, files) => ({
      assets: {},
      files,
    }));
    mocks.release.mockReset();
  });

  it("creates a separate conversation and preserves the original project and messages", async () => {
    const sourceId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({ "original.js": "original" });
    useConversationStore
      .getState()
      .setMessages([{ role: "user", content: "keep this history" }]);
    const original = useConversationStore.getState().conversations[sourceId];
    const snapshots = useSnapshotStore.getState().snapshots;
    const project = await fixture();
    expect(
      await commitImportedProject(project, { isCurrent: () => true }),
    ).toEqual({ ok: true });
    const state = useConversationStore.getState();
    expect(state.activeId).not.toBe(sourceId);
    expect(state.conversations[sourceId]).toBe(original);
    expect(useSnapshotStore.getState().snapshots).toBe(snapshots);
    expect(state.conversations[state.activeId!]).toMatchObject({
      title: project.name,
      files: project.files,
      messages: [],
      previewMode: "sandpack",
    });
  });

  it("rejects missing or stale compilation evidence before materializing assets", async () => {
    const project = await fixture();
    expect(
      await commitImportedProject(
        { ...project, validation: undefined },
        { isCurrent: () => true },
      ),
    ).toMatchObject({ ok: false });
    expect(
      await commitImportedProject(
        { ...project, files: { "index.html": "changed after verification" } },
        { isCurrent: () => true },
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed after verification"),
    });
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(useConversationStore.getState().conversations).toEqual({});
  });

  it("does not create an empty conversation on cancellation or storage failure", async () => {
    const project = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await commitImportedProject(project, {
        signal: controller.signal,
        isCurrent: () => true,
      }),
    ).toMatchObject({ ok: false });
    expect(mocks.materialize).not.toHaveBeenCalled();
    mocks.materialize.mockRejectedValueOnce(new Error("Storage unavailable"));
    expect(
      await commitImportedProject(project, { isCurrent: () => true }),
    ).toMatchObject({ ok: false, error: "Storage unavailable" });
    expect(useConversationStore.getState().activeId).toBeNull();
    expect(useConversationStore.getState().conversations).toEqual({});
  });

  it("rechecks cancellation after asynchronous materialization", async () => {
    const project = await fixture();
    let current = true;
    mocks.materialize.mockImplementationOnce(async (_assets, files) => {
      current = false;
      return { assets: {}, files };
    });
    expect(
      await commitImportedProject(project, { isCurrent: () => current }),
    ).toMatchObject({ ok: false });
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(useConversationStore.getState().conversations).toEqual({});
  });
});
