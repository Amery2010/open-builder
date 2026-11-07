// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { useConversationStore } from "../../store/conversation";
import { useDesignSelectionStore } from "../../store/design-selection";
import { useSettingsStore } from "../../store/settings";
import { useSkillsStore } from "../../store/skills";
import type { DesignSelectionContext } from "../../types";
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
        protocolVersion: 2,
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

  it("shows a concise locator for runtime-selected elements and falls back safely", () => {
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

    const runtimeSelection = {
      protocolVersion: 2,
      elementId: "runtime-target",
      idSource: "runtime",
      anchorElementId: "hero-shell",
      sourceLocator: {
        path: [
          { tagName: "main", nthOfType: 1 },
          { tagName: "button", nthOfType: 2 },
        ],
      },
      label: "Primary action",
      tagName: "button",
      route: "/",
    } as DesignSelectionContext & {
      idSource: "runtime";
      anchorElementId: string;
      sourceLocator: {
        path: Array<{ tagName: string; nthOfType: number }>;
      };
    };

    act(() => {
      useDesignSelectionStore.getState().setSelection(id, runtimeSelection);
    });

    expect(
      screen.getByText("hero-shell › button:nth-of-type(2)"),
    ).toBeInTheDocument();
    expect(screen.queryByText("runtime-target")).not.toBeInTheDocument();

    act(() => {
      useDesignSelectionStore.getState().setSelection(id, {
        ...runtimeSelection,
        sourceLocator: { path: [] },
      });
    });
    expect(screen.getByText("runtime-target")).toBeInTheDocument();
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
      "focus-within:outline-ring/50",
      "focus-within:ring-ring/15",
    );
    act(() => useConversationStore.getState().setWorkspaceMode("plan"));
    rerender(
      <TooltipProvider>
        <ChatInput {...props} />
      </TooltipProvider>,
    );
    expect(document.querySelector('[data-workspace-mode="plan"]')).toHaveClass(
      "border-blue-500/50",
      "focus-within:outline-blue-500/50",
      "focus-within:ring-blue-500/15",
    );
    act(() => useConversationStore.getState().setWorkspaceMode("design"));
    rerender(
      <TooltipProvider>
        <ChatInput {...props} />
      </TooltipProvider>,
    );
    expect(
      document.querySelector('[data-workspace-mode="design"]'),
    ).toHaveClass(
      "border-violet-500/50",
      "focus-within:outline-violet-500/50",
      "focus-within:ring-violet-500/15",
    );
  });

  it("keeps focus feedback on the outer composer while the textarea stays ring-free", async () => {
    useConversationStore.getState().createConversation();
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

    const composer = document.querySelector('[data-workspace-mode="auto"]');
    const textarea = screen.getByRole("textbox");
    expect(composer).toHaveClass(
      "focus-within:outline-solid",
      "focus-within:outline-1",
      "focus-within:ring-2",
      "focus-within:ring-ring/15",
    );
    expect(textarea).toHaveClass(
      "border-0",
      "focus-visible:border-0",
      "focus-visible:ring-0",
    );

    await userEvent.click(textarea);
    expect(textarea).toHaveFocus();
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
