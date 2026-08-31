// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useSnapshotStore } from "../../store/snapshot";
import { SnapshotHistoryDialog } from "./SnapshotHistoryDialog";

describe("SnapshotHistoryDialog", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useSnapshotStore.setState({ snapshots: { "conversation-1": [] } });
  });

  it("keeps history scrollable beneath a fixed header", () => {
    render(
      <SnapshotHistoryDialog
        conversationId="conversation-1"
        messages={[]}
        onClose={vi.fn()}
        onShowDiff={vi.fn()}
        onRollback={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const body = dialog.querySelector<HTMLElement>('[data-slot="dialog-body"]');
    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-hidden");
    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass(
      "shrink-0",
    );
    expect(dialog.querySelectorAll('[data-slot="dialog-body"]')).toHaveLength(
      1,
    );
    expect(body).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
  });
});
