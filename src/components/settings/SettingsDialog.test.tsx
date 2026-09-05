// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { aiDefaults } from "../../store/settings/ai";
import { assetSearchDefaults } from "../../store/settings/asset-search";
import { systemDefaults } from "../../store/settings/system";
import { webSearchDefaults } from "../../store/settings/web-search";
import { SettingsDialog, validateAISettingsDraft } from "./SettingsDialog";

vi.mock("./tabs/SearchServicesTab", () => ({
  SearchServicesTab: () => null,
}));
vi.mock("./tabs/StorageTab", () => ({ StorageTab: () => null }));
vi.mock("./tabs/SystemTab", () => ({ SystemTab: () => null }));

const validationMessages = {
  apiKeyRequired: "key required",
  apiBaseUrlRequired: "URL required",
  apiBaseUrlInvalid: "URL invalid",
  modelRequired: "model required",
  modelInvalid: "model invalid",
};

describe("SettingsDialog", () => {
  it("validates model settings before committing the draft", () => {
    expect(validateAISettingsDraft(aiDefaults, validationMessages)).toEqual({
      apiKey: "key required",
      apiBaseUrl: "URL required",
    });
    expect(
      validateAISettingsDraft(
        {
          ...aiDefaults,
          apiType: "openai-compatible",
          apiKey: "local-key",
          apiBaseUrl: "file:///tmp/model",
          model: "model\nname",
        },
        validationMessages,
      ),
    ).toEqual({ apiBaseUrl: "URL invalid", model: "model invalid" });
    expect(
      validateAISettingsDraft(
        { ...aiDefaults, runtime: "localCli" },
        validationMessages,
      ),
    ).toEqual({});
  });

  it("keeps edits transactional until a valid Save and passes axe checks", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onSaveSystem = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <SettingsDialog
          isOpen
          onClose={onClose}
          settings={aiDefaults}
          onSave={onSave}
          webSearchSettings={webSearchDefaults}
          onSaveWebSearch={vi.fn()}
          assetSearchSettings={assetSearchDefaults}
          onSaveAssetSearch={vi.fn()}
          systemSettings={systemDefaults}
          onSaveSystem={onSaveSystem}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("API Key")).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    await user.type(screen.getByLabelText("API Key"), "test-key");
    await user.type(
      screen.getByLabelText("API Base URL"),
      "https://api.example.com",
    );
    await user.clear(screen.getByLabelText("Model Name"));
    await user.type(screen.getByLabelText("Model Name"), "test-model");

    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.queryByText("Permission activity")).not.toBeInTheDocument();
    const customPrompt = screen.getByLabelText("Custom instructions");
    await user.type(customPrompt, "Keep changes concise.");
    expect(customPrompt).toHaveAttribute("rows", "3");
    expect(customPrompt).toHaveClass(
      "field-sizing-fixed",
      "resize-none",
      "focus-visible:border-input",
    );
    expect(
      screen.queryByText(/Appended safely to Chat/i),
    ).not.toBeInTheDocument();
    const autoQa = screen.getByRole("group", { name: "Auto QA" });
    await user.click(within(autoQa).getByRole("button", { name: "Enabled" }));

    await user.click(screen.getByRole("tab", { name: "System" }));
    expect(
      screen.queryByRole("group", { name: "Auto QA" }),
    ).not.toBeInTheDocument();

    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      ...aiDefaults,
      apiType: "openai-compatible",
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
      model: "test-model",
    });
    expect(onSaveSystem).toHaveBeenCalledWith({
      ...systemDefaults,
      autoQaEnabled: true,
      customSystemPrompt: "Keep changes concise.",
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(
      (
        await axe(container, {
          rules: { "color-contrast": { enabled: false } },
        })
      ).violations,
    ).toEqual([]);
  });

  it("blocks transactional save and links an accessible error above 32,000 characters", async () => {
    const user = userEvent.setup();
    const onSaveSystem = vi.fn();
    render(
      <TooltipProvider>
        <SettingsDialog
          isOpen
          onClose={vi.fn()}
          settings={{
            ...aiDefaults,
            apiKey: "test-key",
            apiBaseUrl: "https://api.example.com",
          }}
          onSave={vi.fn()}
          webSearchSettings={webSearchDefaults}
          onSaveWebSearch={vi.fn()}
          assetSearchSettings={assetSearchDefaults}
          onSaveAssetSearch={vi.fn()}
          systemSettings={{
            ...systemDefaults,
            customSystemPrompt: "x".repeat(32_001),
          }}
          onSaveSystem={onSaveSystem}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    const textarea = screen.getByLabelText("Custom instructions");
    expect(textarea).toHaveValue("x".repeat(32_001));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSaveSystem).not.toHaveBeenCalled();
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    const error = screen.getByText(
      "Custom instructions must be 32,000 characters or fewer.",
    );
    expect(textarea).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining(error.id),
    );
  });

  it("keeps the shared close control above the sticky header", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <TooltipProvider>
        <SettingsDialog
          isOpen
          onClose={onClose}
          settings={aiDefaults}
          onSave={vi.fn()}
          webSearchSettings={webSearchDefaults}
          onSaveWebSearch={vi.fn()}
          assetSearchSettings={assetSearchDefaults}
          onSaveAssetSearch={vi.fn()}
          systemSettings={systemDefaults}
          onSaveSystem={vi.fn()}
        />
      </TooltipProvider>,
    );

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveClass("z-20", "size-8");
    await user.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires the active turn to stop before changing runtimes", () => {
    render(
      <TooltipProvider>
        <SettingsDialog
          isOpen
          onClose={vi.fn()}
          settings={{ ...aiDefaults, runtime: "localCli" }}
          onSave={vi.fn()}
          webSearchSettings={webSearchDefaults}
          onSaveWebSearch={vi.fn()}
          assetSearchSettings={assetSearchDefaults}
          onSaveAssetSearch={vi.fn()}
          systemSettings={systemDefaults}
          onSaveSystem={vi.fn()}
          runtimeChangeLocked
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: "API" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Local CLI" })).toBeDisabled();
    expect(
      screen.getByText(
        "Stop the active turn before switching runtimes or CLI agents.",
      ),
    ).toBeInTheDocument();
  });

  it("does not save a stale full-permission toggle after a task starts", async () => {
    const user = userEvent.setup();
    const onSaveSystem = vi.fn();
    const validSettings = {
      ...aiDefaults,
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
    };
    const renderDialog = (runtimeChangeLocked: boolean) => (
      <TooltipProvider>
        <SettingsDialog
          isOpen
          onClose={vi.fn()}
          settings={validSettings}
          onSave={vi.fn()}
          webSearchSettings={webSearchDefaults}
          onSaveWebSearch={vi.fn()}
          assetSearchSettings={assetSearchDefaults}
          onSaveAssetSearch={vi.fn()}
          systemSettings={systemDefaults}
          onSaveSystem={onSaveSystem}
          runtimeChangeLocked={runtimeChangeLocked}
        />
      </TooltipProvider>
    );
    const view = render(renderDialog(false));
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    const permissions = screen.getByRole("group", {
      name: "Enable full permissions",
    });
    await user.click(
      within(permissions).getByRole("button", { name: "Enabled" }),
    );

    view.rerender(renderDialog(true));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSaveSystem).toHaveBeenCalledWith(systemDefaults);
  });
});
