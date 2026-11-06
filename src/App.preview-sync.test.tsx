// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "./store/conversation";
import { flushPendingSandpackFileChanges } from "./components/code-viewer/sandpack-file-changes";
import type { ProjectFiles } from "./types";
import App from "./App";
import { TooltipProvider } from "./components/ui/tooltip";

const fixtures = vi.hoisted(() => ({
  sandpackKey: 0,
  desktopMode: false,
  template: "vite-react-ts",
  previewMode: "sandpack" as "sandpack" | "code-only",
  updateFiles: vi.fn(),
  projectFilesForSandpack: vi.fn(),
  logs: [],
}));

vi.mock("./hooks/useAppLayout", () => ({ useAppLayout: () => "desktop" }));
vi.mock("./hooks/useTheme", () => ({ useTheme: () => false }));
vi.mock("./hooks/useGlobalShortcuts", () => ({ useGlobalShortcuts: () => {} }));
vi.mock("./hooks/useCommandPaletteActions", () => ({
  useCommandPaletteActions: () => [],
}));
vi.mock("./hooks/useAppState", () => ({
  useAppState: () => {
    const conversation = useConversationStore(
      (state) => state.conversations[state.activeId!],
    );
    return {
      files: conversation.files,
      setFiles: vi.fn(),
      currentFile: conversation.activeFile ?? "src/App.tsx",
      setCurrentFile: useConversationStore.getState().setActiveFile,
      messages: [],
      setMessages: vi.fn(),
      isGenerating: false,
      setIsGenerating: vi.fn(),
      settings: {},
      hasConfiguredModelRuntime: true,
      isSettingsOpen: false,
      setIsSettingsOpen: vi.fn(),
      webSearchSettings: {},
      assetSearchSettings: {},
      systemSettings: {},
      template: fixtures.template,
      previewMode: fixtures.previewMode,
      setTemplate: vi.fn(),
      sandpackKey: fixtures.sandpackKey,
      restartSandpack: vi.fn(),
      isProjectInitialized: conversation.isProjectInitialized,
    };
  },
}));
vi.mock("./hooks/useGenerator", () => ({
  useGenerator: () => ({
    generate: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    continueTask: vi.fn(),
    updateFiles: fixtures.updateFiles,
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
    moveFile: vi.fn(),
    invalidateGenerator: vi.fn(),
    isThinkingStreaming: false,
  }),
}));
vi.mock("./components/ChatInterface", () => ({ ChatInterface: () => null }));
vi.mock("./components/AppLayout", () => ({
  AppLayout: ({ workspace }: { workspace: ReactNode }) => <>{workspace}</>,
}));
vi.mock("./components/command-palette/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("./lib/mcp/connection-manager", () => ({
  getMcpConnectionManager: () => ({ closeAll: vi.fn() }),
}));
vi.mock("./lib/project-assets/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/project-assets/core")>()),
  projectFilesForSandpack: fixtures.projectFilesForSandpack,
  getProjectAssetBlob: vi.fn(async () => null),
}));
vi.mock("./lib/design/desktop", () => ({
  supportsDesktopDesignTools: () => fixtures.desktopMode,
  exportProjectToUniqueDirectory: vi.fn(),
}));
vi.mock("./components/code-viewer/FileExplorer", () => ({
  FileExplorer: ({
    onCreateFile,
  }: {
    onCreateFile: (path: string) => void;
  }) => <button onClick={() => onCreateFile("src/new.ts")}>Create file</button>,
}));
vi.mock("./components/code-viewer/SandpackPreviewActions", () => ({
  SandpackActionButton: () => null,
  SandpackRefreshAction: () => null,
  SandpackRefreshRegistration: () => null,
}));
// Keep the real Provider and Listener. Only the browser-backed renderer/editor
// are replaced; edits still enter through Sandpack's actual updateFile API.
vi.mock("@codesandbox/sandpack-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@codesandbox/sandpack-react")>();
  return {
    ...actual,
    SandpackPreview: () => {
      const { sandpack } = actual.useSandpack();
      return (
        <output data-testid="preview-code">
          {sandpack.files["/src/App.tsx"]?.code}
        </output>
      );
    },
    SandpackCodeEditor: () => {
      const { sandpack } = actual.useSandpack();
      return (
        <textarea
          aria-label="Project code"
          data-runtime={sandpack.environment}
          value={sandpack.files[sandpack.activeFile]?.code ?? ""}
          onChange={(event) =>
            sandpack.updateFile(sandpack.activeFile, event.target.value)
          }
        />
      );
    },
    SandpackConsole: () => null,
    useSandpackConsole: () => ({ logs: fixtures.logs }),
  };
});

const initial = "export default () => <main>initial</main>";
const updated = "export default () => <main>host-updated</main>";
const typed = "export default () => <main>typed</main>";
const project = (content = initial): ProjectFiles => ({
  "src/App.tsx": content,
  "src/other.ts": "export const other = true;",
});
let conversationId: string;
const currentFiles = () =>
  useConversationStore.getState().conversations[conversationId].files;

async function mountProject() {
  const result = render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
  await screen.findByTestId("preview-code");
  return result;
}

function edit(content = typed) {
  fireEvent.change(
    screen.getByRole("textbox", { name: "Project code", hidden: true }),
    {
      target: { value: content },
    },
  );
}

function flush() {
  act(() => flushPendingSandpackFileChanges(conversationId));
}

describe("App Sandpack synchronization", () => {
  beforeEach(() => {
    fixtures.sandpackKey = 0;
    fixtures.desktopMode = false;
    fixtures.template = "vite-react-ts";
    fixtures.previewMode = "sandpack";
    fixtures.updateFiles.mockReset();
    fixtures.updateFiles.mockImplementation((path: string, content: string) => {
      useConversationStore
        .getState()
        .setFiles((files) => ({ ...files, [path]: content }));
    });
    fixtures.projectFilesForSandpack.mockReset();
    fixtures.projectFilesForSandpack.mockImplementation(
      async (files: ProjectFiles) => files,
    );
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
    conversationId = useConversationStore.getState().createConversation();
    useConversationStore.getState().setFiles(project());
    useConversationStore.getState().setActiveFile("src/App.tsx");
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    {
      desktop: true,
      template: "static",
      previewMode: "sandpack",
      environment: "parcel",
    },
    {
      desktop: false,
      template: "static",
      previewMode: "sandpack",
      environment: "static",
    },
    {
      desktop: true,
      template: "vite-react-ts",
      previewMode: "sandpack",
      environment: "node",
    },
    {
      desktop: true,
      template: "static",
      previewMode: "code-only",
      environment: "static",
    },
    {
      desktop: true,
      template: "vite-react-ts",
      previewMode: "code-only",
      environment: "static",
    },
  ] as const)(
    "selects $environment for desktop=$desktop, $template, $previewMode",
    async ({ desktop, template, previewMode, environment }) => {
      fixtures.desktopMode = desktop;
      fixtures.template = template;
      fixtures.previewMode = previewMode;
      const files =
        template === "static"
          ? {
              "index.html":
                '<h1>Static project</h1><script src="/main.js"></script>',
              "main.js":
                'document.querySelector("h1").textContent = "Updated";',
              "styles.css": "h1 { color: red; }",
            }
          : project();
      useConversationStore.getState().setFiles(files);
      useConversationStore
        .getState()
        .setActiveFile(template === "static" ? "index.html" : "src/App.tsx");
      render(
        <TooltipProvider>
          <App />
        </TooltipProvider>,
      );
      const editor = await screen.findByRole("textbox", {
        name: "Project code",
        hidden: true,
      });
      expect(editor).toHaveAttribute("data-runtime", environment);
      if (previewMode === "code-only") {
        expect(screen.queryByTestId("preview-code")).toBeNull();
      } else {
        expect(screen.getByTestId("preview-code")).toBeInTheDocument();
      }
      flush();
      expect(currentFiles()).toEqual(files);
      expect(fixtures.updateFiles).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps desktop static projection out of canonical HTML and commits real editor changes (design=%s)",
    async (design) => {
      fixtures.desktopMode = true;
      fixtures.template = "static";
      const html =
        '<!doctype html><html><head><style>h1{color:red}</style><link rel="stylesheet" href="/app.css"></head><body><main><h1>Canonical</h1></main></body></html>';
      useConversationStore
        .getState()
        .setFiles({ "index.html": html, "app.css": "main { padding: 12px; }" });
      useConversationStore.getState().setActiveFile("index.html");
      if (design) useConversationStore.getState().setWorkspaceMode("design");
      await mountProject();
      const editor = screen.getByRole("textbox", {
        name: "Project code",
        hidden: true,
      }) as HTMLTextAreaElement;
      expect(editor.value).toContain("open-builder-static-preview");
      flush();
      expect(currentFiles()["index.html"]).toBe(html);
      expect(fixtures.updateFiles).not.toHaveBeenCalled();
      fireEvent.change(editor, {
        target: { value: editor.value.replace("Canonical", "Edited") },
      });
      flush();
      expect(currentFiles()["index.html"]).toBe(
        html.replace("Canonical", "Edited"),
      );
      expect(currentFiles()["index.html"]).not.toContain(
        "open-builder-static-preview",
      );
    },
  );

  it("keeps the current preview mounted while the next asset projection is pending", async () => {
    const asset = {
      path: "public/logo.png",
      blobRef: `sha256:${"a".repeat(64)}`,
      digest: "a".repeat(64),
      mimeType: "image/png" as const,
      size: 8,
      modulePath: "src/generated-assets/logo.js",
      publicPath: "/logo.png",
    };
    useConversationStore
      .getState()
      .setAssetsForConversation(conversationId, { [asset.path]: asset });
    await mountProject();
    const previousPreview = screen.getByTestId("preview-code");
    let finishProjection!: (files: ProjectFiles) => void;
    fixtures.projectFilesForSandpack.mockImplementationOnce(
      () =>
        new Promise<ProjectFiles>((resolve) => {
          finishProjection = resolve;
        }),
    );

    act(() => useConversationStore.getState().setFiles(project(updated)));

    expect(currentFiles()["src/App.tsx"]).toBe(updated);
    expect(fixtures.updateFiles).not.toHaveBeenCalled();
    expect(screen.getByTestId("preview-code")).toBe(previousPreview);
    await act(async () => finishProjection(project(updated)));
    expect(screen.getByTestId("preview-code")).toBe(previousPreview);
    expect(await screen.findByTestId("preview-code")).toHaveTextContent(
      updated,
    );
  });

  it("rejects a pending editor write after Host changes and rebuilds the preview", async () => {
    const view = await mountProject();
    edit();
    act(() => {
      useConversationStore.getState().setFiles(project(updated));
      fixtures.sandpackKey += 1;
      view.rerender(
        <TooltipProvider>
          <App />
        </TooltipProvider>,
      );
    });

    expect(currentFiles()["src/App.tsx"]).toBe(updated);
    expect(fixtures.updateFiles).not.toHaveBeenCalled();
    expect(screen.getByTestId("preview-code")).toHaveTextContent(updated);
  });

  it("receives an ordinary Host update without rebuilding or writing it back", async () => {
    await mountProject();
    act(() => useConversationStore.getState().setFiles(project(updated)));
    expect(screen.getByTestId("preview-code")).toHaveTextContent(updated);
    flush();
    expect(currentFiles()["src/App.tsx"]).toBe(updated);
    expect(fixtures.updateFiles).not.toHaveBeenCalled();
  });

  it("preserves pending edits when only another Host file changed", async () => {
    const view = await mountProject();
    edit();
    act(() => {
      useConversationStore
        .getState()
        .setFiles({ ...project(), "src/other.ts": "host change" });
      fixtures.sandpackKey += 1;
      view.rerender(
        <TooltipProvider>
          <App />
        </TooltipProvider>,
      );
    });
    expect(currentFiles()["src/App.tsx"]).toBe(typed);
    expect(currentFiles()["src/other.ts"]).toBe("host change");
  });

  it("saves a pending edit before switching files", async () => {
    await mountProject();
    edit();
    act(() => useConversationStore.getState().setActiveFile("src/other.ts"));
    expect(currentFiles()["src/App.tsx"]).toBe(typed);
  });

  it("keeps direct file creation through the unguarded callback working", async () => {
    await mountProject();
    fireEvent.click(screen.getByText("Create file"));
    expect(currentFiles()).toHaveProperty("src/new.ts", "// New file\n");
    expect(fixtures.updateFiles).toHaveBeenCalledWith(
      "src/new.ts",
      "// New file\n",
    );
  });

  it("saves real edits, including an empty file", async () => {
    await mountProject();
    edit();
    flush();
    expect(currentFiles()["src/App.tsx"]).toBe(typed);
    edit("");
    flush();
    expect(currentFiles()["src/App.tsx"]).toBe("");
  });

  it("saves a pending edit to its original Conversation after switching", async () => {
    await mountProject();
    edit();
    act(() => {
      const otherId = useConversationStore.getState().createConversation();
      useConversationStore.getState().setFiles(project(updated));
      useConversationStore.getState().setActiveFile("src/App.tsx");
      expect(otherId).not.toBe(conversationId);
    });
    await waitFor(() => expect(currentFiles()["src/App.tsx"]).toBe(typed));
    expect(
      useConversationStore.getState().conversations[
        useConversationStore.getState().activeId!
      ].files["src/App.tsx"],
    ).toBe(updated);
  });

  it.each(["delete", "reset"])(
    "does not resurrect files after %s",
    async (operation) => {
      const view = await mountProject();
      edit();
      act(() => {
        if (operation === "reset")
          useConversationStore.getState().resetProject();
        else
          useConversationStore
            .getState()
            .setFiles({ "src/other.ts": project()["src/other.ts"] });
        fixtures.sandpackKey += 1;
        view.rerender(
          <TooltipProvider>
            <App />
          </TooltipProvider>,
        );
      });
      flush();
      expect(currentFiles()).not.toHaveProperty("src/App.tsx");
      expect(fixtures.updateFiles).not.toHaveBeenCalled();
    },
  );
});
