// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webSearchDefaults } from "../../../store/settings/web-search";
import { useSettingsStore } from "../../../store/settings";
import { WebSearchTab } from "./WebSearchTab";

describe("WebSearchTab", () => {
  beforeEach(() => {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });

  it("presents Firecrawl as keyless with an optional higher-limit key", () => {
    render(
      <WebSearchTab
        form={webSearchDefaults}
        setForm={vi.fn()}
        apiType="openai-compatible"
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Web search" }),
    ).toHaveTextContent("Firecrawl");
    expect(screen.getByLabelText("Firecrawl API Key")).toBeVisible();
    expect(screen.getByText(/IP-limited free allowance/i)).toBeVisible();
  });

  it("shows a required key field for Exa", () => {
    render(
      <WebSearchTab
        form={{ ...webSearchDefaults, engine: "exa" }}
        setForm={vi.fn()}
        apiType="openai-compatible"
      />,
    );

    expect(screen.getByLabelText("Exa API Key")).toBeVisible();
    expect(screen.getByText(/Required.*enable Exa/i)).toBeVisible();
  });

  it("shows built-in search for a capable local CLI with an OpenAI-compatible API type", async () => {
    const user = userEvent.setup();
    render(
      <WebSearchTab
        form={webSearchDefaults}
        setForm={vi.fn()}
        apiType="openai-compatible"
        runtime="localCli"
        localNativeSearchAvailable
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Web search" }));
    expect(
      screen.getByRole("option", { name: "Model Built-in" }),
    ).toBeVisible();
  });

  it("keeps built-in search hidden when the local CLI has not attested it", async () => {
    const user = userEvent.setup();
    render(
      <WebSearchTab
        form={webSearchDefaults}
        setForm={vi.fn()}
        apiType="openai-compatible"
        runtime="localCli"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Web search" }));
    expect(
      screen.queryByRole("option", { name: "Model Built-in" }),
    ).not.toBeInTheDocument();
  });

  it("keeps built-in search hidden for an unattested local CLI regardless of API type", async () => {
    const user = userEvent.setup();
    render(
      <WebSearchTab
        form={webSearchDefaults}
        setForm={vi.fn()}
        apiType="anthropic"
        runtime="localCli"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Web search" }));
    expect(
      screen.queryByRole("option", { name: "Model Built-in" }),
    ).not.toBeInTheDocument();
  });
});
