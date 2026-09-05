// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../../store/settings";
import { systemDefaults } from "../../../store/settings/system";
import { AdvancedTab } from "./AdvancedTab";

const infraMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  getProxyLog: vi.fn(() => []),
  clearProxyLog: vi.fn(),
}));
const mcpMocks = vi.hoisted(() => ({
  getMcpPlatformCapabilities: vi.fn(async () => ({ skillScripts: true })),
}));

vi.mock("../../../lib/infra/proxy", () => infraMocks);
vi.mock("../../../lib/mcp/tauri-host", () => mcpMocks);

describe("AdvancedTab", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      system: { ...systemDefaults, language: "en" },
    });
    vi.clearAllMocks();
    infraMocks.isTauri.mockReturnValue(true);
    mcpMocks.getMcpPlatformCapabilities.mockResolvedValue({
      skillScripts: true,
    });
  });

  it("keeps advanced controls in the documented order", async () => {
    const { container } = render(
      <AdvancedTab form={systemDefaults} setForm={vi.fn()} />,
    );

    await waitFor(() =>
      expect(screen.getByText("Developer Skill scripts")).toBeInTheDocument(),
    );
    expect(screen.getByText("Reverse Proxy")).toBeInTheDocument();

    const content = container.textContent ?? "";
    expect(content.indexOf("Custom instructions")).toBeLessThan(
      content.indexOf("Auto QA"),
    );
    expect(content.indexOf("Auto QA")).toBeLessThan(
      content.indexOf("Developer Skill scripts"),
    );
    expect(content.indexOf("Developer Skill scripts")).toBeLessThan(
      content.indexOf("Reverse Proxy"),
    );
  });

  it("updates full permissions through its capsule group", async () => {
    const user = userEvent.setup();
    const setForm = vi.fn();
    render(
      <AdvancedTab
        form={systemDefaults}
        setForm={setForm}
        fullPermissionsLabels={{
          label: "Full permissions",
          on: "Enabled",
          off: "Disabled",
          hint: "Destructive project operations require approval.",
          stopFirst: "Stop the current task before changing full permissions.",
        }}
      />,
    );

    const group = screen.getByRole("group", { name: "Full permissions" });
    expect(
      within(group).getByRole("button", { name: "Disabled" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(within(group).getByRole("button", { name: "Enabled" }));
    expect(setForm).toHaveBeenCalledWith({
      ...systemDefaults,
      permissionBrokerBypassEnabled: true,
    });
  });

  it("locks full permissions while a task is running and explains how to unlock it", () => {
    render(
      <AdvancedTab
        form={systemDefaults}
        setForm={vi.fn()}
        runtimeChangeLocked
        fullPermissionsLabels={{
          label: "Full permissions",
          on: "Enabled",
          off: "Disabled",
          hint: "Destructive project operations require approval.",
          stopFirst: "Stop the current task before changing full permissions.",
        }}
      />,
    );

    const group = screen.getByRole("group", {
      name: "Full permissions. Stop the current task before changing full permissions.",
    });
    expect(group.querySelectorAll("button")).toHaveLength(2);
    for (const button of group.querySelectorAll("button")) {
      expect(button).toBeDisabled();
    }
    expect(
      screen.getByText(
        "Stop the current task before changing full permissions.",
      ),
    ).toHaveAttribute("id", "full-permissions-hint");
  });
});
