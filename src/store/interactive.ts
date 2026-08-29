import { create } from "zustand";
import type {
  AskUserQuestion,
  AskUserAnswers,
  PlanDecision,
} from "../types/api";

export type {
  AskUserQuestion,
  AskUserAnswerItem,
  AskUserAnswers,
  PlanDecision,
} from "../types/api";

export type QuestionPresentation = "questionnaire" | "approval";

interface PendingQuestion {
  kind: "question";
  toolCallId: string;
  questions: AskUserQuestion[];
  presentation: QuestionPresentation;
  resolve: (answer: AskUserAnswers) => void;
  reject: (err: Error) => void;
}

interface PendingPlan {
  kind: "plan";
  toolCallId: string;
  plan: string;
  resolve: (decision: PlanDecision) => void;
  reject: (err: Error) => void;
}

type PendingItem = PendingQuestion | PendingPlan;

interface InteractiveState {
  pending: PendingItem[];

  askQuestion: (input: {
    toolCallId: string;
    questions: AskUserQuestion[];
    presentation?: QuestionPresentation;
  }) => Promise<AskUserAnswers>;

  askPlanApproval: (input: {
    toolCallId: string;
    plan: string;
  }) => Promise<PlanDecision>;

  resolveQuestion: (toolCallId: string, answers: AskUserAnswers) => void;
  resolvePlan: (toolCallId: string, decision: PlanDecision) => void;
  rejectAllPending: (reason: string) => void;

  getPending: (toolCallId: string) => PendingItem | undefined;
}

export const useInteractiveStore = create<InteractiveState>((set, get) => ({
  pending: [],

  askQuestion: ({ toolCallId, questions, presentation = "questionnaire" }) =>
    new Promise<AskUserAnswers>((resolve, reject) => {
      set((state) => ({
        pending: [
          ...state.pending,
          {
            kind: "question",
            toolCallId,
            questions,
            presentation,
            resolve,
            reject,
          },
        ],
      }));
    }),

  askPlanApproval: ({ toolCallId, plan }) =>
    new Promise<PlanDecision>((resolve, reject) => {
      set((state) => ({
        pending: [
          ...state.pending,
          { kind: "plan", toolCallId, plan, resolve, reject },
        ],
      }));
    }),

  resolveQuestion: (toolCallId, answers) => {
    const item = get().pending.find(
      (p): p is PendingQuestion =>
        p.kind === "question" && p.toolCallId === toolCallId,
    );
    if (!item) return;
    set((state) => ({
      pending: state.pending.filter((p) => p.toolCallId !== toolCallId),
    }));
    item.resolve(answers);
  },

  resolvePlan: (toolCallId, decision) => {
    const item = get().pending.find(
      (p): p is PendingPlan => p.kind === "plan" && p.toolCallId === toolCallId,
    );
    if (!item) return;
    item.resolve(decision);
    set((state) => ({
      pending: state.pending.filter((p) => p.toolCallId !== toolCallId),
    }));
  },

  rejectAllPending: (reason) => {
    const items = get().pending;
    if (items.length === 0) return;
    for (const item of items) {
      try {
        item.reject(new DOMException(reason, "AbortError"));
      } catch {
        /* ignore */
      }
    }
    set({ pending: [] });
  },

  getPending: (toolCallId) =>
    get().pending.find((p) => p.toolCallId === toolCallId),
}));
