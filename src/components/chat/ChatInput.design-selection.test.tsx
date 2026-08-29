// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { useConversationStore } from "../../store/conversation";
import { useDesignSelectionStore } from "../../store/design-selection";
import { useSettingsStore } from "../../store/settings";
import { useSkillsStore } from "../../store/skills";
import { ChatInput } from "./ChatInput";

describe("ChatInput Design selection context", () => {
  beforeEach(() => {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
    useDesignSelectionStore.setState({ selections: {} });
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useSkillsStore.setState({ skills: {}, _hasHydrated: true });
  });

  it("shows a closable element context above the composer", async () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    render(
      <TooltipProvider>
        <ChatInput
          input=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          onStop={vi.fn()}
          isGenerating={false}
          messages={[]}
          attachments={[]}
          onAttachmentsChange={vi.fn()}
          onImportProject={vi.fn(() => ({ ok: true as const }))}
          hasExistingProject
          onSlashCommand={vi.fn()}
          forcedSkillIds={[]}
          onForcedSkillIdsChange={vi.fn()}
          onApplyDesignSystem={vi.fn()}
        />
      </TooltipProvider>,
    );

    act(() => {
      useDesignSelectionStore.getState().setSelection(id, {
        protocolVersion: 1,
        elementId: "pricing-card-pro",
        label: "Pro plan",
        tagName: "article",
        route: "/pricing",
      });
    });

    expect(screen.getByLabelText("Selected preview element")).toHaveTextContent(
      "Editing Pro plan",
    );
    expect(screen.getByText("pricing-card-pro")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Clear selected element" }),
    );
    expect(
      screen.queryByLabelText("Selected preview element"),
    ).not.toBeInTheDocument();
  });

  it("uses distinct Plan and Design borders while Code remains neutral", () => {
    useConversationStore.getState().createConversation();
    const props = {
      input: "",
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onStop: vi.fn(),
      isGenerating: false,
      messages: [],
      attachments: [],
      onAttachmentsChange: vi.fn(),
      onImportProject: vi.fn(() => ({ ok: true as const })),
      hasExistingProject: true,
      onSlashCommand: vi.fn(),
      forcedSkillIds: [],
      onForcedSkillIdsChange: vi.fn(),
      onApplyDesignSystem: vi.fn(),
    };
    const { rerender } = render(
      <TooltipProvider>
        <ChatInput {...props} />
      </TooltipProvider>,
    );

    expect(document.querySelector('[data-workspace-mode="auto"]')).toHaveClass(
      "border-input",
      "focus-within:ring-ring",
    );
    act(() => useConversationStore.getState().setWorkspaceMode("plan"));
    rerender(
      <TooltipProvider>
        <ChatInput {...props} />
      </TooltipProvider>,
    );
    expect(document.querySelector('[data-workspace-mode="plan"]')).toHaveClass(
      "border-blue-500/60",
      "focus-within:ring-blue-500/25",
    );
    act(() => useConversationStore.getState().setWorkspaceMode("design"));
    rerender(
      <TooltipProvider>
        <ChatInput {...props} />
      </TooltipProvider>,
    );
    expect(
      document.querySelector('[data-workspace-mode="design"]'),
    ).toHaveClass("border-violet-500/60", "focus-within:ring-violet-500/25");
  });

  it("shows Auto, AI-selected, and None design-system labels", () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.getState().setWorkspaceMode("design");
    const props = {
      input: "",
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onStop: vi.fn(),
      isGenerating: false,
      messages: [],
      attachments: [],
      onAttachmentsChange: vi.fn(),
      onImportProject: vi.fn(() => ({ ok: true as const })),
      hasExistingProject: true,
      onSlashCommand: vi.fn(),
      forcedSkillIds: [],
      onForcedSkillIdsChange: vi.fn(),
      onApplyDesignSystem: vi.fn(),
    };
    const { rerender } = render(
      <TooltipProvider>
        <ChatInput {...props} />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: /Design system: Auto/i }),
    ).toHaveTextContent("Auto");

    act(() => {
      useConversationStore.getState().setDesignStateForConversation(id, {
        selectedSystem: {
          id: "apple",
          name: "Apple",
          source: "builtin",
          version: "2.0.0",
          digest: "a".repeat(64),
        },
        recommendation: {
          systemId: "apple",
          reason: "A focused launch fit.",
          createdAt: 1,
        },
      });
    });
    rerender(
      <TooltipProvider>
        <ChatInput {...props} />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: /selected by AI/i }),
    ).toHaveTextContent("Apple");

    act(() => {
      useConversationStore.getState().setDesignStateForConversation(id, {
        recommendation: {
          systemId: null,
          reason: "No close match.",
          createdAt: 2,
        },
      });
    });
    rerender(
      <TooltipProvider>
        <ChatInput {...props} />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: /No close match/i }),
    ).toHaveTextContent("None");
  });
});
