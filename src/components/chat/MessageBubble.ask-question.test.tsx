// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useInteractiveStore } from "../../store/interactive";
import type { MergedMessage } from "../../types";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble ask-user answers", () => {
  beforeEach(() => {
    useInteractiveStore.setState({ pending: [] });
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });

  it("shows only the short header and final answer", () => {
    const message: MergedMessage = {
      id: "assistant-1",
      role: "assistant",
      blocks: [
        {
          id: "tool-question-1",
          type: "tool",
          toolName: "ask_user_question",
          title: "Ask You a Question",
          path: "",
          toolCallId: "question-1",
          result: "Q1 [Runtime] Where should it run?\n→ Browser",
          rawArgs: {
            questions: [
              {
                header: "Runtime",
                question: "Where should it run?",
                multiSelect: false,
                options: [
                  { label: "Browser", description: "Browser runtime." },
                ],
              },
            ],
          },
          toolOutput: {
            text: "Q1 [Runtime] Where should it run?\n→ Browser",
            structuredContent: {
              kind: "ask_user_answers_v1",
              selections: [["Browser"]],
            },
          },
        },
      ],
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByLabelText("Your answers")).toHaveTextContent(
      "Runtime: Browser",
    );
    expect(screen.queryByText("Where should it run?")).not.toBeInTheDocument();
    expect(screen.queryByText("Browser runtime.")).not.toBeInTheDocument();
    expect(screen.queryByText("Ask You a Question")).not.toBeInTheDocument();
  });

  it("recovers a legacy header and answer without structured content", () => {
    const message: MergedMessage = {
      id: "assistant-legacy",
      role: "assistant",
      blocks: [
        {
          id: "tool-question-legacy",
          type: "tool",
          toolName: "ask_user_question",
          title: "Ask You a Question",
          path: "",
          toolCallId: "question-legacy",
          result: "Q1 [Layout] Pick a layout?\n→ Compact",
        },
      ],
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByLabelText("Your answers")).toHaveTextContent(
      "Layout: Compact",
    );
  });

  it("shows a withdrawal affordance only when the chat owner enables it", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi.fn();
    const message: MergedMessage = {
      id: "user-0",
      role: "user",
      blocks: [{ id: "text-0-0", type: "text", content: "Build the app" }],
    };

    const { rerender } = render(
      <MessageBubble
        message={message}
        canWithdraw
        onWithdraw={onWithdraw}
        withdrawLabel="Withdraw last message"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Withdraw last message" }),
    );
    expect(onWithdraw).toHaveBeenCalledOnce();

    rerender(<MessageBubble message={message} />);
    expect(
      screen.queryByRole("button", { name: "Withdraw last message" }),
    ).not.toBeInTheDocument();

    rerender(
      <MessageBubble
        message={{ ...message, origin: "auto_qa" }}
        canWithdraw
        onWithdraw={onWithdraw}
        withdrawLabel="Withdraw last message"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Withdraw last message" }),
    ).not.toBeInTheDocument();
  });

  it("renders an automatic Design Review timeline block", () => {
    render(
      <MessageBubble
        message={{
          id: "user-0",
          role: "user",
          blocks: [],
          origin: "design_review",
          reviewJobId: "review-pruned",
          reviewSummary: {
            status: "succeeded",
            findingCount: 3,
          },
        }}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Automatic Design Review" }),
    ).toBeVisible();
    expect(screen.getByText("3 findings")).toBeVisible();
  });
});
