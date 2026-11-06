// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useSubagentStore } from "../../store/subagent";
import { SUBAGENT_LIMITS } from "../../lib/ai/subagents/limits";
import { SubagentCallCard } from "./SubagentCallCard";
import { cancelPendingToolCalls } from "../../lib/ai/run-guard";

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

  it("shows a stopped child as stopped after its canonical tool call is cancelled", () => {
    const closed = cancelPendingToolCalls([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: baseProps.toolCallId,
            type: "function",
            function: {
              name: "dispatch_subagent",
              arguments: JSON.stringify(baseProps.rawArgs),
            },
          },
        ],
      },
    ]);
    const result = closed.at(-1)!;
    render(
      <SubagentCallCard
        {...baseProps}
        result={String(result.content)}
        toolOutput={result.toolOutput}
      />,
    );
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("shows the task and status in the compact subagent card", async () => {
    const user = userEvent.setup();
    render(<SubagentCallCard {...baseProps} result="" />);

    expect(screen.getByText("Inspect the active entry chain.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Code Explorer/ }));
    expect(screen.getByText("Inspect the active entry chain.")).toBeVisible();
  });

  it("shows live public activity and keeps the collapsible accessible", async () => {
    const user = userEvent.setup();
    useSubagentStore
      .getState()
      .init(
        baseProps.toolCallId,
        "code-explorer",
        "Inspect the active entry chain.",
      );
    useSubagentStore
      .getState()
      .appendThinking(baseProps.toolCallId, "Checking the project entrypoint");
    useSubagentStore
      .getState()
      .recordActivity(
        baseProps.toolCallId,
        "warning",
        "The provider is still preparing the next response.",
      );

    render(<SubagentCallCard {...baseProps} result="" />);

    const trigger = screen.getByRole("button", { name: /Code Explorer/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("Checking the project entrypoint"),
    ).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Checking the project entrypoint")).toBeVisible();
    expect(
      screen.getAllByText("The provider is still preparing the next response."),
    ).toHaveLength(2);
    expect(screen.getByTestId("subagent-last-updated")).toBeVisible();
  });

  it("does not pull the activity list back to the bottom after the user scrolls up", async () => {
    const user = userEvent.setup();
    useSubagentStore
      .getState()
      .init(
        baseProps.toolCallId,
        "code-explorer",
        "Inspect the active entry chain.",
      );
    useSubagentStore
      .getState()
      .appendText(baseProps.toolCallId, "Initial output");
    render(<SubagentCallCard {...baseProps} result="" />);
    await user.click(screen.getByRole("button", { name: /Code Explorer/ }));

    const list = screen.getByTestId("subagent-activity-list");
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(list);
    useSubagentStore.getState().appendText(baseProps.toolCallId, "More output");

    expect(list.scrollTop).toBe(0);
  });

  it("renders completed empty nested output and restores legacy terminal state", async () => {
    const user = userEvent.setup();
    render(
      <SubagentCallCard
        {...baseProps}
        result={JSON.stringify({
          subagent: "code-explorer",
          task: "Inspect",
          status: "done",
          text: "",
          events: [
            { name: "read_files", toolCallId: "empty", resultPreview: "" },
          ],
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Code Explorer/ }));
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /^Read Files\s*Completed$/ }),
    );
    expect(screen.getByText("Completed with no text output")).toBeVisible();
  });

  it("keeps a completed tool's reported failure visible", async () => {
    const user = userEvent.setup();
    render(
      <SubagentCallCard
        {...baseProps}
        result={JSON.stringify({
          ok: true,
          subagent: "code-explorer",
          task: "Inspect files",
          status: "done",
          text: "",
          events: [
            {
              name: "read_files",
              toolCallId: "failure",
              status: "completed",
              resultPreview: '{"ok":false,"error":"File unavailable"}',
            },
          ],
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Code Explorer/ }));
    expect(
      screen.getByRole("button", { name: /^Read Files.*Failed$/ }),
    ).toBeVisible();
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
