import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignCanvasLayout } from "./project-design-workspace";

const disk = vi.hoisted(() => ({
  values: new Map<string, string>(),
  read: undefined as undefined | (() => Promise<string | null>),
  failWrites: false,
  getItem: vi.fn(async (key: string): Promise<string | null> => {
    if (disk.read) return disk.read();
    return disk.values.get(key) ?? null;
  }),
  setItem: vi.fn(async (key: string, value: string) => {
    if (disk.failWrites) throw new Error("IndexedDB quota exceeded");
    disk.values.set(key, value);
  }),
  removeItem: vi.fn(async (key: string) => {
    disk.values.delete(key);
  }),
}));
vi.mock("localforage", () => ({
  default: { ...disk, createInstance: () => disk },
}));
vi.mock("../lib/design/review-jobs/runner", () => ({
  designReviewJobRunner: { removeConversation: vi.fn() },
}));

const initial: DesignCanvasLayout = {
  camera: { x: 80, y: 64, zoom: 0.5 },
  positions: { home: { x: 0, y: 0 } },
};
const key = (conversation: string, branch = "main") =>
  JSON.stringify([conversation, branch]);
let workspace: typeof import("./project-design-workspace");
const state = () => workspace.useProjectDesignWorkspaceStore.getState();

async function load() {
  workspace = await import("./project-design-workspace");
  return workspace.useProjectDesignWorkspaceStore;
}
async function ready() {
  const store = await load();
  await vi.waitFor(() => expect(store.getState()._hasHydrated).toBe(true));
  return store;
}

beforeEach(() => {
  vi.resetModules();
  disk.values.clear();
  disk.read = undefined;
  disk.failWrites = false;
  vi.clearAllMocks();
});
afterEach(async () => {
  await workspace?.useProjectDesignWorkspaceStore.persist.clearStorage();
});

describe("canvas layout persistence", () => {
  it("restores layouts while keeping selection and execution state volatile", async () => {
    disk.values.set(
      "project-design-workspace",
      JSON.stringify({
        version: 1,
        state: {
          layouts: { [key("project")]: initial },
          selections: { project: { pageId: "old", explicit: true } },
        },
      }),
    );
    await ready();
    expect(state().layouts[key("project")]).toEqual(initial);
    expect(state().selections).toEqual({});
    state().setSelection("project", {
      pageId: "home",
      explicit: true,
    });
    await vi.waitFor(() => {
      const saved = JSON.parse(disk.values.get("project-design-workspace")!);
      expect(saved).toEqual({
        state: { layouts: { [key("project")]: initial } },
        version: 1,
      });
    });
  });

  it("does not overwrite disk with defaults or volatile selection during hydration", async () => {
    let resolveRead!: (value: string | null) => void;
    disk.read = () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      });
    await load();
    expect(state().ensureLayout("project", "main", initial)).toBeUndefined();
    state().setSelection("project", { pageId: "home" });
    expect(disk.setItem).not.toHaveBeenCalled();
    const saved = { ...initial, camera: { x: 160, y: 120, zoom: 0.75 } };
    resolveRead(
      JSON.stringify({
        version: 1,
        state: { layouts: { [key("project")]: saved } },
      }),
    );
    await vi.waitFor(() => expect(state()._hasHydrated).toBe(true));
    expect(state().ensureLayout("project", "main", initial)).toEqual(saved);
    expect(state().selections.project?.pageId).toBe("home");
  });

  it("filters projects deleted while their saved layout is still loading", async () => {
    let resolveRead!: (value: string | null) => void;
    disk.read = () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      });
    await load();
    state().clearConversation("deleted");
    resolveRead(
      JSON.stringify({
        version: 1,
        state: {
          layouts: {
            [key("deleted")]: initial,
            [key("retained")]: initial,
          },
        },
      }),
    );
    await vi.waitFor(() => expect(state()._hasHydrated).toBe(true));
    expect(Object.keys(state().layouts)).toEqual([key("retained")]);
  });

  it("honors clearing all layouts before hydration finishes", async () => {
    let resolveRead!: (value: string | null) => void;
    disk.read = () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      });
    await load();
    state().clearLayouts();
    resolveRead(
      JSON.stringify({
        version: 1,
        state: { layouts: { [key("project")]: initial } },
      }),
    );
    await vi.waitFor(() => expect(state()._hasHydrated).toBe(true));
    expect(state().layouts).toEqual({});
  });

  it("inherits a parent once and keeps subsequent branch layouts independent", async () => {
    await ready();
    state().ensureLayout("project", "main", initial);
    expect(
      state().ensureLayout(
        "project",
        "branch",
        {
          ...initial,
          positions: { settings: { x: 1536, y: 0 } },
        },
        "main",
      ),
    ).toEqual({
      ...initial,
      positions: { ...initial.positions, settings: { x: 1536, y: 0 } },
    });
    state().setLayout("project", "main", {
      ...initial,
      camera: { x: 400, y: 0, zoom: 1 },
    });
    expect(state().layouts[key("project", "branch")].camera).toEqual(
      initial.camera,
    );
    expect(
      state().ensureLayout("project", "branch", initial, "main")?.camera,
    ).toEqual(initial.camera);
    expect(state().ensureLayout("fork", "main", initial)?.camera).toEqual(
      initial.camera,
    );
  });

  it("preserves newer page coordinates when a historical checkout saves fewer pages", async () => {
    await ready();
    state().ensureLayout("project", "main", {
      ...initial,
      positions: {
        home: { x: 0, y: 0 },
        detail: { x: 3000, y: 400 },
      },
    });
    state().setLayout("project", "main", {
      ...initial,
      positions: { home: { x: 100, y: 20 } },
    });
    expect(state().layouts[key("project")].positions).toEqual({
      home: { x: 100, y: 20 },
      detail: { x: 3000, y: 400 },
    });
  });

  it("drops malformed records and positions and clamps persisted zoom", async () => {
    disk.values.set(
      "project-design-workspace",
      JSON.stringify({
        version: 1,
        state: {
          layouts: {
            badKey: initial,
            [key("badCamera")]: {
              ...initial,
              camera: { x: null, y: 0, zoom: 1 },
            },
            [key("badZoom")]: { ...initial, camera: { x: 0, y: 0, zoom: -1 } },
            [key("valid")]: {
              camera: { x: 3, y: 4, zoom: 9 },
              positions: {
                home: { x: 10, y: 20 },
                broken: { x: "oops", y: 0 },
              },
            },
          },
        },
      }),
    );
    await ready();
    expect(state().layouts).toEqual({
      [key("valid")]: {
        camera: { x: 3, y: 4, zoom: 2 },
        positions: { home: { x: 10, y: 20 } },
      },
    });
  });

  it("keeps operating in memory after persistence fails and reports it", async () => {
    await ready();
    disk.failWrites = true;
    state().ensureLayout("project", "main", initial);
    await vi.waitFor(() =>
      expect(state().persistenceError).toBe("IndexedDB quota exceeded"),
    );
    state().setLayout("project", "main", {
      ...initial,
      camera: { x: 200, y: 100, zoom: 1 },
    });
    expect(state().layouts[key("project")].camera.x).toBe(200);
  });

  it("opens an editable session when IndexedDB cannot be read", async () => {
    disk.read = async () => {
      throw new Error("IndexedDB unavailable");
    };
    await ready();
    expect(state().persistenceError).toBe("IndexedDB unavailable");
    expect(state().ensureLayout("project", "main", initial)).toEqual(initial);
  });

  it("clears all branches of one conversation and rejects its late flush", async () => {
    await ready();
    state().ensureLayout("project", "main", initial);
    state().ensureLayout("project", "branch", initial);
    state().ensureLayout("other", "main", initial);
    state().setSelection("project", {
      pageId: "home",
      explicit: true,
    });
    state().clearConversation("project");
    state().setLayout("project", "main", initial);
    expect(Object.keys(state().layouts)).toEqual([key("other")]);
    expect(state().selections.project).toBeUndefined();
  });
});

describe("conversation canvas lifecycle", () => {
  it.each(["reset", "replace", "delete"] as const)(
    "clears persisted layouts and selection on %s while retaining other projects",
    async (action) => {
      await ready();
      const { useConversationStore } = await import("./conversation");
      useConversationStore.setState({ conversations: {}, activeId: null });
      const projectId = useConversationStore.getState().createConversation();
      const branchId = `${projectId}:main`;
      state().ensureLayout(projectId, branchId, initial);
      state().ensureLayout(projectId, "alternative", initial);
      state().ensureLayout("other", "main", initial);
      state().setSelection(projectId, {
        pageId: "home",
        explicit: true,
      });

      if (action === "reset") useConversationStore.getState().resetProject();
      if (action === "delete")
        useConversationStore.getState().deleteConversation(projectId);
      if (action === "replace") {
        expect(
          useConversationStore.getState().replaceProject({
            files: { "index.html": "<h1>New project</h1>" },
            template: "static",
            previewMode: "sandpack",
          }),
        ).toEqual({ ok: true });
      }
      expect(Object.keys(state().layouts)).toEqual([key("other")]);
      expect(state().selections[projectId]).toBeUndefined();
      await vi.waitFor(() => {
        const saved = JSON.parse(disk.values.get("project-design-workspace")!);
        expect(Object.keys(saved.state.layouts)).toEqual([key("other")]);
      });
    },
  );

  it("retains layouts when project replacement is rejected", async () => {
    await ready();
    const { useConversationStore } = await import("./conversation");
    useConversationStore.setState({ conversations: {}, activeId: null });
    const projectId = useConversationStore.getState().createConversation();
    state().ensureLayout(projectId, `${projectId}:main`, initial);
    expect(
      useConversationStore.getState().replaceProject({
        files: { "../outside.html": "<h1>Invalid</h1>" },
        template: "static",
        previewMode: "sandpack",
      }).ok,
    ).toBe(false);
    expect(state().layouts[key(projectId, `${projectId}:main`)]).toEqual(
      initial,
    );
  });

  it("starts a forked conversation with its own default layout", async () => {
    await ready();
    const { useConversationStore } = await import("./conversation");
    useConversationStore.setState({ conversations: {}, activeId: null });
    const original = useConversationStore.getState().createConversation();
    const moved = { ...initial, camera: { x: 700, y: 300, zoom: 1.2 } };
    state().ensureLayout(original, `${original}:main`, moved);
    const fork = useConversationStore.getState().forkConversation();
    expect(state().layouts[key(fork, `${fork}:main`)]).toBeUndefined();
    expect(state().ensureLayout(fork, `${fork}:main`, initial)).toEqual(
      initial,
    );
    expect(state().layouts[key(original, `${original}:main`)]).toEqual(moved);
  });
});
