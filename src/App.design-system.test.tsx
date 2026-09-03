// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useConversationStore } from "./store/conversation";
import type { DesignSystemPackage } from "./lib/design-systems/validation";
import App from "./App";

type MockGenerate = (
  prompt: string,
  attachments?: unknown,
  options?: {
    prepareRun?: () => Promise<void>;
    designExpectedChangeModes?: readonly string[];
  },
) => Promise<void>;

const runtime = vi.hoisted(() => ({
  events: [] as string[],
  generate: vi.fn<MockGenerate>(async () => {}),
  generateUtilityText: vi.fn(),
  invalidateGenerator: vi.fn(),
  loadPackage: vi.fn(),
}));
const fixtures = vi.hoisted(() => ({
  projectFiles: {} as Record<string, string>,
  isProjectInitialized: true,
}));

vi.mock("./hooks/useAppLayout", () => ({ useAppLayout: () => "desktop" }));
vi.mock("./hooks/useTheme", () => ({ useTheme: () => false }));
vi.mock("./hooks/useGlobalShortcuts", () => ({
  useGlobalShortcuts: () => undefined,
}));
vi.mock("./hooks/useCommandPaletteActions", () => ({
  useCommandPaletteActions: () => [],
}));
vi.mock("./hooks/useAppState", () => ({
  useAppState: () => ({
    files: fixtures.projectFiles,
    setFiles: vi.fn(),
    currentFile: "src/App.tsx",
    setCurrentFile: vi.fn(),
    messages: [],
    setMessages: vi.fn(),
    isGenerating: false,
    setIsGenerating: vi.fn(),
    settings: {},
    hasConfiguredModelRuntime: true,
    localCliStatusNotice: null,
    isSettingsOpen: false,
    setIsSettingsOpen: vi.fn(),
    handleSaveSettings: vi.fn(),
    webSearchSettings: {},
    handleSaveWebSearchSettings: vi.fn(),
    assetSearchSettings: {},
    handleSaveAssetSearchSettings: vi.fn(),
    systemSettings: {},
    handleSaveSystemSettings: vi.fn(),
    template: "vite-react-ts",
    previewMode: "sandpack",
    setTemplate: vi.fn(),
    sandpackKey: 0,
    restartSandpack: vi.fn(),
    isProjectInitialized: fixtures.isProjectInitialized,
  }),
}));
vi.mock("./hooks/useGenerator", () => ({
  useGenerator: () => ({
    generate: runtime.generate,
    stop: vi.fn(),
    retry: vi.fn(),
    continueTask: vi.fn(),
    updateFiles: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
    moveFile: vi.fn(),
    compressContext: vi.fn(),
    review: vi.fn(),
    healthCheck: vi.fn(),
    designReview: vi.fn(),
    automaticDesignReview: vi.fn(),
    automaticDesignReviewUnavailable: vi.fn(),
    invalidateGenerator: runtime.invalidateGenerator,
    isThinkingStreaming: false,
    generateUtilityText: runtime.generateUtilityText,
  }),
}));
vi.mock("./components/ChatInterface", () => ({
  ChatInterface: ({
    onApplyDesignSystem,
    onGenerate,
  }: {
    onApplyDesignSystem: (id: string) => Promise<void>;
    onGenerate: (prompt: string) => Promise<void>;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          void onApplyDesignSystem("stripe").catch(() => undefined)
        }
      >
        Apply selected system
      </button>
      <button type="button" onClick={() => void onGenerate("Redesign it")}>
        Generate design
      </button>
    </>
  ),
}));
vi.mock("./components/AppLayout", () => ({
  AppLayout: ({ chat }: { chat: ReactNode }) => <>{chat}</>,
}));
vi.mock("./components/command-palette/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("./lib/design-systems/registry", () => ({
  getDesignSystemRegistry: () => ({
    load: runtime.loadPackage,
    listImported: vi.fn(async () => []),
  }),
}));
vi.mock("./lib/mcp/connection-manager", () => ({
  getMcpConnectionManager: () => ({ closeAll: vi.fn() }),
  handleMcpOAuthCallbackFromLocation: vi.fn(),
}));

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

const stripe = {
  id: "stripe",
  name: "Stripe",
  source: "builtin" as const,
  version: "2.0.0",
  digest: "a".repeat(64),
};

const designPackage: DesignSystemPackage = {
  manifest: {
    schemaVersion: "open-builder-design-system/v1",
    id: "stripe",
    name: "Stripe",
    files: { design: "DESIGN.md", tokens: "tokens.css" },
  },
  manifestText: "{}",
  design: "# Stripe reference",
  tokens: validTokens,
  digest: stripe.digest,
  reference: stripe,
};

describe("App Design system application", () => {
  beforeEach(() => {
    runtime.events = [];
    runtime.generate.mockReset();
    runtime.invalidateGenerator.mockReset();
    runtime.loadPackage.mockReset();
    runtime.generateUtilityText.mockReset();
    runtime.generateUtilityText.mockResolvedValue(
      JSON.stringify({
        action: "apply",
        systemId: "stripe",
        reason: "The redesign benefits from the Stripe system.",
      }),
    );
    runtime.generate.mockImplementation(
      async (_prompt, _attachments, options) => {
        await options?.prepareRun?.();
        runtime.events.push("generate");
      },
    );
    runtime.invalidateGenerator.mockImplementation(() => {
      runtime.events.push("invalidate");
    });
    runtime.loadPackage.mockResolvedValue(designPackage);
    fixtures.projectFiles = {
      "src/App.tsx": "export default () => null",
    };
    fixtures.isProjectInitialized = true;
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
    const id = useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles(fixtures.projectFiles);
    useConversationStore.getState().setWorkspaceMode("design");
    useConversationStore.getState().setDesignState({
      selectedSystem: stripe,
    });
    expect(useConversationStore.getState().activeId).toBe(id);
  });

  it("commits a ready contract, invalidates stale generator files, then restyles", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Apply selected system" }),
    );
    await waitFor(() => expect(runtime.generate).toHaveBeenCalledOnce());

    const state = useConversationStore.getState();
    const conversation = state.conversations[state.activeId!];
    expect(conversation.files["DESIGN.md"]).toContain("# Stripe reference");
    expect(conversation.files["tokens.css"]).toContain("--motion-base");
    expect(conversation.designState?.appliedSystem).toEqual(stripe);
    expect(runtime.events).toEqual(["invalidate", "generate"]);
    expect(runtime.generate).toHaveBeenCalledWith(
      expect.stringContaining("already applied"),
      undefined,
      { skipAutoQa: true, designExpectedChangeModes: ["migrate"] },
    );
  });

  it("auto-applies a selected package before an initialized Design run", async () => {
    useConversationStore.getState().setDesignState(undefined);
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Generate design" }));
    await waitFor(() => expect(runtime.generate).toHaveBeenCalledOnce());

    const state = useConversationStore.getState();
    const conversation = state.conversations[state.activeId!];
    expect(conversation.designState).toMatchObject({
      selectedSystem: stripe,
      appliedSystem: stripe,
      recommendation: { systemId: "stripe" },
    });
    expect(conversation.files["DESIGN.md"]).toContain("# Stripe reference");
    expect(conversation.files["tokens.css"]).toContain("--motion-base");
    expect(runtime.generate.mock.calls[0][2]).toMatchObject({
      designExpectedChangeModes: ["migrate"],
      prepareRun: expect.any(Function),
    });
  });

  it("keeps an automatic selection deferred for an empty project", async () => {
    fixtures.projectFiles = {};
    fixtures.isProjectInitialized = false;
    useConversationStore.getState().setFiles({});
    useConversationStore.getState().setDesignState(undefined);
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Generate design" }));
    await waitFor(() => expect(runtime.generate).toHaveBeenCalledOnce());

    const state = useConversationStore.getState();
    const conversation = state.conversations[state.activeId!];
    expect(conversation.designState).toMatchObject({
      selectedSystem: stripe,
      recommendation: { systemId: "stripe" },
    });
    expect(conversation.designState?.appliedSystem).toBeUndefined();
    expect(conversation.files).not.toHaveProperty("DESIGN.md");
    expect(conversation.files).not.toHaveProperty("tokens.css");
  });

  it("keeps an applied system without rerouting an ordinary Design request", async () => {
    useConversationStore.getState().setDesignState({
      selectedSystem: stripe,
      appliedSystem: stripe,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Generate design" }));
    await waitFor(() => expect(runtime.generate).toHaveBeenCalledOnce());

    expect(runtime.generateUtilityText).not.toHaveBeenCalled();
    expect(
      useConversationStore.getState().conversations[
        useConversationStore.getState().activeId!
      ].designState?.appliedSystem,
    ).toEqual(stripe);
  });

  it("keeps an existing valid contract when loading the new package fails", async () => {
    const state = useConversationStore.getState();
    const conversationId = state.activeId!;
    const previous = { ...stripe, id: "claude", name: "Claude" };
    state.setFiles({ ...fixtures.projectFiles, "tokens.css": validTokens });
    state.setDesignState({ selectedSystem: stripe, appliedSystem: previous });
    runtime.loadPackage.mockRejectedValueOnce(new Error("package unavailable"));
    const beforeFiles = {
      ...useConversationStore.getState().conversations[conversationId].files,
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Apply selected system" }),
    );
    await waitFor(() => expect(runtime.loadPackage).toHaveBeenCalledOnce());

    const conversation =
      useConversationStore.getState().conversations[conversationId];
    expect(conversation.files).toEqual(beforeFiles);
    expect(conversation.designState?.appliedSystem).toEqual(previous);
    expect(runtime.invalidateGenerator).not.toHaveBeenCalled();
    expect(runtime.generate).not.toHaveBeenCalled();
  });
});
