import { create } from "zustand";
import type {
  DesignReviewReport,
  DesignReviewScreenshot,
} from "../lib/design/review";

export type DesignReviewStatus =
  "idle" | "capturing" | "reviewing" | "complete" | "error";

export interface DesignReviewCaptureProgress {
  completed: number;
  total: number;
  viewport?: string;
}

interface DesignReviewState {
  status: DesignReviewStatus;
  screenshots: DesignReviewScreenshot[];
  report?: DesignReviewReport;
  error?: string;
  captureErrors: string[];
  captureProgress?: DesignReviewCaptureProgress;
  selectedFindingIds: string[];
  setStatus: (status: DesignReviewStatus) => void;
  beginCapture: (total: number) => void;
  updateCaptureProgress: (progress: DesignReviewCaptureProgress) => void;
  setScreenshots: (
    screenshots: DesignReviewScreenshot[],
    captureErrors?: string[],
  ) => void;
  complete: (report: DesignReviewReport) => void;
  fail: (message: string) => void;
  toggleFinding: (id: string) => void;
  reset: () => void;
}

const initialState = {
  status: "idle" as const,
  screenshots: [] as DesignReviewScreenshot[],
  report: undefined,
  error: undefined,
  captureErrors: [] as string[],
  captureProgress: undefined,
  selectedFindingIds: [] as string[],
};

export const useDesignReviewStore = create<DesignReviewState>((set) => ({
  ...initialState,
  setStatus: (status) => set({ status, error: undefined }),
  beginCapture: (total) =>
    set({
      status: "capturing",
      screenshots: [],
      report: undefined,
      error: undefined,
      captureErrors: [],
      captureProgress: { completed: 0, total },
      selectedFindingIds: [],
    }),
  updateCaptureProgress: (captureProgress) => set({ captureProgress }),
  setScreenshots: (screenshots, captureErrors = []) =>
    set({
      status: "idle",
      screenshots: [...screenshots],
      report: undefined,
      error: undefined,
      captureErrors: [...captureErrors],
      captureProgress: undefined,
      selectedFindingIds: [],
    }),
  complete: (report) =>
    set({
      status: "complete",
      report,
      error: undefined,
      captureProgress: undefined,
      selectedFindingIds: [],
    }),
  fail: (error) => set({ status: "error", error, captureProgress: undefined }),
  toggleFinding: (id) =>
    set((state) => ({
      selectedFindingIds: state.selectedFindingIds.includes(id)
        ? state.selectedFindingIds.filter((candidate) => candidate !== id)
        : [...state.selectedFindingIds, id],
    })),
  reset: () => set(initialState),
}));
