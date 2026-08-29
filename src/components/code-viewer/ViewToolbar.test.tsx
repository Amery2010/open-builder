// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { useSettingsStore } from "../../store/settings";
import { ViewToolbar } from "./ViewToolbar";

describe("ViewToolbar preview availability", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });

  it("keeps code actions but removes preview controls in code-only mode", () => {
    render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="code"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "README.md": "notes" }}
          previewEnabled={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Preview" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Desktop" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload preview" })).toBeNull();
  });

  it("hard reloads the preview through an explicit toolbar action", async () => {
    const user = userEvent.setup();
    const onReloadPreview = vi.fn();
    render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          onReloadPreview={onReloadPreview}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Reload preview" }));
    expect(onReloadPreview).toHaveBeenCalledOnce();
  });

  it("exposes Design selection and token controls only through explicit actions", async () => {
    const user = userEvent.setup();
    const onToggleDesignSelection = vi.fn();
    const onOpenDesignTokens = vi.fn();
    render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          designMode
          designSelectionSupported
          onToggleDesignSelection={onToggleDesignSelection}
          onOpenDesignTokens={onOpenDesignTokens}
        />
      </TooltipProvider>,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Select an element in the preview",
      }),
    );
    expect(onToggleDesignSelection).toHaveBeenCalledOnce();
    const tokenButton = screen.getByRole("button", {
      name: "Edit design tokens",
    });
    expect(tokenButton.querySelector("svg")).toHaveClass("lucide-palette");
    expect(
      screen.queryByRole("button", { name: "Design system" }),
    ).not.toBeInTheDocument();
    await user.click(tokenButton);
    expect(onOpenDesignTokens).toHaveBeenCalledOnce();
  });

  it("shows the specific reason when a preview cannot be bridged", () => {
    render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "README.md": "notes" }}
          designMode
          designSelectionSupported={false}
          designSelectionUnavailableReason="Element selection needs index.html."
        />
      </TooltipProvider>,
    );
    expect(
      screen.getByLabelText("Element selection needs index.html."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Select an element in the preview",
      }),
    ).toBeNull();
  });

  it("keeps directory export desktop-only while exposing Design Review on Web", async () => {
    const user = userEvent.setup();
    const onOpenDesignReview = vi.fn();
    render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          designMode
          onOpenDesignReview={onOpenDesignReview}
        />
      </TooltipProvider>,
    );
    const reviewButton = screen.getByRole("button", { name: "Review design" });
    expect(reviewButton).toHaveAttribute("data-variant", "ghost");
    await user.click(reviewButton);
    expect(
      screen.queryByRole("button", { name: "Export to a new directory" }),
    ).toBeNull();
    expect(onOpenDesignReview).toHaveBeenCalledOnce();
  });

  it("adds non-overwriting directory export on desktop", async () => {
    const user = userEvent.setup();
    const onExportDirectory = vi.fn();
    render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          desktopMode
          onExportDirectory={onExportDirectory}
        />
      </TooltipProvider>,
    );
    await user.click(
      screen.getByRole("button", { name: "Export to a new directory" }),
    );
    expect(onExportDirectory).toHaveBeenCalledOnce();
  });
});
