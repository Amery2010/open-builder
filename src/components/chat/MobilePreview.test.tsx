// @vitest-environment jsdom

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversation";
import { TooltipProvider } from "../ui/tooltip";
import { MobilePreview } from "./MobilePreview";

const refresh = vi.fn();
const projectFilesForSandpack = vi.hoisted(() =>
  vi.fn(async (files: Record<string, string>) => files),
);
const sandpackMock = vi.hoisted(() => ({
  error: null as Error | null,
  files: {} as Record<string, { code: string }>,
}));

vi.mock("@codesandbox/sandpack-react", async (importOriginal) => ({
  SANDBOX_TEMPLATES: (
    await importOriginal<typeof import("@codesandbox/sandpack-react")>()
  ).SANDBOX_TEMPLATES,
  SandpackProvider: ({
    children,
    files,
  }: {
    children: ReactNode;
    files: Record<string, { code: string }>;
  }) => {
    sandpackMock.files = files;
    if (sandpackMock.error) throw sandpackMock.error;
    return <div>{children}</div>;
  },
  SandpackPreview: ({
    actionsChildren,
    showRefreshButton,
    showRestartButton,
  }: {
    actionsChildren?: ReactNode;
    showRefreshButton?: boolean;
    showRestartButton?: boolean;
  }) => (
    <div
      data-refresh={String(showRefreshButton)}
      data-restart={String(showRestartButton)}
    >
      {actionsChildren}
    </div>
  ),
  useSandpackNavigation: () => ({ refresh }),
}));

vi.mock("../code-viewer/SandpackRuntimeSync", () => ({
  SandpackRuntimeSync: () => null,
}));

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => false }));

vi.mock("../../lib/project-assets/core", () => ({
  projectFilesForSandpack,
}));

describe("MobilePreview", () => {
  beforeEach(() => {
    projectFilesForSandpack.mockImplementation(
      async (files: Record<string, string>) => files,
    );
    sandpackMock.error = null;
    useConversationStore.setState({ activeId: null, conversations: {} });
  });

  it("uses the Vite clear-screen workaround for mobile previews too", () => {
    const files = {
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    };
    render(
      <TooltipProvider>
        <MobilePreview
          files={files}
          template="vite-react"
          sandpackKey={0}
          onReloadPreview={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(
      JSON.parse(sandpackMock.files["/package.json"].code).scripts.dev,
    ).toBe("vite --clearScreen false");
    expect(JSON.parse(files["package.json"]).scripts.dev).toBe("vite");
  });

  it("rebuilds the preview through its owner", async () => {
    const user = userEvent.setup();
    const onReloadPreview = vi.fn();
    refresh.mockClear();
    render(
      <TooltipProvider>
        <MobilePreview
          files={{ "index.html": "<body />" }}
          template="static"
          sandpackKey={0}
          onReloadPreview={onReloadPreview}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Reload preview" }));
    expect(refresh).not.toHaveBeenCalled();
    expect(onReloadPreview).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-refresh='false']")).not.toBeNull();
    expect(document.querySelector("[data-restart='false']")).not.toBeNull();
  });

  it("disables preview when an asset Blob cannot be projected", async () => {
    const user = userEvent.setup();
    projectFilesForSandpack.mockRejectedValueOnce(
      new Error("Project asset is unavailable locally."),
    );
    useConversationStore.setState({
      activeId: "conversation-a",
      conversations: {
        "conversation-a": {
          assets: {
            "public/logo.png": {
              path: "public/logo.png",
              blobRef: "sha256:asset",
              digest: "asset",
              mimeType: "image/png",
              size: 1,
              modulePath: "src/generated-assets/logo.js",
              publicPath: "/logo.png",
            },
          },
        },
      } as never,
    });

    render(
      <TooltipProvider>
        <MobilePreview
          files={{ "index.html": '<img src="/logo.png" />' }}
          template="static"
          sandpackKey={0}
          onReloadPreview={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Preview unavailable",
    );
    expect(screen.getByText(/unavailable locally/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reload preview" }),
    ).not.toBeInTheDocument();

    projectFilesForSandpack.mockImplementationOnce(
      async (files: Record<string, string>) => files,
    );
    await user.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(
      await screen.findByRole("button", { name: "Reload preview" }),
    ).toBeInTheDocument();
  });

  it("recovers a render failure through an explicit preview retry", async () => {
    const user = userEvent.setup();
    const onReloadPreview = vi.fn();
    sandpackMock.error = new Error("Transient Sandpack failure");

    render(
      <TooltipProvider>
        <MobilePreview
          files={{ "index.html": "<body />" }}
          template="static"
          sandpackKey={0}
          onReloadPreview={onReloadPreview}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Transient Sandpack failure",
    );
    sandpackMock.error = null;
    await user.click(screen.getByRole("button", { name: "Retry preview" }));

    expect(onReloadPreview).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("button", { name: "Reload preview" }),
    ).toBeInTheDocument();
  });
});
