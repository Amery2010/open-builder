// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { FileExplorer } from "./FileExplorer";

describe("FileExplorer selection", () => {
  it("toggles folders without selecting them and selects files", async () => {
    const user = userEvent.setup();
    const onFileSelect = vi.fn();
    render(
      <TooltipProvider>
        <FileExplorer
          files={{ "src/App.tsx": "export default function App() {}" }}
          currentFile="src/App.tsx"
          onFileSelect={onFileSelect}
          onCreateFile={vi.fn()}
          onCreateFolder={vi.fn()}
          onRenameFile={vi.fn()}
          onDeleteFile={vi.fn()}
          onMoveFile={vi.fn()}
        />
      </TooltipProvider>,
    );

    const folder = screen.getByRole("button", { name: "src" });
    const fileIcons = document.querySelectorAll('img[aria-hidden="true"]');
    expect(fileIcons.length).toBeGreaterThan(0);
    for (const icon of fileIcons) {
      expect(icon).toHaveAttribute("alt", "");
    }
    expect(screen.getByRole("button", { name: "App.tsx" })).toBeVisible();

    await user.click(folder);
    expect(
      screen.queryByRole("button", { name: "App.tsx" }),
    ).not.toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();

    await user.click(folder);
    await user.click(screen.getByRole("button", { name: "App.tsx" }));
    expect(onFileSelect).toHaveBeenCalledOnce();
    expect(onFileSelect).toHaveBeenCalledWith("src/App.tsx");
  });
});
