// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import type { StagedProjectImport } from "../../lib/utils/project-import";
import { ProjectImportDialog } from "./ProjectImportDialog";

const importMocks = vi.hoisted(() => ({
  stageDirectory: vi.fn(),
  stageFileList: vi.fn(),
  stageTauriDirectory: vi.fn(),
  stageZip: vi.fn(),
}));

vi.mock("../../lib/utils/project-import", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lib/utils/project-import")>();
  return {
    ...original,
    stageProjectFromDirectoryHandle: importMocks.stageDirectory,
    stageProjectFromFileList: importMocks.stageFileList,
    stageProjectFromTauriDirectory: importMocks.stageTauriDirectory,
    stageProjectFromZip: importMocks.stageZip,
  };
});

const stagedProject: StagedProjectImport = {
  name: "sample-project",
  files: {
    "package.json": '{"devDependencies":{"vite":"4.2.0"}}',
    "src/main.ts": "console.log('ready')",
  },
  template: "vite",
  previewMode: "sandpack",
  activeFile: "src/main.ts",
  preflight: {
    digest: "checked-digest",
    capabilities: {
      template: "vite",
      previewMode: "sandpack",
      preview: { supported: true },
      staticBuild: { supported: true },
    },
  },
  report: {
    importedFiles: 2,
    totalBytes: 72,
    redactedFiles: 1,
    skipped: { ignored: 3, sensitive: 2, binary: 1, symlink: 1 },
  },
};

describe("ProjectImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    Reflect.deleteProperty(window, "showDirectoryPicker");
  });

  it("keeps import details scrollable with a fixed header and footer", () => {
    render(
      <ProjectImportDialog
        open
        hasExistingProject={false}
        isGenerating={false}
        onClose={vi.fn()}
        onImport={vi.fn(() => ({ ok: true as const }))}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const body = dialog.querySelector<HTMLElement>('[data-slot="dialog-body"]');
    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-hidden");
    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass(
      "shrink-0",
    );
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).toHaveClass(
      "shrink-0",
    );
    expect(dialog.querySelectorAll('[data-slot="dialog-body"]')).toHaveLength(
      1,
    );
    expect(body).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
  });

  it("stages a folder with local checks and imports without starting a verification runtime", async () => {
    const user = userEvent.setup();
    const directoryHandle = { kind: "directory", name: "sample-project" };
    const picker = vi.fn(async () => directoryHandle);
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: picker,
    });
    importMocks.stageDirectory.mockResolvedValue(stagedProject);
    const onClose = vi.fn();
    const onImport = vi.fn(async () => ({ ok: true as const }));

    render(
      <ProjectImportDialog
        open
        hasExistingProject
        isGenerating={false}
        onClose={onClose}
        onImport={onImport}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Upload Project");
    await user.click(
      screen.getByRole("button", { name: /choose project folder/i }),
    );

    expect(picker).toHaveBeenCalledWith({ mode: "read" });
    expect(importMocks.stageDirectory).toHaveBeenCalledWith(
      directoryHandle,
      expect.any(AbortSignal),
    );
    expect(await screen.findByText("sample-project")).toBeInTheDocument();
    expect(screen.getByText(/2 files · 72 B/)).toBeInTheDocument();
    await user.click(screen.getByText("View details"));
    expect(screen.getByText(/ignored 3/i)).toBeVisible();
    expect(screen.getByText(/keeps your current project/i)).toBeInTheDocument();
    expect(screen.getByText("Checked and ready to import")).toBeInTheDocument();
    expect(
      document.querySelector('iframe[title="Project import verification"]'),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: /^import project$/i }));
    expect(onImport).toHaveBeenCalledWith(
      expect.objectContaining({
        ...stagedProject,
        preflight: expect.objectContaining({ digest: "checked-digest" }),
      }),
      expect.any(AbortSignal),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("allows an unsupported ZIP in code mode and explains the preview limitation", async () => {
    const user = userEvent.setup();
    const codeOnlyProject: StagedProjectImport = {
      ...stagedProject,
      name: "source-only",
      template: "static",
      previewMode: "code-only",
      preflight: {
        digest: "checked-digest",
        capabilities: {
          template: "static",
          previewMode: "code-only",
          preview: { supported: false, reason: "Unsupported project version." },
          staticBuild: { supported: false },
        },
      },
    };
    importMocks.stageZip.mockResolvedValue(codeOnlyProject);
    render(
      <ProjectImportDialog
        open
        hasExistingProject={false}
        isGenerating={false}
        onClose={vi.fn()}
        onImport={vi.fn(() => ({ ok: true as const }))}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /choose zip archive/i }),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[accept*="application/zip"]',
    );
    expect(input).not.toBeNull();
    const zip = new File(["archive"], "source-only.zip", {
      type: "application/zip",
    });
    await user.upload(input!, zip);

    expect(importMocks.stageZip).toHaveBeenCalledWith(
      zip,
      expect.any(AbortSignal),
    );
    expect(await screen.findByText("source-only")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Code only")).toBeInTheDocument();
    await user.click(screen.getByText("View details"));
    expect(screen.getByText("Unsupported project version.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^import project$/i }),
    ).toBeEnabled();
  });

  it("keeps the project summary visible while submitting and blocks duplicate clicks", async () => {
    const user = userEvent.setup();
    let finish!: (result: { ok: true }) => void;
    const onImport = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve;
        }),
    );
    importMocks.stageZip.mockResolvedValue(stagedProject);
    render(
      <ProjectImportDialog
        open
        hasExistingProject={false}
        isGenerating={false}
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[accept*="application/zip"]',
    )!;
    await user.upload(
      input,
      new File(["zip"], "demo.zip", { type: "application/zip" }),
    );
    await user.dblClick(
      screen.getByRole("button", { name: /^import project$/i }),
    );
    expect(onImport).toHaveBeenCalledOnce();
    expect(screen.getByText("sample-project")).toBeVisible();
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    await act(async () => finish({ ok: true }));
  });

  it("aborts a closed operation and ignores its late result after reopening", async () => {
    const user = userEvent.setup();
    let finish!: (project: StagedProjectImport) => void;
    let signal!: AbortSignal;
    importMocks.stageZip.mockImplementationOnce((_file, value: AbortSignal) => {
      signal = value;
      return new Promise<StagedProjectImport>((resolve) => {
        finish = resolve;
      });
    });
    const props = {
      hasExistingProject: false,
      isGenerating: false,
      onClose: vi.fn(),
      onImport: vi.fn(() => ({ ok: true as const })),
    };
    const { rerender } = render(<ProjectImportDialog {...props} open />);
    await user.upload(
      document.querySelector<HTMLInputElement>(
        'input[accept*="application/zip"]',
      )!,
      new File(["zip"], "old.zip", { type: "application/zip" }),
    );
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(signal.aborted).toBe(true);
    rerender(<ProjectImportDialog {...props} open={false} />);
    rerender(<ProjectImportDialog {...props} open />);
    importMocks.stageZip.mockResolvedValueOnce({
      ...stagedProject,
      name: "new-project",
    });
    await user.upload(
      document.querySelector<HTMLInputElement>(
        'input[accept*="application/zip"]',
      )!,
      new File(["zip"], "new.zip", { type: "application/zip" }),
    );
    await act(async () => finish(stagedProject));
    expect(screen.getByText("new-project")).toBeVisible();
    expect(screen.queryByText("sample-project")).not.toBeInTheDocument();
  });

  it("does not close a reopened dialog when an old import callback finishes", async () => {
    const user = userEvent.setup();
    let finish!: (result: { ok: true }) => void;
    const onClose = vi.fn();
    const onImport = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve;
        }),
    );
    const props = {
      hasExistingProject: false,
      isGenerating: false,
      onClose,
      onImport,
    };
    importMocks.stageZip.mockResolvedValue(stagedProject);
    const { rerender } = render(<ProjectImportDialog {...props} open />);
    const upload = () =>
      user.upload(
        document.querySelector<HTMLInputElement>(
          'input[accept*="application/zip"]',
        )!,
        new File(["zip"], "demo.zip", { type: "application/zip" }),
      );
    await upload();
    await user.click(screen.getByRole("button", { name: /^import project$/i }));
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    rerender(<ProjectImportDialog {...props} open={false} />);
    rerender(<ProjectImportDialog {...props} open />);
    importMocks.stageZip.mockResolvedValueOnce({
      ...stagedProject,
      name: "new-project",
    });
    await upload();
    await act(async () => finish({ ok: true }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByText("new-project")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^import project$/i }),
    ).toBeEnabled();
  });

  it("disables both sources during generation and closes with Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ProjectImportDialog
        open
        hasExistingProject={false}
        isGenerating
        onClose={onClose}
        onImport={vi.fn(() => ({ ok: true as const }))}
      />,
    );

    expect(
      screen.getByRole("button", { name: /choose project folder/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /choose zip archive/i }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
