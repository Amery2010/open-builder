// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
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
});
