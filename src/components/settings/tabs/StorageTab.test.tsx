// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMemoryStore } from "../../../store/memory";
import { useConversationStore } from "../../../store/conversation";
import { useProjectTemplateStore } from "../../../store/project-templates";
import { useSettingsStore } from "../../../store/settings";
import { systemDefaults } from "../../../store/settings/system";
import { useSkillsStore } from "../../../store/skills";
import { useSnapshotStore } from "../../../store/snapshot";
import { StorageTab } from "./StorageTab";

vi.mock("../../../lib/storage/registry", () => ({
  estimateStorageDomains: vi.fn(async () => ({
    mcp: { bytes: 0, items: 0 },
    designSystems: { bytes: 512, items: 2 },
    attachments: { bytes: 0, items: 0 },
    projectAssets: { bytes: 1536, items: 3 },
    projectArchives: { bytes: 1024, items: 1 },
    designWorkspace: { bytes: 1024, items: 4 },
  })),
}));

vi.mock("../../../lib/utils/storage-governance", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../../lib/utils/storage-governance")
    >();
  return {
    ...original,
    analyzeStorage: () => ({
      totalBytes: 0,
      conversations: {
        count: 0,
        archivedCount: 0,
        emptyCount: 0,
        bytes: 0,
        messagesCount: 0,
        messagesBytes: 0,
        projectFileCount: 0,
        projectFilesBytes: 0,
        compressedContextBytes: 0,
      },
      snapshots: { count: 0, bytes: 0, checkpointCount: 0, patchCount: 0 },
      memories: { count: 0, bytes: 0 },
      skills: { count: 0, bytes: 0 },
      templates: { count: 0, bytes: 0 },
      cleanup: {
        archivedConversationIds: [],
        emptyConversationIds: [],
        prunableSnapshotCount: 0,
      },
    }),
  };
});

describe("StorageTab", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      system: { ...systemDefaults, language: "en" },
    });
    useConversationStore.setState({ conversations: {}, activeId: null });
    useSnapshotStore.setState({ snapshots: {} });
    useMemoryStore.setState({ memories: [] });
    useSkillsStore.setState({ skills: {} });
    useProjectTemplateStore.setState({ templates: {} });
  });

  it("includes Design systems, project assets and archives in the item list and total", async () => {
    render(<StorageTab />);

    await waitFor(() => {
      expect(screen.getByText("Project images")).toBeInTheDocument();
    });
    expect(screen.getByText("Imported Design systems")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("512 B")).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
    expect(screen.getByText("Project archives")).toBeInTheDocument();
    expect(screen.getAllByText("1.0 KB")).toHaveLength(2);
    expect(screen.getByText("Canvas layouts")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("4.0 KB")).toBeInTheDocument();
  });
});
