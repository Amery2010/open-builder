// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectDesignNavigator,
  type ProjectDesignViewModel,
} from "./ProjectDesignNavigator";

const baseModel: ProjectDesignViewModel = {
  blueprint: { status: "ready" },
  pages: [
    {
      id: "home",
      name: "Home",
      responsibility: "Introduce the product and its primary action.",
      buildProgress: 68,
      buildStatus: "in-progress",
      reviewStatus: "in-review",
      scenes: [
        {
          id: "hero",
          name: "Hero",
          description: "Lead with the product promise.",
        },
        { id: "proof", name: "Proof" },
      ],
    },
    {
      id: "settings",
      parentId: "home",
      name: "Settings",
      responsibility: "Give people control over their preferences.",
      buildProgress: 100,
      buildStatus: "complete",
      reviewStatus: "approved",
      scenes: [],
    },
  ],
  selectedPageId: "home",
  selectedSceneId: "hero",
  sharedLayoutImpact: "Changes to navigation affect every page.",
};

function renderNavigator(
  model: ProjectDesignViewModel = baseModel,
  overrides: Partial<ComponentProps<typeof ProjectDesignNavigator>> = {},
) {
  return render(
    <ProjectDesignNavigator
      model={model}
      onPageSelect={vi.fn()}
      onSceneSelect={vi.fn()}
      onResetData={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ProjectDesignNavigator", () => {
  it("keeps a draft page selectable while explaining unavailable preview", async () => {
    const user = userEvent.setup();
    const onPageSelect = vi.fn();
    renderNavigator(
      {
        blueprint: { status: "ready" },
        pages: [
          {
            ...baseModel.pages[0],
            responsibility: "Details pending",
            previewIssue: "Add a route to preview this page.",
          },
        ],
      },
      { onPageSelect },
    );
    const page = screen.getByRole("treeitem", { name: /^Home\./ });
    expect(page).toHaveAttribute("data-preview-available", "false");
    await user.click(page);
    expect(onPageSelect).toHaveBeenCalledWith("home");
    expect(screen.getByText("Add a route to preview this page.")).toBeVisible();
  });
  it("selects a page and scene from the accessible page tree", async () => {
    const user = userEvent.setup();
    const onPageSelect = vi.fn();
    const onSceneSelect = vi.fn();

    renderNavigator(baseModel, { onPageSelect, onSceneSelect });

    const home = screen.getByRole("treeitem", { name: /^Home\./i });
    expect(home).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("progressbar", { name: /68%/i })).toHaveAttribute(
      "aria-valuenow",
      "68",
    );
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("In review")).toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: /^Settings\./i }));
    expect(onPageSelect).toHaveBeenCalledWith("settings");

    await user.click(screen.getByRole("treeitem", { name: /^Hero\./i }));
    expect(onSceneSelect).toHaveBeenCalledWith("home", "hero");
  });

  it("supports keyboard selection and collapses the page tree", async () => {
    const user = userEvent.setup();
    const onPageSelect = vi.fn();

    renderNavigator(baseModel, { onPageSelect });

    const settings = screen.getByRole("treeitem", { name: /^Settings\./i });
    expect(settings).toHaveAttribute("aria-level", "2");
    settings.focus();
    await user.keyboard("{Enter}");
    expect(onPageSelect).toHaveBeenCalledWith("settings");

    const collapse = screen.getByTestId("project-design-collapse");
    await user.click(collapse);
    expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("project-design-navigator")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(
      screen.queryByText("Introduce the product and its primary action."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand page tree" }));
    expect(
      screen.getByText("Introduce the product and its primary action."),
    ).toBeInTheDocument();
  });

  it("exposes the shared layout impact and invokes reset data", async () => {
    const user = userEvent.setup();
    const onResetData = vi.fn();
    const onEditBlueprint = vi.fn();

    renderNavigator(baseModel, { onResetData, onEditBlueprint });

    const notice = screen.getByRole("note", { name: "Shared layout impact" });
    expect(notice).toHaveTextContent(
      "Changes to navigation affect every page.",
    );

    await user.click(screen.getByRole("button", { name: "Reset data" }));
    expect(onResetData).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: "Edit project outline" }),
    );
    expect(onEditBlueprint).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state for missing and invalid blueprints", () => {
    const { unmount } = renderNavigator({
      blueprint: { status: "missing" },
      pages: [],
    });
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-blueprint-status",
      "missing",
    );
    expect(screen.getByText("Blueprint is missing")).toBeInTheDocument();
    unmount();

    renderNavigator({
      blueprint: {
        status: "invalid",
        message: "The blueprint JSON is malformed.",
      },
      pages: [],
    });
    const state = screen.getByRole("status");
    expect(state).toHaveAttribute("data-blueprint-status", "invalid");
    expect(
      within(state).getByText("Blueprint needs attention"),
    ).toBeInTheDocument();
    expect(
      within(state).getByText("The blueprint JSON is malformed."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("uses the same navigator as a narrow-screen drawer", async () => {
    const user = userEvent.setup();

    renderNavigator();

    const trigger = screen.getByRole("button", {
      name: "Open project design navigator",
    });
    expect(trigger).toHaveClass("md:hidden");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("project-design-navigator")).toHaveAttribute(
      "data-mobile-open",
      "true",
    );
    expect(screen.getByTestId("project-design-sidebar")).toHaveClass(
      "md:translate-x-0",
    );
  });

  it("keeps empty-blueprint guidance accessible across collapse and expansion", async () => {
    const user = userEvent.setup();
    renderNavigator({ blueprint: { status: "ready" }, pages: [] });
    const state = screen.getByRole("status");
    expect(state).toHaveAttribute("data-blueprint-status", "empty");
    await user.click(screen.getByTestId("project-design-collapse"));
    expect(state).toHaveAttribute("title", "No pages in the blueprint");
    expect(state).toHaveTextContent(
      "Add a page to the blueprint to start designing.",
    );
    await user.click(screen.getByTestId("project-design-collapse"));
    expect(state).not.toHaveAttribute("title");
    expect(state).toHaveTextContent("No pages in the blueprint");
  });
});
