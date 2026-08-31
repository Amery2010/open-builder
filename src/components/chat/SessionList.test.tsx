// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { useProjectTemplateStore } from "../../store/project-templates";
import { useSettingsStore } from "../../store/settings";
import { useProjectTemplateLibraryUi } from "../../hooks/useProjectTemplateController";
import type { Conversation } from "../../types";
import { TooltipProvider } from "../ui/tooltip";
import { SessionList } from "./SessionList";

function makeConversation(
  index: number,
  flags: Pick<Conversation, "pinned" | "archived"> = {},
): Conversation {
  return {
    id: `session-${index}`,
    title: `Session ${index}`,
    messages: [],
    files: {},
    template: "vite-react-ts",
    previewMode: "sandpack",
    isProjectInitialized: false,
    createdAt: index,
    updatedAt: index,
    ...flags,
  };
}

function setConversations(conversations: Conversation[]) {
  useConversationStore.setState({
    activeId: conversations[0]?.id ?? null,
    conversations: Object.fromEntries(
      conversations.map((conversation) => [conversation.id, conversation]),
    ),
  });
}

function renderSessionList() {
  return render(
    <TooltipProvider>
      <SessionList onClose={vi.fn()} />
    </TooltipProvider>,
  );
}

describe("SessionList batching", () => {
  beforeEach(() => {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useProjectTemplateStore.setState({ templates: {} });
    useProjectTemplateLibraryUi.setState({
      open: false,
      sourceConversationId: null,
    });
  });

  it("shows five recent sessions per batch and hides the control after the last batch", async () => {
    const user = userEvent.setup();
    setConversations(
      Array.from({ length: 12 }, (_, index) => makeConversation(index + 1)),
    );
    renderSessionList();

    expect(screen.getByText("Session 12")).toBeVisible();
    expect(screen.getByText("Session 8")).toBeVisible();
    expect(screen.queryByText("Session 7")).not.toBeInTheDocument();

    const loadMore = screen.getByRole("button", { name: "Show more" });
    expect(loadMore).toHaveClass(
      "text-[11px]",
      "font-normal",
      "text-muted-foreground/60",
    );
    await user.click(loadMore);

    expect(screen.getByText("Session 3")).toBeVisible();
    expect(screen.queryByText("Session 2")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.getByText("Session 1")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();
  });

  it("shows every search match and restores the five-item window after search", async () => {
    const user = userEvent.setup();
    setConversations([
      ...Array.from({ length: 12 }, (_, index) => makeConversation(index + 1)),
      {
        ...makeConversation(20, { archived: true }),
        title: "Archived target",
      },
    ]);
    renderSessionList();

    const search = screen.getByRole("textbox", {
      name: "Search conversations",
    });
    await user.type(search, "Session");

    expect(screen.getByText("Session 1")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "Archived target");
    expect(screen.getByText("Archived target")).toBeVisible();

    await user.clear(search);
    await waitFor(() =>
      expect(screen.queryByText("Session 7")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Show more" })).toBeVisible();
  });

  it("maintains an independent five-item window for each expanded group", async () => {
    const user = userEvent.setup();
    setConversations([
      ...Array.from({ length: 6 }, (_, index) =>
        makeConversation(100 + index, { pinned: true }),
      ),
      ...Array.from({ length: 6 }, (_, index) => makeConversation(50 + index)),
      ...Array.from({ length: 6 }, (_, index) =>
        makeConversation(index + 1, { archived: true }),
      ),
    ]);
    renderSessionList();

    expect(screen.queryByText("Session 100")).not.toBeInTheDocument();
    expect(screen.queryByText("Session 50")).not.toBeInTheDocument();
    expect(screen.queryByText("Session 6")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Show more" })).toHaveLength(
      2,
    );

    await user.click(screen.getByRole("button", { name: /Archived/ }));
    expect(screen.getByText("Session 6")).toBeVisible();
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Show more" })).toHaveLength(
      3,
    );
  });

  it("opens the shared project starter library for the active conversation", async () => {
    const user = userEvent.setup();
    setConversations([makeConversation(1)]);
    renderSessionList();

    await user.click(screen.getByRole("button", { name: "Project Starters" }));
    expect(useProjectTemplateLibraryUi.getState()).toMatchObject({
      open: true,
      sourceConversationId: "session-1",
    });
  });

  it("uses the layout-template icon for every starter-library action", async () => {
    const user = userEvent.setup();
    setConversations([
      {
        ...makeConversation(1),
        files: { "src/App.tsx": "export default function App() {}" },
      },
    ]);
    renderSessionList();

    expect(
      screen
        .getByRole("button", { name: "Project Starters" })
        .querySelector("svg"),
    ).toHaveClass("lucide-layout-template");

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    expect(
      (
        await screen.findByRole("menuitem", { name: "Save as starter" })
      ).querySelector("svg"),
    ).toHaveClass("lucide-layout-template");
  });
});
