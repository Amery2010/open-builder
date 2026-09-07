// @vitest-environment jsdom

import { useState, type PropsWithChildren } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { aiDefaults } from "../../store/settings/ai";
import { assetSearchDefaults } from "../../store/settings/asset-search";
import { systemDefaults } from "../../store/settings/system";
import { webSearchDefaults } from "../../store/settings/web-search";
import { SettingsDialog } from "./SettingsDialog";

function TestShell({ children }: PropsWithChildren) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function buildSettings(overrides: Partial<typeof aiDefaults> = {}) {
  return { ...aiDefaults, ...overrides };
}

function renderSettings(
  props: Partial<React.ComponentProps<typeof SettingsDialog>> = {},
) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const onSaveSystem = vi.fn();
  const view = render(
    <TestShell>
      <SettingsDialog
        isOpen
        onClose={onClose}
        settings={buildSettings()}
        onSave={onSave}
        webSearchSettings={webSearchDefaults}
        onSaveWebSearch={vi.fn()}
        assetSearchSettings={assetSearchDefaults}
        onSaveAssetSearch={vi.fn()}
        systemSettings={systemDefaults}
        onSaveSystem={onSaveSystem}
        {...props}
      />
    </TestShell>,
  );
  return { ...view, onClose, onSave, onSaveSystem };
}

describe("SettingsDialog UI recovery", () => {
  it("saves a System-only change when the API model is not configured", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onSaveSystem = vi.fn();
    renderSettings({
      settings: buildSettings({ apiKey: "", apiBaseUrl: "", model: "" }),
      onSave,
      onSaveSystem,
    });

    await user.click(screen.getByRole("tab", { name: "System" }));
    await user.click(
      within(screen.getByRole("group", { name: "Appearance" })).getByRole(
        "button",
        { name: "Dark" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onSaveSystem).toHaveBeenCalledWith({
      ...systemDefaults,
      theme: "dark",
    });
  });

  it("saves a System-only change after returning to an unchanged Model tab", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onSaveSystem = vi.fn();
    renderSettings({
      settings: buildSettings({ apiKey: "", apiBaseUrl: "", model: "" }),
      onSave,
      onSaveSystem,
    });

    await user.click(screen.getByRole("tab", { name: "System" }));
    await user.click(
      within(screen.getByRole("group", { name: "Appearance" })).getByRole(
        "button",
        { name: "Dark" },
      ),
    );
    await user.click(screen.getByRole("tab", { name: "Model" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onSaveSystem).toHaveBeenCalledWith({
      ...systemDefaults,
      theme: "dark",
    });
  });

  it("moves to and focuses the first actionable Model error when its draft changed", async () => {
    const user = userEvent.setup();
    renderSettings({
      settings: buildSettings({
        apiKey: "test-key",
        apiBaseUrl: "https://api.example.com",
        model: "test-model",
      }),
    });

    await user.click(screen.getByRole("tab", { name: "Model" }));
    await user.clear(screen.getByLabelText("API Key"));
    await user.click(screen.getByRole("tab", { name: "System" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Model" })).toHaveAttribute(
        "data-state",
        "active",
      );
      expect(screen.getByLabelText("API Key")).toHaveFocus();
    });
  });

  it.each(["button", "escape"] as const)(
    "restores focus to the opener after %s close",
    async (closeMethod) => {
      const user = userEvent.setup();
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <TestShell>
            <button type="button" onClick={() => setOpen(true)}>
              Open settings
            </button>
            {open && (
              <SettingsDialog
                isOpen
                onClose={() => setOpen(false)}
                settings={buildSettings({
                  apiKey: "test-key",
                  apiBaseUrl: "https://api.example.com",
                  model: "test-model",
                })}
                onSave={vi.fn()}
                webSearchSettings={webSearchDefaults}
                onSaveWebSearch={vi.fn()}
                assetSearchSettings={assetSearchDefaults}
                onSaveAssetSearch={vi.fn()}
                systemSettings={systemDefaults}
                onSaveSystem={vi.fn()}
              />
            )}
          </TestShell>
        );
      }

      render(<Harness />);
      const opener = screen.getByRole("button", { name: "Open settings" });
      await user.click(opener);
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      if (closeMethod === "button") {
        await user.click(screen.getByRole("button", { name: "Close" }));
      } else {
        await user.keyboard("{Escape}");
      }

      await waitFor(() => expect(opener).toHaveFocus());
    },
  );

  it("uses the persistent settings control when the original opener is removed", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      const [showOpener, setShowOpener] = useState(true);
      return (
        <TestShell>
          {showOpener && (
            <button
              type="button"
              onClick={() => {
                setOpen(true);
                setShowOpener(false);
              }}
            >
              Temporary opener
            </button>
          )}
          <button type="button" data-settings-focus-fallback="true">
            Persistent settings
          </button>
          {open && (
            <SettingsDialog
              isOpen
              onClose={() => setOpen(false)}
              settings={buildSettings({
                apiKey: "test-key",
                apiBaseUrl: "https://api.example.com",
                model: "test-model",
              })}
              onSave={vi.fn()}
              webSearchSettings={webSearchDefaults}
              onSaveWebSearch={vi.fn()}
              assetSearchSettings={assetSearchDefaults}
              onSaveAssetSearch={vi.fn()}
              systemSettings={systemDefaults}
              onSaveSystem={vi.fn()}
            />
          )}
        </TestShell>
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Temporary opener" }));
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Persistent settings" }),
      ).toHaveFocus(),
    );
  });
});
