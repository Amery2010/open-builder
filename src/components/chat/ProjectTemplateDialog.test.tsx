// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { ProjectTemplateDialog } from "./ProjectTemplateDialog";

const controller = vi.hoisted(() => ({
  open: true,
  closeLibrary: vi.fn(),
  sourceConversation: {
    id: "source",
    title: "Portfolio",
    messages: [],
    files: { "src/App.tsx": "app", ".env.local": "API_KEY=secret" },
    template: "vite-react-ts",
    previewMode: "sandpack" as const,
    isProjectInitialized: true,
    createdAt: 1,
    updatedAt: 2,
  },
  sourceTitle: "Portfolio",
  templates: [
    {
      id: "legacy",
      name: "Legacy Admin",
      files: { "src/App.tsx": "old" },
      template: "unknown-runtime",
      tags: ["admin"],
      schemaVersion: 1 as const,
      safety: {
        status: "pending-upgrade" as const,
        excludedPaths: [],
        redactedPaths: [],
      },
      analysis: {
        framework: "React",
        language: "TypeScript",
        tests: ["Vitest"],
        designSystem: "Graphite",
        autoTags: ["react", "typescript"],
      },
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: "legacy-supported",
      name: "Legacy Landing",
      files: { "src/App.tsx": "landing" },
      template: "vite-react-ts",
      tags: ["landing"],
      schemaVersion: 1 as const,
      safety: {
        status: "pending-upgrade" as const,
        excludedPaths: [],
        redactedPaths: [],
      },
      analysis: {
        framework: "React",
        language: "TypeScript",
        tests: [],
        autoTags: ["react", "typescript"],
      },
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  isReady: true,
  prepareCurrent: vi.fn(async () => ({
    report: {
      excludedPaths: [".env.local"],
      redactedPaths: ["src/config.ts"],
    },
    template: {
      id: "prepared",
      name: "Portfolio",
      files: { "src/App.tsx": "app" },
      template: "vite-react-ts",
      tags: [],
      schemaVersion: 2 as const,
      contentDigest: "a".repeat(64),
      safety: {
        status: "safe" as const,
        excludedPaths: [".env.local"],
        redactedPaths: ["src/config.ts"],
        preparedAt: 3,
      },
      analysis: {
        framework: "React",
        language: "TypeScript",
        tests: ["Vitest"],
        autoTags: ["react", "typescript", "vitest"],
      },
      createdAt: 3,
      updatedAt: 3,
    },
  })),
  prepareUpgrade: vi.fn(async () => ({
    report: { excludedPaths: [], redactedPaths: [] },
    template: {
      id: "legacy",
      name: "Legacy Admin",
      files: { "src/App.tsx": "old" },
      template: "vite-react-ts",
      tags: ["admin"],
      schemaVersion: 2 as const,
      contentDigest: "b".repeat(64),
      safety: {
        status: "safe" as const,
        excludedPaths: [],
        redactedPaths: [],
      },
      createdAt: 1,
      updatedAt: 3,
    },
  })),
  savePrepared: vi.fn(async () => ({
    status: "added" as const,
    id: "prepared",
  })),
  updatePrepared: vi.fn(async () => "updated" as const),
  editTemplate: vi.fn(async () => true),
  deleteTemplate: vi.fn(async () => true),
  useTemplate: vi.fn(async () => "conversation-new"),
}));

vi.mock("../../hooks/useProjectTemplateController", () => ({
  useProjectTemplateController: () => controller,
}));

describe("ProjectTemplateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });

  it("shows a searchable library and blocks unsafe legacy starters", async () => {
    const user = userEvent.setup();
    render(<ProjectTemplateDialog />);

    expect(screen.getByRole("dialog")).toHaveClass("flex", "overflow-hidden");
    expect(
      screen
        .getByRole("heading", { name: "Project Starter Library" })
        .querySelector("svg"),
    ).toHaveClass("lucide-layout-template");
    expect(
      screen.getByRole("textbox", { name: "Search starters" }),
    ).toBeVisible();
    expect(screen.getByText("Legacy Admin")).toBeVisible();
    expect(screen.getByText("Unsupported runtime")).toBeVisible();
    expect(screen.getByText("Safe upgrade required")).toBeVisible();
    expect(screen.getByText("Vitest")).toBeVisible();
    expect(screen.getByText("Graphite")).toBeVisible();
    for (const button of screen.getAllByRole("button", {
      name: "Use starter",
    })) {
      expect(button).toBeDisabled();
    }

    await user.click(
      screen.getByRole("button", { name: "Review safe upgrade" }),
    );
    expect(controller.prepareUpgrade).toHaveBeenCalledWith("legacy-supported");

    await user.type(
      screen.getByRole("textbox", { name: "Search starters" }),
      "playwright",
    );
    expect(screen.queryByText("Legacy Admin")).not.toBeInTheDocument();
  });

  it("previews the sanitized copy before confirmation", async () => {
    const user = userEvent.setup();
    render(<ProjectTemplateDialog />);

    await user.click(screen.getByRole("button", { name: "Review safe copy" }));
    expect(controller.savePrepared).not.toHaveBeenCalled();
    expect(screen.getByText("1 sensitive file excluded")).toBeVisible();
    expect(screen.getByText("1 file redacted")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Confirm save" }));
    expect(controller.savePrepared).toHaveBeenCalledTimes(1);
  });
});
