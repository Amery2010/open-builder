// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { useSettingsStore } from "../../store/settings";
import { ProjectBuildDialog } from "./ProjectBuildDialog";
import { useSnapshotStore } from "../../store/snapshot";
import { ProjectBuildDownload } from "./ProjectBuildDownload";

const mocks = vi.hoisted(() => ({ build: vi.fn(), save: vi.fn() }));
vi.mock("../../lib/project-build", () => ({
  buildStaticDeployment: mocks.build,
}));
vi.mock("../../lib/project-archives/download", () => ({
  saveProjectArchive: mocks.save,
}));

async function startBuild(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Download project" }));
  await user.click(
    screen.getByRole("menuitem", { name: "Build static deployment ZIP" }),
  );
  await user.click(screen.getByRole("button", { name: "Start build" }));
  await waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());
}

describe("deployment download consistency", () => {
  beforeEach(() => {
    mocks.build.mockReset();
    mocks.save.mockReset();
    mocks.save.mockResolvedValue(true);
    useSnapshotStore.setState({ snapshots: {}, _hasHydrated: true });
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
    });
    useConversationStore.getState().createConversation();
    useConversationStore
      .getState()
      .setFiles({ "index.html": "<h1>Build me</h1>" });
  });

  function view(): void {
    const state = useConversationStore.getState();
    const project = state.conversations[state.activeId!];
    render(
      <ProjectBuildDownload
        files={project.files}
        assets={project.assets ?? {}}
        isGenerating={false}
        onDownloadSource={vi.fn(async () => undefined)}
      />,
    );
  }

  it("does not download a build after canonical files change before React props update", async () => {
    let finish!: (value: { blob: Blob }) => void;
    mocks.build.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    view();
    await startBuild();
    act(() => {
      useConversationStore
        .getState()
        .setFiles({ "index.html": "<h1>Changed while building</h1>" });
    });
    finish({ blob: new Blob(["stale output"]) });
    await screen.findByText(
      "Build cancelled. Project changes require a fresh build.",
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("cancels the underlying build when the user closes the dialog", async () => {
    let finish!: (value: { blob: Blob }) => void;
    mocks.build.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    view();
    await startBuild();
    const signal = mocks.build.mock.calls[0][0].signal as AbortSignal;
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(signal.aborted).toBe(true);
    finish({ blob: new Blob(["cancelled output"]) });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("keeps the ZIP ready until a click and retries saving without rebuilding", async () => {
    const blob = new Blob(["ready ZIP"]);
    mocks.build.mockResolvedValue({ blob });
    mocks.save
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("Disk full"))
      .mockResolvedValue(true);
    view();
    await startBuild();
    const download = await screen.findByRole("button", {
      name: "Download deployment ZIP",
    });
    expect(mocks.save).not.toHaveBeenCalled();
    await userEvent.click(download);
    expect(
      await screen.findByText(
        "Save cancelled. The deployment ZIP is still ready to download.",
      ),
    ).toBeVisible();
    await userEvent.click(download);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Download failed: Disk full",
    );
    await userEvent.click(download);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(3));
    const filename = mocks.save.mock.calls[0][1];
    expect(filename).toMatch(/^website\d+\.zip$/);
    for (const [savedBlob, savedName, options] of mocks.save.mock.calls) {
      expect(savedBlob).toBe(blob);
      expect(savedName).toBe(filename);
      expect(options.preferFilePicker).toBe(true);
    }
    expect(mocks.build).toHaveBeenCalledOnce();
  });

  it("invalidates a ready current-project artifact when canonical files change", async () => {
    mocks.build.mockResolvedValue({ blob: new Blob(["stale ZIP"]) });
    view();
    await startBuild();
    await screen.findByRole("button", { name: "Download deployment ZIP" });
    act(() => {
      useConversationStore.getState().setFiles({ "index.html": "New version" });
    });
    expect(
      screen.queryByRole("button", { name: "Download deployment ZIP" }),
    ).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Build cancelled. Project changes require a fresh build.",
      ),
    ).toBeVisible();
  });

  it("cancels a pending save after a project change", async () => {
    let finishSave!: (value: boolean) => void;
    mocks.build.mockResolvedValue({ blob: new Blob(["ZIP"]) });
    mocks.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    view();
    await startBuild();
    await userEvent.click(
      await screen.findByRole("button", { name: "Download deployment ZIP" }),
    );
    const signal = mocks.save.mock.calls[0][2].signal as AbortSignal;
    act(() => {
      useConversationStore.getState().setFiles({ "index.html": "New version" });
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finishSave(true);
    });
    expect(
      screen.queryByRole("button", { name: "Download deployment ZIP" }),
    ).not.toBeInTheDocument();
  });

  it("builds the selected snapshot and keeps it valid after current-project edits", async () => {
    const store = useConversationStore.getState();
    const id = store.activeId!;
    const files = { "index.html": "<h1>Historical version</h1>" };
    const snapshot = useSnapshotStore
      .getState()
      .createSnapshot(id, "historical-message", files)!;
    store.setFiles({ "index.html": "<h1>Latest version</h1>" });
    mocks.build.mockResolvedValue({ blob: new Blob(["historical ZIP"]) });
    render(
      <ProjectBuildDialog
        target={{
          kind: "snapshot",
          conversationId: id,
          snapshotId: snapshot.id,
        }}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start build" }));
    const download = await screen.findByRole("button", {
      name: "Download deployment ZIP",
    });
    expect(mocks.build.mock.calls[0][0].files).toEqual(files);
    act(() => {
      useConversationStore
        .getState()
        .setFiles({ "index.html": "<h1>Edited again</h1>" });
    });
    await userEvent.click(download);
    expect(mocks.save).toHaveBeenCalledOnce();
    act(() => {
      useSnapshotStore.setState({ snapshots: {} });
    });
    expect(
      screen.queryByRole("button", { name: "Download deployment ZIP" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start build" })).toBeDisabled();
  });

  it("closes and cancels a build when switching conversations", async () => {
    mocks.build.mockImplementation(() => new Promise(() => {}));
    view();
    await startBuild();
    const signal = mocks.build.mock.calls[0][0].signal as AbortSignal;
    act(() => {
      useConversationStore.getState().createConversation();
    });
    expect(signal.aborted).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("ignores a cancelled build that finishes after its replacement", async () => {
    let finishOld!: (value: { blob: Blob }) => void;
    const replacement = new Blob(["new ZIP"]);
    mocks.build
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ blob: replacement });
    view();
    await startBuild();
    await userEvent.click(screen.getByRole("button", { name: "Cancel build" }));
    await userEvent.click(screen.getByRole("button", { name: "Start build" }));
    const download = await screen.findByRole("button", {
      name: "Download deployment ZIP",
    });
    await act(async () => {
      finishOld({ blob: new Blob(["old ZIP"]) });
    });
    await userEvent.click(download);
    expect(mocks.save.mock.calls[0][0]).toBe(replacement);
  });

  it("invalidates ready output when project asset identities change", async () => {
    mocks.build.mockResolvedValue({ blob: new Blob(["ZIP"]) });
    view();
    await startBuild();
    await screen.findByRole("button", { name: "Download deployment ZIP" });
    act(() => {
      useConversationStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          [state.activeId!]: {
            ...state.conversations[state.activeId!],
            assets: {},
          },
        },
      }));
    });
    expect(
      screen.queryByRole("button", { name: "Download deployment ZIP" }),
    ).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
