// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { useSettingsStore } from "../../store/settings";
import { ProjectBuildDownload } from "./ProjectBuildDownload";

const mocks = vi.hoisted(() => ({ build: vi.fn(), save: vi.fn() }));
vi.mock("../../lib/project-build", () => ({
  buildStaticDeployment: mocks.build,
}));
vi.mock("file-saver", () => ({ saveAs: mocks.save }));

async function startBuild(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Download project" }));
  await user.click(
    screen.getByRole("menuitem", { name: "Build static deployment ZIP" }),
  );
  await user.click(screen.getByRole("button", { name: "Build and download" }));
  await waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());
}

describe("deployment download consistency", () => {
  beforeEach(() => {
    mocks.build.mockReset();
    mocks.save.mockReset();
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
    useConversationStore
      .getState()
      .setFiles({ "index.html": "<h1>Changed while building</h1>" });
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
});
