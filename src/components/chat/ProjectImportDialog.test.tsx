// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
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
  validate: vi.fn(),
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

vi.mock("../../lib/project-runtime/validation", () => ({
  validateProjectRuntime: importMocks.validate,
}));

const stagedProject: StagedProjectImport = {
  name: "sample-project",
  files: {
    "package.json": '{"devDependencies":{"vite":"4.2.0"}}',
    "src/main.ts": "console.log('ready')",
  },
  template: "vite",
  previewMode: "sandpack",
  activeFile: "src/main.ts",
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
    importMocks.validate.mockResolvedValue({
      digest: "verified-digest",
      template: "vite",
      previewMode: "sandpack",
      capabilities: { preview: { supported: true } },
    });
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

  it("stages a File System Access folder, verifies compilation and imports into a new conversation", async () => {
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
    expect(importMocks.stageDirectory).toHaveBeenCalledWith(directoryHandle);
    expect(await screen.findByText("sample-project")).toBeInTheDocument();
    expect(screen.getByText(/2 files · 72 B/)).toBeInTheDocument();
    expect(screen.getByText(/ignored 3/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps your current project/i)).toBeInTheDocument();
    expect(importMocks.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        files: stagedProject.files,
        signal: expect.any(AbortSignal),
      }),
    );

    await user.click(screen.getByRole("button", { name: /^import project$/i }));
    expect(onImport).toHaveBeenCalledWith(
      expect.objectContaining({
        ...stagedProject,
        validation: expect.objectContaining({ digest: "verified-digest" }),
      }),
      expect.any(AbortSignal),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rejects an unsupported ZIP instead of allowing a code-only import", async () => {
    const user = userEvent.setup();
    const codeOnlyProject: StagedProjectImport = {
      ...stagedProject,
      name: "source-only",
      template: "static",
      previewMode: "code-only",
    };
    importMocks.stageZip.mockResolvedValue(codeOnlyProject);
    importMocks.validate.mockRejectedValue(
      new Error("Unsupported project version."),
    );
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

    expect(importMocks.stageZip).toHaveBeenCalledWith(zip);
    expect(await screen.findByText("source-only")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unsupported project version",
    );
    expect(
      screen.getByRole("button", { name: /^import project$/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /retry verification/i }),
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
