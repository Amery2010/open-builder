// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettingsStore } from "../../store/settings";
import {
  useInteractiveStore,
  type AskUserQuestion,
} from "../../store/interactive";
import {
  AskUserAnswerSummary,
  AskUserQuestionCard,
} from "./AskUserQuestionCard";

const questions: AskUserQuestion[] = [
  {
    header: "Runtime",
    question: "Where should it run?",
    multiSelect: false,
    options: [
      { label: "Browser", description: "Use the browser runtime." },
      { label: "Desktop", description: "Use the desktop runtime." },
    ],
  },
  {
    header: "Features",
    question: "Which features should be included?",
    multiSelect: true,
    options: [
      { label: "Search", description: "Include search." },
      { label: "Export", description: "Include export." },
    ],
  },
];

describe("AskUserQuestionCard", () => {
  beforeEach(() => {
    useInteractiveStore.setState({ pending: [] });
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });

  it("pages through questions, preserves earlier answers, and submits custom input with Enter", async () => {
    const user = userEvent.setup();
    const answerPromise = useInteractiveStore.getState().askQuestion({
      toolCallId: "questionnaire-1",
      questions,
    });
    const { container } = render(
      <AskUserQuestionCard
        toolCallId="questionnaire-1"
        questions={questions}
      />,
      { wrapper: TooltipProvider },
    );

    expect(screen.getByText("Question 1 of 2")).toBeVisible();
    expect(screen.queryByText(questions[1].question)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Custom answer")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: questions[0].question }),
      ).toHaveFocus(),
    );
    expect(
      (
        await axe(container, {
          rules: { "color-contrast": { enabled: false } },
        })
      ).violations,
    ).toEqual([]);

    await user.click(screen.getByRole("radio", { name: /Browser/ }));
    expect(screen.getByText("Question 2 of 2")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Previous question" }));
    expect(screen.getByRole("radio", { name: /Browser/ })).toBeChecked();

    await user.click(
      screen.getByRole("button", { name: "Go to next question" }),
    );
    await user.type(screen.getByLabelText("Custom answer"), "Offline mode");
    await user.keyboard("{Enter}");

    await expect(answerPromise).resolves.toEqual({
      answers: [
        {
          header: "Runtime",
          question: "Where should it run?",
          selected: ["Browser"],
        },
        {
          header: "Features",
          question: "Which features should be included?",
          selected: ["Offline mode"],
        },
      ],
    });
    expect(screen.queryByText("AI Has a Question")).not.toBeInTheDocument();
  });

  it("keeps multi-select on the current page and auto-submits the final single-select answer", async () => {
    const user = userEvent.setup();
    const multiFirst = [questions[1], questions[0]];
    let settled = false;
    const answerPromise = useInteractiveStore.getState().askQuestion({
      toolCallId: "questionnaire-2",
      questions: multiFirst,
    });
    void answerPromise.then(() => {
      settled = true;
    });
    render(
      <AskUserQuestionCard
        toolCallId="questionnaire-2"
        questions={multiFirst}
      />,
      { wrapper: TooltipProvider },
    );

    await user.click(screen.getByRole("checkbox", { name: /Search/ }));
    await user.click(screen.getByRole("checkbox", { name: /Export/ }));
    expect(screen.getByText("Question 1 of 2")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next question" }));

    const pending = useInteractiveStore.getState().pending[0];
    if (pending.kind !== "question") throw new Error("Expected question");
    const resolveSpy = vi.fn(pending.resolve);
    pending.resolve = resolveSpy;
    await user.dblClick(screen.getByRole("radio", { name: /Desktop/ }));

    await expect(answerPromise).resolves.toEqual({
      answers: [
        {
          header: "Features",
          question: "Which features should be included?",
          selected: ["Search", "Export"],
        },
        {
          header: "Runtime",
          question: "Where should it run?",
          selected: ["Desktop"],
        },
      ],
    });
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
  });

  it("treats whitespace as empty and keeps custom and preset answers exclusive", async () => {
    const user = userEvent.setup();
    const singleQuestion = [questions[1]];
    const answerPromise = useInteractiveStore.getState().askQuestion({
      toolCallId: "questionnaire-exclusive",
      questions: singleQuestion,
    });
    render(
      <AskUserQuestionCard
        toolCallId="questionnaire-exclusive"
        questions={singleQuestion}
      />,
      { wrapper: TooltipProvider },
    );

    const customAnswer = screen.getByLabelText("Custom answer");
    const submit = screen.getByRole("button", { name: "Submit" });
    await user.type(customAnswer, "   ");
    expect(submit).toBeDisabled();

    await user.clear(customAnswer);
    await user.type(customAnswer, "Custom runtime");
    await user.click(screen.getByRole("checkbox", { name: /Search/ }));
    expect(customAnswer).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: /Search/ })).toBeChecked();
    await user.click(submit);

    await expect(answerPromise).resolves.toMatchObject({
      answers: [{ selected: ["Search"] }],
    });
  });

  it("shows recommendation metadata only for an explicit suffix without changing the submitted label", async () => {
    const user = userEvent.setup();
    const recommendedQuestion: AskUserQuestion[] = [
      {
        ...questions[0],
        options: [
          {
            label: "Browser (Recommended)",
            description: "Use the browser runtime.",
          },
          questions[0].options[1],
        ],
      },
    ];
    const answerPromise = useInteractiveStore.getState().askQuestion({
      toolCallId: "questionnaire-recommended",
      questions: recommendedQuestion,
    });
    render(
      <AskUserQuestionCard
        toolCallId="questionnaire-recommended"
        questions={recommendedQuestion}
      />,
      { wrapper: TooltipProvider },
    );

    expect(screen.getByText("Recommended")).toBeVisible();
    expect(screen.queryByText("Browser (Recommended)")).not.toBeInTheDocument();
    expect(screen.queryAllByText("Recommended")).toHaveLength(1);

    await user.click(screen.getByRole("radio", { name: /Browser/ }));

    await expect(answerPromise).resolves.toMatchObject({
      answers: [{ selected: ["Browser (Recommended)"] }],
    });
  });

  it("recognizes the Chinese recommendation suffix and preserves it in the answer", async () => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "zh" },
    }));
    const answerPromise = useInteractiveStore.getState().askQuestion({
      toolCallId: "questionnaire-recommended-zh",
      questions: [
        {
          ...questions[0],
          options: [
            {
              label: "浏览器（推荐）",
              description: "使用浏览器运行时。",
            },
            { label: "桌面端", description: "使用桌面运行时。" },
          ],
        },
      ],
    });
    render(
      <AskUserQuestionCard
        toolCallId="questionnaire-recommended-zh"
        questions={[
          {
            ...questions[0],
            options: [
              {
                label: "浏览器（推荐）",
                description: "使用浏览器运行时。",
              },
              { label: "桌面端", description: "使用桌面运行时。" },
            ],
          },
        ]}
      />,
      { wrapper: TooltipProvider },
    );

    expect(screen.getByText("推荐")).toBeVisible();
    expect(screen.queryByText("浏览器（推荐）")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /浏览器/ }));
    await expect(answerPromise).resolves.toMatchObject({
      answers: [{ selected: ["浏览器（推荐）"] }],
    });
  });

  it("renders approvals inline without a custom answer", async () => {
    const user = userEvent.setup();
    const approvalQuestions = [questions[0]];
    const answerPromise = useInteractiveStore.getState().askQuestion({
      toolCallId: "approval-1",
      questions: approvalQuestions,
      presentation: "approval",
    });
    render(
      <AskUserQuestionCard
        toolCallId="approval-1"
        questions={approvalQuestions}
        presentation="approval"
      />,
      { wrapper: TooltipProvider },
    );

    expect(screen.queryByLabelText("Custom answer")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Browser/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(answerPromise).resolves.toMatchObject({
      answers: [{ selected: ["Browser"] }],
    });
  });

  it("renders one right-aligned answer summary with short headers", () => {
    render(
      <AskUserAnswerSummary
        answers={[
          { header: "Runtime", selections: ["Browser"] },
          { header: "Features", selections: ["Search", "Export"] },
        ]}
      />,
    );

    const summary = screen.getByLabelText("Your answers");
    expect(summary.parentElement).toHaveClass("justify-end");
    expect(summary).toHaveTextContent("Runtime: Browser");
    expect(summary).toHaveTextContent("Features: Search, Export");
  });
});
