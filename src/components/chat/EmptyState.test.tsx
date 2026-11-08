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

  it("offers editable scenario prompts and a shared starter library", async () => {
    const onSelectSuggestion = vi.fn();
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<EmptyState onSelectSuggestion={onSelectSuggestion} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Start Creating Your App"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Quick suggestions" }),
    ).toBeVisible();
    expect(screen.getAllByRole("button")).toHaveLength(4);
    await user.click(
      screen.getByRole("button", { name: /Personal portfolio/ }),
    );
    expect(onSelectSuggestion).toHaveBeenCalledWith(
      expect.stringContaining(
        "a personal introduction, a project showcase, and contact details",
      ),
    );
    await user.click(screen.getByRole("button", { name: /Task manager/ }));
    expect(onSelectSuggestion).toHaveBeenLastCalledWith(
      expect.stringContaining("Save data locally"),
    );
    await user.click(
      screen.getByRole("button", { name: /Coffee shop website/ }),
    );
    expect(onSelectSuggestion).toHaveBeenLastCalledWith(
      expect.stringContaining("three pages"),
    );
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
