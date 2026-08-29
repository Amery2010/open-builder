// @vitest-environment jsdom

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { MobilePreview } from "./MobilePreview";

const refresh = vi.fn();

vi.mock("@codesandbox/sandpack-react", () => ({
  SandpackProvider: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
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

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => false }));

describe("MobilePreview", () => {
  it("uses navigation refresh and disables shell restart", async () => {
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
    expect(refresh).toHaveBeenCalledOnce();
    expect(onReloadPreview).not.toHaveBeenCalled();
    expect(document.querySelector("[data-refresh='false']")).not.toBeNull();
    expect(document.querySelector("[data-restart='false']")).not.toBeNull();
  });
});
