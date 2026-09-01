// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../../store/settings";
import { systemDefaults } from "../../../store/settings/system";
import { SystemTab } from "./SystemTab";

const infraMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  getProxyLog: vi.fn(() => []),
  clearProxyLog: vi.fn(),
}));

vi.mock("../../../lib/infra/proxy", () => infraMocks);

describe("SystemTab", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      system: { ...systemDefaults, language: "en" },
    });
    vi.clearAllMocks();
    infraMocks.isTauri.mockReturnValue(false);
  });

  it("keeps only general system controls", () => {
    render(<SystemTab form={systemDefaults} setForm={vi.fn()} />);

    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByText("Reset System")).toBeInTheDocument();
    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(
      screen.queryByText("Developer Skill scripts"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Reverse Proxy")).not.toBeInTheDocument();
  });
});
