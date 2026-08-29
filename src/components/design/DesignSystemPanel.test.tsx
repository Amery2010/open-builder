// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { useConversationStore } from "../../store/conversation";
import { useSettingsStore } from "../../store/settings";
import {
  DesignSystemRegistry,
  MemoryDesignSystemStorage,
} from "../../lib/design-systems/registry";
import { DesignSystemPanel } from "./DesignSystemPanel";
import { stageDesignSystemFiles } from "../../lib/design-systems/importer";

const validTokens = `:root {
  --bg: #fff;
  --surface: #f4f4f5;
  --fg: #18181b;
  --muted: #71717a;
  --border: #d4d4d8;
  --accent: #6d28d9;
  --accent-on: #fff;
  --font-display: ui-sans-serif;
  --font-body: ui-sans-serif;
  --radius-md: 0.75rem;
  --section-y-desktop: 6rem;
  --container-max: 72rem;
  --motion-base: 180ms;
}`;

async function customPackage() {
  return stageDesignSystemFiles(
    [
      {
        path: "manifest.json",
        content: JSON.stringify({
          schemaVersion: "open-builder-design-system/v1",
          id: "custom-quiet-workshop",
          name: "Quiet Workshop",
          description: "Calm and precise.",
          source: { kind: "custom" },
          files: { design: "DESIGN.md", tokens: "tokens.css" },
        }),
      },
      { path: "DESIGN.md", content: "# Quiet Workshop" },
      { path: "tokens.css", content: validTokens },
    ],
    "custom",
  );
}

const stripe = {
  id: "stripe",
  name: "Stripe",
  source: "builtin" as const,
  version: "pinned",
  digest: "a".repeat(64),
};
const claude = {
  id: "claude",
  name: "Claude",
  source: "builtin" as const,
  version: "pinned",
  digest: "b".repeat(64),
};

describe("DesignSystemPanel", () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });

  it("applies a different system as soon as it is selected", async () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({ "src/App.tsx": "existing" });
    const stagedCustom = await customPackage();
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    const quietWorkshop = await registry.confirmImport(stagedCustom.package);
    useConversationStore.getState().setDesignState({
      appliedSystem: claude,
    });
    const onApply = vi.fn(async () => {});
    const onOpenChange = vi.fn();

    render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={onOpenChange}
          onApply={onApply}
          isGenerating={false}
          registry={registry}
        />
      </TooltipProvider>,
    );

    expect(useConversationStore.getState().conversations[id].files).toEqual({
      "src/App.tsx": "existing",
    });
    await userEvent.click(
      await screen.findByRole("button", { name: /Quiet Workshop/i }),
    );
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onApply).toHaveBeenCalledWith(quietWorkshop.id);
    });
    expect(
      useConversationStore.getState().conversations[id].designState
        ?.selectedSystem,
    ).toMatchObject({ id: quietWorkshop.id, source: "custom" });
    expect(useConversationStore.getState().conversations[id].files).toEqual({
      "src/App.tsx": "existing",
    });
    expect(
      screen.queryByRole("button", { name: "Apply to page" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the catalog open with a retryable error when application fails", async () => {
    useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({ "src/App.tsx": "existing" });
    const stagedCustom = await customPackage();
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    await registry.confirmImport(stagedCustom.package);
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={onOpenChange}
          onApply={vi.fn(async () => {
            throw new Error("contract application failed");
          })}
          isGenerating={false}
          registry={registry}
        />
      </TooltipProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /Quiet Workshop/i }),
    );
    expect(
      await screen.findByText(/contract application failed/i),
    ).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(
      screen.getByRole("heading", { name: "Design systems" }),
    ).toBeVisible();
  });

  it("does not reapply a system whose digest already matches", async () => {
    useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({
      "src/App.tsx": "existing",
      "tokens.css": validTokens,
    });
    const stagedCustom = await customPackage();
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    const quietWorkshop = await registry.confirmImport(stagedCustom.package);
    useConversationStore.getState().setDesignState({
      selectedSystem: quietWorkshop,
      appliedSystem: quietWorkshop,
    });
    const onApply = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={onOpenChange}
          onApply={onApply}
          isGenerating={false}
          registry={registry}
        />
      </TooltipProvider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Quiet Workshop/i }),
    );
    expect(
      screen.getByRole("button", { name: /Quiet Workshop/i }),
    ).toHaveTextContent("Applied");
    expect(onApply).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reapplies a matching digest when the token contract is missing", async () => {
    useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({ "src/App.tsx": "existing" });
    const stagedCustom = await customPackage();
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    const quietWorkshop = await registry.confirmImport(stagedCustom.package);
    useConversationStore.getState().setDesignState({
      selectedSystem: quietWorkshop,
      appliedSystem: quietWorkshop,
    });
    const onApply = vi.fn(async () => {});
    render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={vi.fn()}
          onApply={onApply}
          isGenerating={false}
          registry={registry}
        />
      </TooltipProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /Quiet Workshop/i }),
    );
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(quietWorkshop.id));
  });

  it("shows Applied only when the current token contract is ready", () => {
    useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({
      "src/App.tsx": "existing",
      "tokens.css": validTokens,
    });
    useConversationStore.getState().setDesignState({
      selectedSystem: claude,
      appliedSystem: claude,
    });
    const { rerender } = render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={vi.fn()}
          onApply={vi.fn()}
          isGenerating={false}
          registry={new DesignSystemRegistry(new MemoryDesignSystemStorage())}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: /Claude/i })).toHaveTextContent(
      "Applied",
    );
    useConversationStore.getState().setFiles({ "src/App.tsx": "existing" });
    rerender(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={vi.fn()}
          onApply={vi.fn()}
          isGenerating={false}
          registry={new DesignSystemRegistry(new MemoryDesignSystemStorage())}
        />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: /Claude/i }),
    ).not.toHaveTextContent("Applied");
  });

  it("stores a selection without applying it before project initialization", async () => {
    const id = useConversationStore.getState().createConversation();
    const stagedCustom = await customPackage();
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    const quietWorkshop = await registry.confirmImport(stagedCustom.package);
    const onApply = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={onOpenChange}
          onApply={onApply}
          isGenerating={false}
          canApplyProject={false}
          registry={registry}
        />
      </TooltipProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /Quiet Workshop/i }),
    );
    expect(onApply).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(
      useConversationStore.getState().conversations[id].designState
        ?.selectedSystem,
    ).toMatchObject({ id: quietWorkshop.id, source: "custom" });
  });

  it("does not apply a loaded selection after the active conversation changes", async () => {
    const firstId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles({ "src/App.tsx": "existing" });
    const stagedCustom = await customPackage();
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    await registry.confirmImport(stagedCustom.package);
    let resolveLoad: (value: typeof stagedCustom.package) => void = () => {};
    const pendingLoad = new Promise<typeof stagedCustom.package>((resolve) => {
      resolveLoad = resolve;
    });
    const onApply = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={onOpenChange}
          onApply={onApply}
          isGenerating={false}
          registry={registry}
        />
      </TooltipProvider>,
    );

    const choice = await screen.findByRole("button", {
      name: /Quiet Workshop/i,
    });
    vi.spyOn(registry, "loadImported").mockReturnValue(pendingLoad);
    await userEvent.click(choice);
    expect(choice).toBeDisabled();
    const secondId = useConversationStore.getState().createConversation();
    resolveLoad(stagedCustom.package);
    await waitFor(() => expect(choice).toBeEnabled());

    expect(onApply).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      useConversationStore.getState().conversations[firstId].designState
        ?.selectedSystem,
    ).toBeUndefined();
    expect(
      useConversationStore.getState().conversations[secondId].designState
        ?.selectedSystem,
    ).toBeUndefined();
  });

  it("uses a bounded scroll region and lazy decorative previews", () => {
    useConversationStore.getState().createConversation();
    render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={vi.fn()}
          onApply={vi.fn()}
          isGenerating={false}
          registry={new DesignSystemRegistry(new MemoryDesignSystemStorage())}
        />
      </TooltipProvider>,
    );

    const scrollRegion = screen.getByTestId("design-system-scroll-region");
    expect(scrollRegion).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
      "overscroll-contain",
    );
    const catalogButtons: HTMLElement[] = Array.from(
      scrollRegion.querySelectorAll<HTMLButtonElement>("button"),
    );
    const automaticButton = screen.getByRole("button", {
      name: /Re-evaluate automatically/i,
    });
    expect(
      catalogButtons.indexOf(
        screen.getByRole("button", { name: /New custom/i }),
      ),
    ).toBeLessThan(catalogButtons.indexOf(automaticButton));
    expect(
      catalogButtons.indexOf(screen.getByRole("button", { name: "ZIP" })),
    ).toBeLessThan(catalogButtons.indexOf(automaticButton));
    expect(
      catalogButtons.indexOf(screen.getByRole("button", { name: "Folder" })),
    ).toBeLessThan(catalogButtons.indexOf(automaticButton));
    expect(
      screen.queryByRole("button", { name: "Apply to page" }),
    ).not.toBeInTheDocument();
    const previews = document.querySelectorAll(
      '[role="dialog"] img[src^="/design-systems/previews/"]',
    );
    expect(previews).toHaveLength(12);
    for (const preview of previews) {
      expect(preview).toHaveAttribute("loading", "lazy");
      expect(preview).toHaveAttribute("decoding", "async");
      expect(preview).toHaveAttribute("aria-hidden", "true");
      expect(preview.getAttribute("src")).toMatch(
        /^\/design-systems\/previews\/.+\.webp$/,
      );
    }
  });

  it("switches to an inline custom view, preserves selection on return, and creates a validated system", async () => {
    const user = userEvent.setup();
    const id = useConversationStore.getState().createConversation();
    useConversationStore.getState().setDesignState({
      selectedSystem: stripe,
      appliedSystem: claude,
    });
    const stagedCustom = await customPackage();
    const onCompileCustom = vi.fn(async () => stagedCustom);
    const registry = new DesignSystemRegistry(new MemoryDesignSystemStorage());
    render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={vi.fn()}
          onApply={vi.fn()}
          onCompileCustom={onCompileCustom}
          isGenerating={false}
          registry={registry}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /New custom/i }));
    expect(
      screen.getByRole("heading", { name: "Create a custom design system" }),
    ).toBeVisible();
    expect(
      useConversationStore.getState().conversations[id].designState
        ?.selectedSystem?.id,
    ).toBe("stripe");
    await user.click(screen.getByRole("button", { name: /Back to systems/i }));
    expect(
      screen.getByRole("heading", { name: "Design systems" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: /New custom/i }));
    await user.type(screen.getByLabelText("Name"), "Quiet Workshop");
    await user.type(
      screen.getByLabelText("Visual mood and references"),
      "Calm and tactile.",
    );
    await user.type(
      screen.getByLabelText("Color, typography, and shape"),
      "Warm neutrals and compact radii.",
    );
    await user.type(
      screen.getByLabelText("Layout, components, and interaction"),
      "A strong grid with restrained motion.",
    );
    await user.click(screen.getByRole("button", { name: "Create and select" }));

    await waitFor(() => expect(onCompileCustom).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        useConversationStore.getState().conversations[id].designState
          ?.selectedSystem,
      ).toMatchObject({
        id: "custom-quiet-workshop",
        name: "Quiet Workshop",
        source: "custom",
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Design systems" }),
    ).toBeVisible();
    expect(
      document.querySelector('img[src="/design-systems/previews/custom.webp"]'),
    ).not.toBeNull();
  });

  it("resets automatic selection without changing the applied package", async () => {
    const id = useConversationStore.getState().createConversation();
    useConversationStore.getState().setDesignState({
      selectedSystem: stripe,
      appliedSystem: claude,
      recommendation: {
        systemId: "stripe",
        reason: "Matched the request.",
        createdAt: 1,
      },
    });
    render(
      <TooltipProvider>
        <DesignSystemPanel
          open
          onOpenChange={vi.fn()}
          onApply={vi.fn()}
          isGenerating={false}
          registry={new DesignSystemRegistry(new MemoryDesignSystemStorage())}
        />
      </TooltipProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Re-evaluate automatically/i }),
    );
    expect(
      useConversationStore.getState().conversations[id].designState,
    ).toMatchObject({ appliedSystem: claude, autoSelectionError: false });
    expect(
      useConversationStore.getState().conversations[id].designState
        ?.selectedSystem,
    ).toBeUndefined();
    expect(
      useConversationStore.getState().conversations[id].designState
        ?.recommendation,
    ).toBeUndefined();
  });
});
