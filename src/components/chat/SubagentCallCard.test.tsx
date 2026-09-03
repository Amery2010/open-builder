// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useSubagentStore } from "../../store/subagent";
import { SUBAGENT_LIMITS } from "../../lib/ai/subagents/limits";
import { SubagentCallCard } from "./SubagentCallCard";

vi.mock("./LazyMarkdownContent", () => ({
  LazyMarkdownContent: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}));

const baseProps = {
  toolName: "dispatch_subagent",
  title: "Code Explorer",
  path: "",
  toolCallId: "dispatch-1",
  rawArgs: {
    subagent: "code-explorer",
    task: "Inspect the active entry chain.",
  },
};

describe("SubagentCallCard errors", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useSubagentStore.setState({ progress: {} });
  });

  it("renders a non-JSON tool error as a failed subagent call", async () => {
    const user = userEvent.setup();
    const reason =
      'Error: Design contract required before project write tool "dispatch_subagent".';
    render(<SubagentCallCard {...baseProps} result={reason} />);

    await user.click(screen.getByRole("button", { name: /Code Explorer/ }));

    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("prefers the safe tool output reason when the persisted payload is marked as an error", async () => {
    const user = userEvent.setup();
    const reason = "The Host authorization policy denied this dispatch.";
    render(
      <SubagentCallCard
        {...baseProps}
        result={JSON.stringify({
          ok: true,
          subagent: "code-explorer",
          task: "Inspect the active entry chain.",
          status: "done",
          text: "",
          events: [],
          durationMs: 5,
        })}
        toolOutput={{ text: reason, isError: true }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Code Explorer/ }));

    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("keeps and bounds a legacy non-JSON success result as completed output", async () => {
    const user = userEvent.setup();
    const result = `The active entry chain is src/main.tsx to src/App.tsx. ${"x".repeat(SUBAGENT_LIMITS.maxLiveTextChars)}`;
    const expected = `${result.slice(0, SUBAGENT_LIMITS.maxLiveTextChars)}\n\n[truncated]`;
    render(<SubagentCallCard {...baseProps} result={result} />);

    expect(screen.getByText("Done")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Code Explorer/ }));

    expect(await screen.findByTestId("markdown-content")).toHaveTextContent(
      expected,
      { normalizeWhitespace: false },
    );
    expect(screen.getByTestId("markdown-content").textContent).not.toBe(result);
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });
});
