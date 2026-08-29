import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, HelpCircle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import {
  useInteractiveStore,
  type AskUserQuestion,
  type AskUserAnswers,
  type QuestionPresentation,
} from "../../store/interactive";
import type { AskUserAnswerSummaryItem } from "../../lib/utils/tool-result";

interface AskUserQuestionCardProps {
  toolCallId: string;
  questions: AskUserQuestion[];
  presentation?: QuestionPresentation;
}

interface QuestionDraft {
  selected: string[];
  customText: string;
}

const createDrafts = (questions: AskUserQuestion[]): QuestionDraft[] =>
  questions.map(() => ({ selected: [], customText: "" }));

const RECOMMENDED_SUFFIX = /\s*(?:\(recommended\)|\(推荐\)|（推荐）)\s*$/iu;

function getOptionDisplay(label: string) {
  const recommended = RECOMMENDED_SUFFIX.test(label);
  const displayLabel = recommended
    ? label.replace(RECOMMENDED_SUFFIX, "").trim()
    : label;
  return {
    label: displayLabel || label,
    recommended,
  };
}

function selectedAnswers(draft: QuestionDraft): string[] {
  const custom = draft.customText.trim();
  return custom ? [custom] : draft.selected;
}

function isQuestionAnswered(draft: QuestionDraft): boolean {
  return selectedAnswers(draft).length > 0;
}

function collectAnswers(
  questions: AskUserQuestion[],
  drafts: QuestionDraft[],
): AskUserAnswers {
  return {
    answers: questions.map((question, index) => ({
      question: question.question,
      header: question.header,
      selected: selectedAnswers(drafts[index]),
    })),
  };
}

function QuestionOption({
  option,
  type,
  name,
  checked,
  onChange,
}: {
  option: AskUserQuestion["options"][number];
  type: "radio" | "checkbox";
  name?: string;
  checked: boolean;
  onChange: () => void;
}) {
  const t = useT();
  const display = getOptionDisplay(option.label);

  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
        "hover:bg-accent/50 focus-within:ring-2 focus-within:ring-ring/50",
        checked ? "border-border bg-muted/70" : "border-transparent",
      )}
    >
      <input
        type={type}
        name={name}
        value={option.label}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium leading-snug">
            {display.label}
          </span>
          {display.recommended && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground">
              {t.chat.askQuestion.recommended}
            </span>
          )}
        </span>
        {option.description && (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
    </label>
  );
}

export function AskUserQuestionCard({
  toolCallId,
  questions,
  presentation = "questionnaire",
}: AskUserQuestionCardProps) {
  if (presentation === "approval") {
    return (
      <ApprovalQuestionCard toolCallId={toolCallId} questions={questions} />
    );
  }
  return <QuestionnaireCard toolCallId={toolCallId} questions={questions} />;
}

function QuestionnaireCard({
  toolCallId,
  questions,
}: Omit<AskUserQuestionCardProps, "presentation">) {
  const t = useT();
  const headingId = useId();
  const customInputId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const submittedRef = useRef(false);
  const pending = useInteractiveStore((state) =>
    state.pending.some(
      (item) =>
        item.kind === "question" &&
        item.presentation === "questionnaire" &&
        item.toolCallId === toolCallId,
    ),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    createDrafts(questions),
  );

  const question = questions[activeIndex];
  const draft = drafts[activeIndex];
  const isLast = activeIndex === questions.length - 1;
  const canContinue = Boolean(draft && isQuestionAnswered(draft));
  const progress = useMemo(
    () =>
      t.chat.askQuestion.progress
        .replace("{current}", String(activeIndex + 1))
        .replace("{total}", String(questions.length)),
    [activeIndex, questions.length, t.chat.askQuestion.progress],
  );
  const compactProgress = useMemo(
    () =>
      t.chat.askQuestion.compactProgress
        .replace("{current}", String(activeIndex + 1))
        .replace("{total}", String(questions.length)),
    [activeIndex, questions.length, t.chat.askQuestion.compactProgress],
  );

  useEffect(() => {
    headingRef.current?.focus();
  }, [activeIndex]);

  if (!pending || !question || !draft) return null;

  const updateCurrentDraft = (
    updater: (current: QuestionDraft) => QuestionDraft,
  ) => {
    setDrafts((current) =>
      current.map((item, index) =>
        index === activeIndex ? updater(item) : item,
      ),
    );
  };

  const selectOption = (label: string) => {
    const nextDraft = question.multiSelect
      ? {
          selected: draft.selected.includes(label)
            ? draft.selected.filter((item) => item !== label)
            : [...draft.selected, label],
          customText: "",
        }
      : { selected: [label], customText: "" };
    const nextDrafts = drafts.map((item, index) =>
      index === activeIndex ? nextDraft : item,
    );
    setDrafts(nextDrafts);

    if (!question.multiSelect) {
      if (isLast) {
        submit(nextDrafts);
      } else {
        setActiveIndex((index) => index + 1);
      }
    }
  };

  const updateCustomAnswer = (customText: string) => {
    updateCurrentDraft(() => ({ selected: [], customText }));
  };

  function submit(answerDrafts: QuestionDraft[] = drafts) {
    if (submittedRef.current || !answerDrafts.every(isQuestionAnswered)) {
      return;
    }
    submittedRef.current = true;
    useInteractiveStore
      .getState()
      .resolveQuestion(toolCallId, collectAnswers(questions, answerDrafts));
  }

  const continueFlow = () => {
    if (!canContinue) return;
    if (isLast) {
      submit();
      return;
    }
    setActiveIndex((index) => index + 1);
  };

  const goToPreviousQuestion = () => {
    setActiveIndex((index) => Math.max(0, index - 1));
  };

  const goToNextQuestion = () => {
    if (canContinue && !isLast) {
      setActiveIndex((index) => index + 1);
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex max-h-[min(32rem,56dvh)] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <header
        className="grid shrink-0 items-start gap-3 px-4 py-4"
        style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}
      >
        <div className="min-w-0">
          <h3
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-semibold leading-snug outline-none"
          >
            {question.question}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {question.header}
            <span aria-hidden="true"> · </span>
            {question.multiSelect
              ? t.chat.askQuestion.multiSelectHint
              : t.chat.askQuestion.singleSelectHint}
          </p>
        </div>

        <div className="flex shrink-0 items-center">
          <TooltipIconButton
            type="button"
            label={t.chat.askQuestion.previous}
            variant="ghost"
            size="icon-sm"
            disabled={activeIndex === 0}
            onClick={goToPreviousQuestion}
            className="rounded-full text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft aria-hidden="true" />
          </TooltipIconButton>
          <span
            aria-hidden="true"
            className="w-12 px-1 text-center text-xs tabular-nums text-muted-foreground"
          >
            {compactProgress}
          </span>
          <span className="sr-only" aria-live="polite">
            {progress}
          </span>
          <TooltipIconButton
            type="button"
            label={t.chat.askQuestion.navigateNext}
            variant="ghost"
            size="icon-sm"
            disabled={!canContinue || isLast}
            onClick={goToNextQuestion}
            className="rounded-full text-muted-foreground hover:text-foreground"
          >
            <ChevronRight aria-hidden="true" />
          </TooltipIconButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
        <fieldset className="grid min-h-0 gap-1 overflow-y-auto">
          <legend className="sr-only">{question.question}</legend>
          {question.options.map((option) => {
            const active =
              draft.customText.length === 0 &&
              draft.selected.includes(option.label);
            return (
              <QuestionOption
                key={option.label}
                option={option}
                type={question.multiSelect ? "checkbox" : "radio"}
                name={question.multiSelect ? undefined : `${headingId}-choice`}
                checked={active}
                onChange={() => selectOption(option.label)}
              />
            );
          })}
        </fieldset>

        <div
          data-active={draft.customText.trim().length > 0}
          className="ask-question-custom-row mt-2 flex h-10 shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-2 transition-colors"
        >
          <Pencil
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <label htmlFor={customInputId} className="sr-only">
            {t.chat.askQuestion.customLabel}
          </label>
          <Input
            id={customInputId}
            value={draft.customText}
            onChange={(event) => updateCustomAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              continueFlow();
            }}
            placeholder={t.chat.askQuestion.otherPlaceholder}
            className="h-8 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />
          <Button
            type="button"
            size="sm"
            disabled={!canContinue}
            onClick={continueFlow}
            className="h-8 rounded-md px-2.5"
          >
            {isLast ? t.chat.askQuestion.submit : t.chat.askQuestion.next}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ApprovalQuestionCard({
  toolCallId,
  questions,
}: Omit<AskUserQuestionCardProps, "presentation">) {
  const t = useT();
  const pending = useInteractiveStore((state) =>
    state.pending.some(
      (item) =>
        item.kind === "question" &&
        item.presentation === "approval" &&
        item.toolCallId === toolCallId,
    ),
  );
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    createDrafts(questions),
  );
  const submittedRef = useRef(false);
  const allAnswered = drafts.length > 0 && drafts.every(isQuestionAnswered);

  if (!pending || questions.length === 0) return null;

  const toggleOption = (
    questionIndex: number,
    label: string,
    multiSelect: boolean,
  ) => {
    setDrafts((current) =>
      current.map((draft, index) => {
        if (index !== questionIndex) return draft;
        if (!multiSelect) return { selected: [label], customText: "" };
        const selected = draft.selected.includes(label)
          ? draft.selected.filter((item) => item !== label)
          : [...draft.selected, label];
        return { selected, customText: "" };
      }),
    );
  };

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <HelpCircle className="size-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-medium">{t.chat.askQuestion.title}</span>
      </div>
      <div className="space-y-3 px-3 py-2">
        {questions.map((question, questionIndex) => (
          <fieldset
            key={`${question.header}-${questionIndex}`}
            className="space-y-2"
          >
            <legend className="text-sm">{question.question}</legend>
            <div className="grid grid-cols-1 gap-1">
              {question.options.map((option) => {
                const active = drafts[questionIndex].selected.includes(
                  option.label,
                );
                return (
                  <QuestionOption
                    key={option.label}
                    option={option}
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={
                      question.multiSelect
                        ? undefined
                        : `${toolCallId}-${questionIndex}-choice`
                    }
                    checked={active}
                    onChange={() =>
                      toggleOption(
                        questionIndex,
                        option.label,
                        question.multiSelect,
                      )
                    }
                  />
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="flex justify-end border-t border-border bg-muted/20 px-3 py-2">
        <Button
          type="button"
          size="sm"
          disabled={!allAnswered}
          onClick={() => {
            if (submittedRef.current) return;
            submittedRef.current = true;
            useInteractiveStore
              .getState()
              .resolveQuestion(toolCallId, collectAnswers(questions, drafts));
          }}
        >
          {t.chat.askQuestion.submit}
        </Button>
      </div>
    </section>
  );
}

export function AskUserAnswerSummary({
  answers,
}: {
  answers: AskUserAnswerSummaryItem[];
}) {
  const t = useT();
  const visibleAnswers = answers
    .map((answer) => ({
      ...answer,
      selections: answer.selections.filter(
        (selection) => selection.trim().length > 0,
      ),
    }))
    .filter((answer) => answer.selections.length > 0);

  if (visibleAnswers.length === 0) return null;

  return (
    <div className="flex justify-end">
      <div
        aria-label={t.chat.askQuestion.answersLabel}
        className="max-w-[80%] space-y-1 rounded-2xl rounded-tr-sm bg-secondary px-4 py-2.5 text-sm text-secondary-foreground"
      >
        {visibleAnswers.map((answer, index) => (
          <p key={index} className="whitespace-pre-wrap break-words">
            {answer.header && (
              <span className="font-medium">
                {answer.header}
                {t.chat.askQuestion.answerSeparator}
              </span>
            )}
            {answer.selections.join(", ")}
          </p>
        ))}
      </div>
    </div>
  );
}
