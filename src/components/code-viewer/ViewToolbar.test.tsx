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
      screen.queryByRole("button", { name: "Web" }),
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
    const { rerender } = render(
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
    expect(
      screen
        .getByRole("button", { name: "Select an element in the preview" })
        .querySelector("svg"),
    ).toHaveClass("lucide-mouse-pointer-click");
    expect(
      screen.queryByRole("button", { name: "Edit design tokens" }),
    ).not.toBeInTheDocument();
    rerender(
      <TooltipProvider>
        <ViewToolbar
          viewMode="code"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          designMode
          onOpenDesignTokens={onOpenDesignTokens}
        />
      </TooltipProvider>,
    );
    const tokenButton = screen.getByRole("button", {
      name: "Edit design tokens",
    });
    expect(tokenButton.querySelector("svg")).toHaveClass("lucide-shapes");
    expect(
      screen.queryByRole("button", {
        name: "Select an element in the preview",
      }),
    ).not.toBeInTheDocument();
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
          viewMode="code"
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

  it("keeps design and export actions in the Code group only", () => {
    const onOpenDesignTokens = vi.fn();
    const onExportDirectory = vi.fn();
    render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          designMode
          onOpenDesignTokens={onOpenDesignTokens}
          desktopMode
          onExportDirectory={onExportDirectory}
        />
      </TooltipProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "Edit design tokens" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Export to a new directory" }),
    ).not.toBeInTheDocument();
  });

  it("renders Code actions without outline borders or shadows", () => {
    render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="code"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          designMode
          onOpenDesignTokens={vi.fn()}
          desktopMode
          onExportDirectory={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: "Download" })).toHaveAttribute(
      "data-variant",
      "ghost",
    );
    expect(
      screen.getByRole("button", { name: "Export to a new directory" }),
    ).toHaveAttribute("data-variant", "ghost");
  });

  it.each(["desktop", "tablet", "mobile"] as const)(
    "shows preview zoom controls for the %s device",
    (deviceSize) => {
      render(
        <TooltipProvider>
          <ViewToolbar
            viewMode="preview"
            onViewModeChange={vi.fn()}
            deviceSize={deviceSize}
            onDeviceSizeChange={vi.fn()}
            files={{ "index.html": "<body />" }}
          />
        </TooltipProvider>,
      );

      const zoomGroup = screen.getByRole("group", {
        name: "Preview zoom level",
      });
      expect(zoomGroup).toHaveTextContent("100");
      expect(zoomGroup).not.toHaveTextContent("%");
      expect(zoomGroup).not.toHaveClass("bg-muted/30");
      expect(
        screen.queryByRole("spinbutton", { name: "Preview zoom level" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Fit preview" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Zoom out preview" }),
      ).toHaveClass("size-7");
      expect(
        screen.getByRole("button", { name: "Zoom in preview" }),
      ).toHaveClass("size-7");
    },
  );

  it("places the zoom group before the device group", () => {
    render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
        />
      </TooltipProvider>,
    );

    const zoomGroup = screen.getByRole("group", {
      name: "Preview zoom level",
    });
    const desktopButton = screen.getByRole("button", { name: "Web" });
    const deviceGroup = desktopButton.parentElement;

    expect(zoomGroup.nextElementSibling).toBe(deviceGroup);
    expect(deviceGroup?.previousElementSibling).toBe(zoomGroup);
  });

  it("keeps the scale read-only and delegates bounded zoom actions", async () => {
    const user = userEvent.setup();
    const onPreviewZoomIn = vi.fn();
    const onPreviewZoomOut = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          previewScale={1}
          onPreviewZoomIn={onPreviewZoomIn}
          onPreviewZoomOut={onPreviewZoomOut}
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByLabelText("Preview zoom level", { selector: "output" }),
    ).toHaveTextContent("100");
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Zoom out preview" }));
    await user.click(screen.getByRole("button", { name: "Zoom in preview" }));
    expect(onPreviewZoomOut).toHaveBeenCalledOnce();
    expect(onPreviewZoomIn).toHaveBeenCalledOnce();

    rerender(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          previewScale={1.5}
          onPreviewZoomIn={onPreviewZoomIn}
          onPreviewZoomOut={onPreviewZoomOut}
        />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Zoom in preview" }),
    ).toBeDisabled();

    rerender(
      <TooltipProvider>
        <ViewToolbar
          viewMode="preview"
          onViewModeChange={vi.fn()}
          deviceSize="desktop"
          onDeviceSizeChange={vi.fn()}
          files={{ "index.html": "<body />" }}
          previewScale={0.25}
          onPreviewZoomIn={onPreviewZoomIn}
          onPreviewZoomOut={onPreviewZoomOut}
        />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Zoom out preview" }),
    ).toBeDisabled();
  });
});
