// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../../store/settings";
import { useSkillsStore } from "../../../store/skills";
import { TooltipProvider } from "../../ui/tooltip";
import { ChatInputToolbar } from "./ChatInputToolbar";

const baseProps = {
  onPickImage: vi.fn(),
  onPickFile: vi.fn(),
  onUploadProject: vi.fn(),
  onManageSkills: undefined,
  onManageMcp: undefined,
  skillsAvailable: false,
  skillsInitializing: false,
  forcedSkillIds: [],
  onForcedSkillIdsChange: vi.fn(),
  workspaceMode: "auto" as const,
  setWorkspaceMode: vi.fn(),
  isGenerating: false,
  hasContent: false,
  isHoveringStop: false,
  onHoveringStopChange: vi.fn(),
  onStop: vi.fn(),
};

describe("ChatInputToolbar project upload", () => {
  beforeEach(() => {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useSkillsStore.setState({ skills: {}, _hasHydrated: true });
  });

  it("exposes upload project from the attachment menu", async () => {
    const user = userEvent.setup();
    const onUploadProject = vi.fn();
    render(
      <TooltipProvider>
        <ChatInputToolbar {...baseProps} onUploadProject={onUploadProject} />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    await user.click(screen.getByRole("menuitem", { name: /upload project/i }));
    expect(onUploadProject).toHaveBeenCalledOnce();
  });

  it("offers Code, Plan, and Design while preserving the auto value", async () => {
    const user = userEvent.setup();
    const setWorkspaceMode = vi.fn();
    render(
      <TooltipProvider>
        <ChatInputToolbar {...baseProps} setWorkspaceMode={setWorkspaceMode} />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Mode" }));
    expect(screen.getByRole("menuitem", { name: /Code/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Plan/ })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Design/ }));
    expect(setWorkspaceMode).toHaveBeenCalledWith("design");
  });

  it("shows the selected design-system name with a full accessible AI label", () => {
    render(
      <TooltipProvider>
        <ChatInputToolbar
          {...baseProps}
          workspaceMode="design"
          onManageDesignSystems={vi.fn()}
          designSystemName="Apple"
          designSystemLabel="Design system: Apple, selected by AI. Premium launch fit."
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: "Design system: Apple, selected by AI. Premium launch fit.",
      }),
    ).toHaveTextContent("Apple");
    expect(
      screen.getByRole("button", { name: "Mode" }).querySelector("svg"),
    ).toHaveClass("lucide-pencil-ruler");
  });

  it("disables project upload while generation is active", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ChatInputToolbar
          {...baseProps}
          isGenerating
          onUploadProject={vi.fn()}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Add attachment" }));
    expect(
      screen.getByRole("menuitem", { name: /upload project/i }),
    ).toHaveAttribute("data-disabled");
  });

  it("locks the request mode while generation is active", () => {
    render(
      <TooltipProvider>
        <ChatInputToolbar {...baseProps} isGenerating />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: "Mode" })).toBeDisabled();
  });

  it("switches the single runtime action between Stop and Send", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <TooltipProvider>
        <ChatInputToolbar {...baseProps} isGenerating onStop={onStop} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Send" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();

    rerender(
      <TooltipProvider>
        <ChatInputToolbar
          {...baseProps}
          isGenerating
          hasContent
          onStop={onStop}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <ChatInputToolbar
          {...baseProps}
          isGenerating
          hasContent
          isProcessingImages
          onStop={onStop}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Send" }),
    ).not.toBeInTheDocument();
  });

  it("shows tooltips for every toolbar button and keeps icon buttons square", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ChatInputToolbar
          {...baseProps}
          onUploadProject={vi.fn()}
          onManageSkills={vi.fn()}
          onManageMcp={vi.fn()}
          skillsAvailable
          hasContent
        />
      </TooltipProvider>,
    );

    const attachment = screen.getByRole("button", { name: "Add attachment" });
    const skills = screen.getByRole("button", { name: "Skills" });
    const mcp = screen.getByRole("button", { name: "MCP" });
    const mode = screen.getByRole("button", { name: "Mode" });
    const send = screen.getByRole("button", { name: "Send" });

    expect(attachment).toHaveClass("size-7");
    expect(skills).toHaveClass("size-7");
    expect(mcp).toHaveClass("size-7");
    expect(send).toHaveClass("size-7");

    for (const button of [attachment, skills, mcp, mode, send]) {
      expect(
        button.closest<HTMLElement>('[data-slot="tooltip-trigger"]'),
      ).not.toBeNull();
    }

    await user.hover(
      attachment.closest<HTMLElement>('[data-slot="tooltip-trigger"]')!,
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Add attachment",
    );
  });

  it("exposes the stop action through the same tooltip contract", () => {
    render(
      <TooltipProvider>
        <ChatInputToolbar
          {...baseProps}
          onUploadProject={vi.fn()}
          isGenerating
        />
      </TooltipProvider>,
    );

    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toHaveClass("size-7");
    const square = stop.querySelector(".lucide-square");
    expect(square).toHaveAttribute("width", "8");
    expect(square).toHaveAttribute("height", "8");
    expect(
      stop.closest<HTMLElement>('[data-slot="tooltip-trigger"]'),
    ).not.toBeNull();
  });

  it("lists auto-discoverable Skills without force or auto-off copy and preserves selection", async () => {
    const user = userEvent.setup();
    const onForcedSkillIdsChange = vi.fn();
    useSkillsStore.setState({
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

    render(
      <TooltipProvider>
        <ChatInputToolbar
          {...baseProps}
          onUploadProject={vi.fn()}
          onManageSkills={vi.fn()}
          skillsAvailable
          onForcedSkillIdsChange={onForcedSkillIdsChange}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Skills" }));
    expect(
      screen.getByText(/AI can discover Skills for a task/i),
    ).toBeVisible();
    expect(screen.queryByText(/force/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Auto-discovery off/i)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "Code review" }),
    );
    expect(onForcedSkillIdsChange).toHaveBeenCalledWith(["review"]);
  });

  it("hides disabled Skills, keeps management available, and shows a dedicated empty state", async () => {
    const user = userEvent.setup();
    const onManageSkills = vi.fn();
    useSkillsStore.setState({
      skills: {
        disabled: {
          id: "disabled",
          name: "Disabled skill",
          description: "Not discoverable",
          version: "1.0.0",
          autoEnabled: false,
          source: "imported",
          installedAt: 1,
        },
      },
    });

    render(
      <TooltipProvider>
        <ChatInputToolbar
          {...baseProps}
          onUploadProject={vi.fn()}
          onManageSkills={onManageSkills}
          skillsAvailable
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.queryByText("Disabled skill")).not.toBeInTheDocument();
    expect(
      screen.getByText("No auto-discoverable skills enabled."),
    ).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: /manage skills/i }));
    expect(onManageSkills).toHaveBeenCalledOnce();
  });

  it("removes a selected Skill as soon as auto-discovery is disabled", async () => {
    const onForcedSkillIdsChange = vi.fn();
    useSkillsStore.setState({
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

    render(
      <TooltipProvider>
        <ChatInputToolbar
          {...baseProps}
          onUploadProject={vi.fn()}
          onManageSkills={vi.fn()}
          skillsAvailable
          forcedSkillIds={["review"]}
          onForcedSkillIdsChange={onForcedSkillIdsChange}
        />
      </TooltipProvider>,
    );

    useSkillsStore.getState().setSkillAutoEnabled("review", false);

    await waitFor(() =>
      expect(onForcedSkillIdsChange).toHaveBeenCalledWith([]),
    );
  });
});
