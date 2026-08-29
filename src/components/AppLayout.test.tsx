// @vitest-environment jsdom

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppLayout } from "./AppLayout";

interface GroupProps {
  children: ReactNode;
  orientation?: "horizontal" | "vertical";
}

interface PanelProps {
  children: ReactNode;
  id: string;
  className?: string;
  defaultSize?: number | string;
  minSize?: number | string;
  maxSize?: number | string;
}

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    orientation = "horizontal",
  }: GroupProps) => (
    <div data-testid="panel-group" data-orientation={orientation}>
      {children}
    </div>
  ),
  ResizablePanel: ({
    children,
    id,
    className,
    defaultSize,
    minSize,
    maxSize,
  }: PanelProps) => (
    <section
      data-testid={id}
      className={className}
      data-default-size={defaultSize}
      data-min-size={minSize}
      data-max-size={maxSize}
    >
      {children}
    </section>
  ),
  ResizableHandle: ({ withHandle }: { withHandle?: boolean }) => (
    <div
      data-testid="resize-handle"
      data-with-handle={withHandle ? "true" : "false"}
    />
  ),
}));

const chat = <div data-testid="chat-content" />;
const workspace = <div data-testid="workspace-content" />;

describe("AppLayout", () => {
  it("places the workspace above the chat in a resizable tablet split", () => {
    render(<AppLayout layout="tablet" chat={chat} workspace={workspace} />);

    const group = screen.getByTestId("panel-group");
    expect(group).toHaveAttribute("data-orientation", "vertical");
    expect(
      Array.from(group.children).map((child) =>
        child.getAttribute("data-testid"),
      ),
    ).toEqual(["project-workspace", "resize-handle", "chat-interface"]);
    expect(screen.getByTestId("project-workspace")).toHaveAttribute(
      "data-default-size",
      "50%",
    );
    expect(screen.getByTestId("chat-interface")).toHaveAttribute(
      "data-min-size",
      "30%",
    );
    expect(screen.getByTestId("chat-interface")).toHaveAttribute(
      "data-max-size",
      "70%",
    );
    expect(screen.getByTestId("resize-handle")).toHaveAttribute(
      "data-with-handle",
      "true",
    );
  });

  it("keeps the chat-left desktop layout and its existing sizing", () => {
    render(<AppLayout layout="desktop" chat={chat} workspace={workspace} />);

    const group = screen.getByTestId("panel-group");
    expect(group).toHaveAttribute("data-orientation", "horizontal");
    expect(
      Array.from(group.children).map((child) =>
        child.getAttribute("data-testid"),
      ),
    ).toEqual(["chat-interface", "resize-handle", "project-workspace"]);
    expect(screen.getByTestId("chat-interface")).toHaveAttribute(
      "data-default-size",
      "30%",
    );
    expect(screen.getByTestId("chat-interface")).toHaveAttribute(
      "data-min-size",
      "360",
    );
    expect(screen.getByTestId("chat-interface")).toHaveClass(
      "min-h-0",
      "overflow-hidden",
    );
  });

  it("renders only the chat surface on mobile", () => {
    render(<AppLayout layout="mobile" chat={chat} workspace={workspace} />);

    expect(screen.getByTestId("mobile-layout")).toContainElement(
      screen.getByTestId("chat-content"),
    );
    expect(screen.queryByTestId("workspace-content")).not.toBeInTheDocument();
    expect(screen.queryByTestId("panel-group")).not.toBeInTheDocument();
  });
});
