// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveRecordKey,
  useProjectArchiveStore,
} from "../../store/project-archives";
import { useSettingsStore } from "../../store/settings";
import { ProjectArchiveAction } from "./ProjectArchiveCard";

const downloadSnapshotArchive = vi.hoisted(() => vi.fn());

vi.mock("../../lib/project-archives/download", () => ({
  downloadSnapshotArchive,
}));

const labels = {
  title: "Project source",
  source: "Source",
  download: "Download project ZIP",
  preparing: "Preparing project ZIP",
  failed: "Project ZIP could not be saved",
  retry: "Retry packaging",
};

function record(snapshotId: string) {
  return {
    conversationId: "conversation-1",
    snapshotId,
    fileName: `${snapshotId}.zip`,
    size: 128,
    status: "ready" as const,
    createdAt: 1,
  };
}

describe("ProjectArchiveAction", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    downloadSnapshotArchive.mockReset();
    downloadSnapshotArchive.mockResolvedValue(true);
    useProjectArchiveStore.setState({
      records: {},
      cleanup: {},
      _hasHydrated: true,
    });
  });

  it("renders a compact source action and downloads its snapshot", async () => {
    useProjectArchiveStore.setState({
      records: {
        [archiveRecordKey("conversation-1", "snapshot-1")]:
          record("snapshot-1"),
      },
    });
    const user = userEvent.setup();
    render(
      <ProjectArchiveAction
        conversationId="conversation-1"
        snapshotIds={["snapshot-1"]}
        labels={labels}
        onBuildSnapshot={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Download",
    });
    expect(button).toHaveTextContent("Download");
    await user.click(button);
    await user.click(screen.getByRole("menuitem", { name: "Download source" }));

    expect(downloadSnapshotArchive).toHaveBeenCalledWith(
      "conversation-1",
      "snapshot-1",
    );
  });

  it("offers each snapshot when one message owns multiple archives", async () => {
    useProjectArchiveStore.setState({
      records: {
        [archiveRecordKey("conversation-1", "snapshot-1")]:
          record("snapshot-1"),
        [archiveRecordKey("conversation-1", "snapshot-2")]:
          record("snapshot-2"),
      },
    });
    const user = userEvent.setup();
    render(
      <ProjectArchiveAction
        conversationId="conversation-1"
        snapshotIds={["snapshot-1", "snapshot-2"]}
        labels={labels}
        onBuildSnapshot={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Download" }));
    await user.hover(screen.getByRole("menuitem", { name: "Download source" }));
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: /snapshot-1\.zip/ }),
      ).toBeVisible(),
    );
    expect(
      screen.getByRole("menuitem", { name: /snapshot-2\.zip/ }),
    ).toBeVisible();
    act(() =>
      screen.getByRole("menuitem", { name: /snapshot-2\.zip/ }).focus(),
    );
    await user.keyboard("{Enter}");

    expect(downloadSnapshotArchive).toHaveBeenCalledWith(
      "conversation-1",
      "snapshot-2",
    );
  });
  it("selects a historical build without downloading its source archive", async () => {
    const onBuildSnapshot = vi.fn();
    render(
      <ProjectArchiveAction
        conversationId="conversation-1"
        snapshotIds={["snapshot-1"]}
        labels={labels}
        onBuildSnapshot={onBuildSnapshot}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Build static deployment ZIP" }),
    );
    expect(onBuildSnapshot).toHaveBeenCalledWith("snapshot-1");
    expect(downloadSnapshotArchive).not.toHaveBeenCalled();
  });

  it("offers each historical version under the build submenu", async () => {
    const onBuildSnapshot = vi.fn();
    render(
      <ProjectArchiveAction
        conversationId="conversation-1"
        snapshotIds={["snapshot-1", "snapshot-2"]}
        labels={labels}
        onBuildSnapshot={onBuildSnapshot}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Download" }));
    await user.hover(
      screen.getByRole("menuitem", { name: "Build static deployment ZIP" }),
    );
    const version = await screen.findByRole("menuitem", { name: "snapshot-2" });
    act(() => version.focus());
    await user.keyboard("{Enter}");
    expect(onBuildSnapshot).toHaveBeenCalledWith("snapshot-2");
    expect(downloadSnapshotArchive).not.toHaveBeenCalled();
  });
});
