// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useProjectTemplateLibraryUi } from "../../hooks/useProjectTemplateController";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useProjectTemplateLibraryUi.setState({
      open: false,
      sourceConversationId: null,
    });
  });

  it("keeps quick suggestions without duplicating workspace onboarding", () => {
    render(<EmptyState onSelectSuggestion={vi.fn()} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Start Creating Your App"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Quick suggestions" }),
    ).toBeVisible();
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("opens the shared project starter library", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<EmptyState onSelectSuggestion={vi.fn()} />);

    await user.click(
      screen.getByRole("button", { name: "Open project starters" }),
    );
    expect(useProjectTemplateLibraryUi.getState().open).toBe(true);
  });
});
