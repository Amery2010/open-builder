// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpPanel } from "./mcp/McpPanel";
import { SkillsPanel } from "./skills/SkillsPanel";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useMcpStore } from "../store/mcp";
import { useSettingsStore } from "../store/settings";
import { useSkillsStore } from "../store/skills";

describe("capability dialog sizing", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useSkillsStore.setState({ skills: {}, _hasHydrated: true });
    useMcpStore.setState({
      servers: {},
      runtime: {},
      globalEnabled: true,
      _hasHydrated: true,
    });
  });

  it("limits the Skills dialog to 576px", () => {
    render(<SkillsPanel open onClose={vi.fn()} />);

    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-xl");
  });

  it("keeps the Skills catalog in one scrollable body", () => {
    render(<SkillsPanel open onClose={vi.fn()} />);

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
    expect(body?.querySelectorAll('[class*="overflow-y-auto"]')).toHaveLength(
      0,
    );
  });

  it("limits the MCP dialog to 576px", () => {
    render(<McpPanel open onClose={vi.fn()} platform="web" />);

    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-xl");
  });

  it("provides a viewport-safe frame with one scrollable body", () => {
    render(
      <Dialog open>
        <DialogContent className="flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Long dialog</DialogTitle>
          </DialogHeader>
          <DialogBody data-testid="dialog-body">
            <div style={{ height: 2000 }}>Long content</div>
          </DialogBody>
          <DialogFooter>Actions</DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    const content = screen.getByRole("dialog");
    expect(content).toHaveClass("max-h-[calc(100dvh-2rem)]");
    expect(content).toHaveClass("overflow-hidden");
    expect(screen.getByTestId("dialog-body")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
    );
  });

  it("keeps unstructured dialog content inside the viewport by default", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Unstructured content</DialogTitle>
          <div style={{ height: 2000 }}>Long content</div>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog")).toHaveClass(
      "max-h-[calc(100dvh-2rem)]",
      "overflow-y-auto",
      "overscroll-contain",
    );
  });

  it("preserves an explicit dialog max-height override", () => {
    render(
      <Dialog open>
        <DialogContent className="max-h-[80vh]">
          <DialogTitle>Custom height</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const maxHeightClasses = screen
      .getByRole("dialog")
      .className.split(/\s+/)
      .filter((token) => token.startsWith("max-h-"));
    expect(maxHeightClasses).toEqual(["max-h-[80vh]"]);
  });
});
