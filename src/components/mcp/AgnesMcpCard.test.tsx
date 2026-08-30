// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useMcpStore } from "../../store/mcp";
import { createDefaultAgnesMcpSettings } from "../../lib/mcp/agnes/types";
import { AgnesMcpCard } from "./AgnesMcpCard";

vi.mock("localforage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    createInstance: () => ({
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    }),
  },
}));

describe("Agnes built-in MCP card", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    const agnes = createDefaultAgnesMcpSettings(1);
    agnes.apiKey = "saved-secret";
    agnes.enabled = true;
    agnes.tools.generate_image.enabled = true;
    useMcpStore.setState({
      globalEnabled: true,
      agnes,
      servers: {},
      runtime: {},
      _hasHydrated: true,
    });
  });

  it("masks the local key, performs only a local check, and removes the key", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<AgnesMcpCard platform="web" />);

    await user.click(screen.getByRole("button", { name: "Details" }));
    const keyInput = screen.getByLabelText("Agnes API key");
    expect(keyInput).toHaveAttribute("type", "password");
    expect(keyInput).toHaveValue("saved-secret");

    await user.click(
      screen.getByRole("button", { name: "Check configuration" }),
    );
    expect(
      screen.getByText(
        "Local configuration is complete. No network request was sent.",
      ),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(useMcpStore.getState().agnes).toMatchObject({
      apiKey: "",
      enabled: false,
    });
    fetchSpy.mockRestore();
  });

  it("never offers Plan or video subagent permission switches", async () => {
    const user = userEvent.setup();
    render(<AgnesMcpCard platform="desktop" />);
    await user.click(screen.getByRole("button", { name: "Details" }));

    expect(screen.queryByText("Allow in Plan Mode")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Allow image generation for subagents"),
    ).toHaveLength(1);
  });
});
