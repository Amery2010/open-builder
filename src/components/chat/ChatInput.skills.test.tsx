// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { useDesignSelectionStore } from "../../store/design-selection";
import { useSettingsStore } from "../../store/settings";
import { useSkillsStore } from "../../store/skills";
import { TooltipProvider } from "../ui/tooltip";
import { ChatInput } from "./ChatInput";

describe("ChatInput selected Skills", () => {
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
    useSkillsStore.setState({
      _hasHydrated: true,
      skills: {
        review: {
          id: "review",
          name: "Code review",
          description: "Review code changes",
          version: "1.0.0",
          autoEnabled: true,
          source: "builtin",
          installedAt: 1,
        },
      },
    });
  });

  it("shows only transparent removable Skill chips above the composer", async () => {
    const user = userEvent.setup();
    const onForcedSkillIdsChange = vi.fn();
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
          forcedSkillIds={["review"]}
          onForcedSkillIdsChange={onForcedSkillIdsChange}
          onApplyDesignSystem={vi.fn()}
        />
      </TooltipProvider>,
    );

    const selection = screen.getByLabelText("Selected Skills");
    expect(within(selection).queryByText("Selected Skills")).toBeNull();
    expect(selection).toHaveTextContent("Code review");

    const chip = screen.getByRole("button", {
      name: "Remove selected Skill Code review",
    });
    expect(chip).toHaveClass("bg-transparent");
    expect(chip).not.toHaveClass("bg-primary/10");

    await user.click(chip);
    expect(onForcedSkillIdsChange).toHaveBeenCalledWith([]);
  });
});
