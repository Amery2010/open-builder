// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { DesignTokenPanel } from "./DesignTokenPanel";

const css = `:root {
  --bg: #ffffff;
  --surface: #f8f8f8;
  --fg: #111111;
  --muted: #666666;
  --border: #dddddd;
  --accent: #6541f5;
  --accent-on: #ffffff;
  --success: #188038;
  --warn: #9a6700;
  --danger: #d1242f;
  --font-display: system-ui;
  --font-body: system-ui;
  --radius-md: 8px;
  --section-y-desktop: 96px;
  --container-max: 1200px;
  --motion-base: 180ms;
}`;

describe("DesignTokenPanel", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });

  it("keeps the token editor body scrollable between fixed header and footer", () => {
    render(
      <DesignTokenPanel
        open
        onOpenChange={vi.fn()}
        files={{ "tokens.css": css }}
        designState={{
          appliedSystem: {
            id: "stripe",
            name: "Stripe",
            source: "builtin",
            version: "pinned",
            digest: "a".repeat(64),
          },
        }}
        onCommit={vi.fn()}
        onUpgrade={vi.fn()}
        isGenerating={false}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const body = dialog.querySelector<HTMLElement>('[data-slot="dialog-body"]');
    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-hidden");
    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass(
      "shrink-0",
    );
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).toHaveClass(
      "shrink-0",
    );
    expect(dialog.querySelectorAll('[data-slot="dialog-body"]')).toHaveLength(
      1,
    );
    expect(body).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
  });

  it("keeps repeated input local but commits only once on Save", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <DesignTokenPanel
        open
        onOpenChange={vi.fn()}
        files={{ "tokens.css": css }}
        designState={{
          appliedSystem: {
            id: "stripe",
            name: "Stripe",
            source: "builtin",
            version: "pinned",
            digest: "a".repeat(64),
          },
        }}
        onCommit={onCommit}
        onUpgrade={vi.fn()}
        isGenerating={false}
      />,
    );

    const accent = screen.getByLabelText("Accent");
    await user.clear(accent);
    await user.type(accent, "#112233");
    expect(onCommit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save tokens" }));
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit.mock.calls[0][0]).toEqual([
      { token: "--accent", value: "#112233" },
    ]);
  });

  it("discards unsaved input when cancelled", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DesignTokenPanel
        open
        onOpenChange={onOpenChange}
        files={{ "tokens.css": css }}
        designState={{
          appliedSystem: {
            id: "stripe",
            name: "Stripe",
            source: "builtin",
            version: "pinned",
            digest: "a".repeat(64),
          },
        }}
        onCommit={onCommit}
        onUpgrade={vi.fn()}
        isGenerating={false}
      />,
    );
    await user.clear(screen.getByLabelText("Accent"));
    await user.type(screen.getByLabelText("Accent"), "#112233");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps legacy DESIGN.md references read-only", () => {
    render(
      <DesignTokenPanel
        open
        onOpenChange={vi.fn()}
        files={{ "DESIGN.md": "# Legacy", "tokens.css": css }}
        designState={{
          appliedSystem: {
            id: "legacy-design-md",
            name: "DESIGN.md",
            source: "legacy",
            version: "legacy",
          },
        }}
        onCommit={vi.fn()}
        onUpgrade={vi.fn()}
        isGenerating={false}
      />,
    );
    expect(screen.getByText("Legacy design reference")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save tokens" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Choose Design system" }),
    ).toBeInTheDocument();
  });

  it("distinguishes a selected system that has not been applied", () => {
    render(
      <DesignTokenPanel
        open
        onOpenChange={vi.fn()}
        files={{ "tokens.css": css }}
        designState={{
          selectedSystem: {
            id: "stripe",
            name: "Stripe",
            source: "builtin",
            version: "pinned",
            digest: "a".repeat(64),
          },
        }}
        onCommit={vi.fn()}
        onUpgrade={vi.fn()}
        isGenerating={false}
      />,
    );

    expect(screen.getByText("Design system not applied")).toBeInTheDocument();
    expect(screen.getByText(/Stripe is selected/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Accent")).toBeNull();
  });

  it("rejects an invalid root token contract", () => {
    render(
      <DesignTokenPanel
        open
        onOpenChange={vi.fn()}
        files={{ "tokens.css": ":root { --bg: #fff; }" }}
        designState={{
          appliedSystem: {
            id: "stripe",
            name: "Stripe",
            source: "builtin",
            version: "pinned",
            digest: "a".repeat(64),
          },
        }}
        onCommit={vi.fn()}
        onUpgrade={vi.fn()}
        isGenerating={false}
      />,
    );

    expect(screen.getByText("Invalid token contract")).toBeInTheDocument();
    expect(screen.queryByLabelText("Accent")).toBeNull();
  });

  it("distinguishes a missing applied contract from no applied system", () => {
    const common = {
      open: true,
      onOpenChange: vi.fn(),
      files: {},
      onCommit: vi.fn(),
      onUpgrade: vi.fn(),
      isGenerating: false,
    };
    const { rerender } = render(
      <DesignTokenPanel
        {...common}
        designState={{
          appliedSystem: {
            id: "stripe",
            name: "Stripe",
            source: "builtin",
            version: "pinned",
            digest: "a".repeat(64),
          },
        }}
      />,
    );
    expect(screen.getByText("Token contract missing")).toBeInTheDocument();

    rerender(<DesignTokenPanel {...common} />);
    expect(screen.getByText("Token contract unavailable")).toBeInTheDocument();
  });

  it("locks token editing while generation owns the project", () => {
    render(
      <DesignTokenPanel
        open
        onOpenChange={vi.fn()}
        files={{ "tokens.css": css }}
        designState={{
          appliedSystem: {
            id: "stripe",
            name: "Stripe",
            source: "builtin",
            version: "pinned",
            digest: "a".repeat(64),
          },
        }}
        onCommit={vi.fn()}
        onUpgrade={vi.fn()}
        isGenerating
      />,
    );
    expect(screen.getByLabelText("Accent")).toBeDisabled();
  });
});
