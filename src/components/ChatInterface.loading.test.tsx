// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { useInteractiveStore } from "../store/interactive";
import { useSettingsStore } from "../store/settings";
import { TooltipProvider } from "./ui/tooltip";
import { ChatInterface } from "./ChatInterface";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
    measureElement: vi.fn(),
  }),
}));

vi.mock("./chat/ChatHeader", () => ({
  ChatHeader: () => <button type="button">Header action</button>,
}));
vi.mock("./chat/ChatInput", () => ({
  ChatInput: () => <button type="button">Send message</button>,
}));
vi.mock("./chat/EmptyState", () => ({ EmptyState: () => null }));

const baseProps = {
  messages: [],
  isGenerating: true,
  hasValidSettings: true,
  onGenerate: vi.fn(async () => undefined),
  onStop: vi.fn(),
  onOpenSettings: vi.fn(),
  onSetFiles: vi.fn(),
  onImportProject: vi.fn(() => ({ ok: true as const })),
  files: {},
  template: "vite-react-ts",
  previewMode: "sandpack" as const,
  sandpackKey: 0,
  onReloadPreview: vi.fn(),
  isProjectInitialized: false,
  showInlinePreview: false,
  onCompressContext: vi.fn(async () => undefined),
  onRetry: vi.fn(async () => undefined),
  onContinue: vi.fn(async () => undefined),
  onReview: vi.fn(async () => undefined),
  onHealthCheck: vi.fn(async () => undefined),
};

describe("ChatInterface generation loading", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useInteractiveStore.setState({ pending: [] });
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("hides loading while any interactive tool is waiting for the user", () => {
    const { container } = render(<ChatInterface {...baseProps} />);
    expect(screen.getByRole("status")).toHaveTextContent("Thinking…");
    expect(container.firstElementChild).toHaveClass(
      "min-h-0",
      "overflow-hidden",
    );
    expect(screen.getByRole("status").parentElement).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
    );

    act(() => {
      void useInteractiveStore.getState().askPlanApproval({
        toolCallId: "plan-1",
        plan: "Plan",
      });
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => {
      useInteractiveStore.getState().resolvePlan("plan-1", { approved: true });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Thinking…");
  });

  it("owns the chat pane while a questionnaire is pending", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn(() =>
      useInteractiveStore.getState().rejectAllPending("stopped"),
    );
    const pending = useInteractiveStore
      .getState()
      .askQuestion({
        toolCallId: "question-1",
        questions: [
          {
            header: "Scope",
            question: "Which scope?",
            multiSelect: false,
            options: [{ label: "Current", description: "Current page" }],
          },
        ],
      })
      .catch(() => undefined);
    const { container } = render(
      <TooltipProvider>
        <ChatInterface {...baseProps} onStop={onStop} />
      </TooltipProvider>,
    );

    const dialog = screen.getByRole("dialog", {
      name: "AI Has a Question",
    });
    expect(dialog).toBeVisible();
    expect(container.querySelector(".contents")).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Header action" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeVisible();
    expect(
      (
        await axe(container, {
          rules: { "color-contrast": { enabled: false } },
        })
      ).violations,
    ).toEqual([]);

    await user.click(dialog);
    expect(onStop).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onStop).toHaveBeenCalledOnce();
    await pending;
  });
});
