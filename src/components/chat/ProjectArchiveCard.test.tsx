// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveRecordKey,
  useProjectArchiveStore,
} from "../../store/project-archives";
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
      />,
    );

    const button = screen.getByRole("button", {
      name: "Download project ZIP",
    });
    expect(button).toHaveTextContent("Source");
    await user.click(button);

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
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Download project ZIP" }),
    );
    expect(
      screen.getByRole("menuitem", { name: /snapshot-1\.zip/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: /snapshot-2\.zip/ }),
    ).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: /snapshot-2\.zip/ }));

    expect(downloadSnapshotArchive).toHaveBeenCalledWith(
      "conversation-1",
      "snapshot-2",
    );
  });
});
