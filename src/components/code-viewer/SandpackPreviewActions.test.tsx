// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import {
  SandpackActionButton,
  SandpackRefreshAction,
} from "./SandpackPreviewActions";

const sandpack = vi.hoisted(() => ({
  refresh: vi.fn(),
  restart: vi.fn(),
}));

vi.mock("@codesandbox/sandpack-react", () => ({
  useSandpackNavigation: () => ({ refresh: sandpack.refresh }),
  useSandpackShell: () => ({ restart: sandpack.restart }),
}));

describe("Sandpack preview actions", () => {
  it("delegates reload to the owner so it can rebuild the client", async () => {
    const events: string[] = [];
    sandpack.refresh.mockImplementation(() => {
      events.push("refresh");
    });
    sandpack.restart.mockClear();
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <SandpackRefreshAction
          label="Reload preview"
          onReload={() => events.push("reload")}
        />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: "Reload preview" });
    expect(button).toHaveClass("size-7", "rounded-full");
    expect(button).not.toHaveAttribute("aria-pressed");
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Reload preview",
    );
    await user.click(button);

    expect(events).toEqual(["reload"]);
    expect(sandpack.refresh).not.toHaveBeenCalled();
    expect(sandpack.restart).not.toHaveBeenCalled();
  });

  it("shares the circular treatment and pressed state with console", () => {
    render(
      <TooltipProvider>
        <SandpackActionButton label="Hide Console" pressed onClick={vi.fn()}>
          console
        </SandpackActionButton>
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: "Hide Console" });
    expect(button).toHaveClass("size-7", "rounded-full");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("data-active", "true");
  });
});
