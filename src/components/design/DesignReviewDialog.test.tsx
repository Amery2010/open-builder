// @vitest-environment jsdom

import type { ReactNode } from "react";
import {
  render as renderTestingLibrary,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useDesignReviewStore } from "../../store/design-review";
import { TooltipProvider } from "../ui/tooltip";
import { DesignReviewDialog } from "./DesignReviewDialog";

function render(ui: ReactNode) {
  return renderTestingLibrary(<TooltipProvider>{ui}</TooltipProvider>);
}

const localforageMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  const instance = {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
  return { instance, createInstance: vi.fn(() => instance) };
});

const requestConfirmationMock = vi.hoisted(() => vi.fn());

vi.mock("localforage", () => ({
  default: { createInstance: localforageMock.createInstance },
}));

vi.mock("../../lib/confirmation", () => ({
  requestConfirmation: requestConfirmationMock,
}));

const findings = [
  {
    id: "contrast-primary-action",
    priority: "P1" as const,
    dimension: "accessibility" as const,
    title: "Primary action lacks contrast",
    evidence: "The mobile screenshot shows low contrast.",
    recommendation: "Use --accent-on for the label.",
  },
  {
    id: "generic-hero-copy",
    priority: "P2" as const,
    dimension: "copy_specificity" as const,
    title: "Hero copy is generic",
    evidence: "The headline does not identify the product outcome.",
    recommendation: "Name the concrete workflow and audience.",
  },
];

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function automaticScreenshot(index: number) {
  return {
    dataUrl: `data:image/png;base64,${btoa(
      Array.from(pngBytes, (byte) => String.fromCharCode(byte)).join(""),
    )}`,
    mimeType: "image/png" as const,
    name: `automatic-${index}.png`,
    source: "automatic" as const,
  };
}

describe("DesignReviewDialog", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    useDesignReviewStore.getState().reset();
    useDesignReviewStore.getState().clearRuns();
    requestConfirmationMock.mockReset();
    requestConfirmationMock.mockResolvedValue(true);
  });

  it("keeps the review body scrollable between fixed header and footer", () => {
    render(
      <DesignReviewDialog
        open
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        isGenerating={false}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const body = dialog.querySelector<HTMLElement>('[data-slot="dialog-body"]');
    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-hidden");
    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass(
      "shrink-0",
    );
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).toHaveClass(
      "shrink-0",
    );
    expect(dialog.querySelectorAll('[data-slot="dialog-body"]')).toHaveLength(
      1,
    );
    expect(body).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
  });

  it("localizes the fixed-height execution log without timestamp icons", () => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "zh" },
    }));
    useDesignReviewStore.getState().createRun({
      id: "review-localized",
      conversationId: "conversation-1",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      sourceProjectDigest: "b".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "test" },
      capturedCount: 3,
      status: "queued",
      now: 1,
    });

    render(
      <DesignReviewDialog
        open
        conversationId="conversation-1"
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        isGenerating={false}
      />,
    );

    const log = screen.getByRole("list", { name: "设计审查执行日志" });
    expect(log).toHaveClass("h-44", "overflow-y-auto");
    expect(log.querySelector(".lucide-clock-3")).not.toBeInTheDocument();
    expect(screen.getByText("已捕获 3 张截图。")).toBeVisible();
    expect(screen.getByText("设计审查已进入后台执行队列。")).toBeVisible();
  });

  it("starts automatic capture once when the Review dialog opens", async () => {
    const onCaptureScreenshots = vi.fn(() => {
      useDesignReviewStore.getState().beginCapture(3);
    });
    render(
      <DesignReviewDialog
        open
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        onCaptureScreenshots={onCaptureScreenshots}
        isGenerating={false}
      />,
    );

    await waitFor(() => expect(onCaptureScreenshots).toHaveBeenCalledOnce());
    expect(screen.getByText("Capturing responsive previews")).toBeVisible();
    expect(screen.getByText(/Captured 0 of 3/)).toBeVisible();
  });

  it("applies only explicitly selected findings", async () => {
    const user = userEvent.setup();
    useDesignReviewStore.getState().complete({
      overview: "Two concrete findings.",
      findings,
    });
    const onApplyFixes = vi.fn(async () => {});
    render(
      <DesignReviewDialog
        open
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={onApplyFixes}
        isGenerating={false}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: /Primary action lacks contrast/ }),
    );
    const apply = screen.getByRole("button", {
      name: "Apply 1 selected fixes",
    });
    await user.click(apply);
    expect(onApplyFixes).toHaveBeenCalledWith([findings[0]]);
  });

  it("selects and clears all findings with one toggle", async () => {
    const user = userEvent.setup();
    useDesignReviewStore.getState().complete({
      overview: "Two concrete findings.",
      findings,
    });
    render(
      <DesignReviewDialog
        open
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        isGenerating={false}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Select all findings" });
    await user.click(toggle);
    expect(useDesignReviewStore.getState().selectedFindingIds).toEqual(
      findings.map((finding) => finding.id),
    );
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await user.click(
      screen.getByRole("button", { name: "Clear all findings" }),
    );
    expect(useDesignReviewStore.getState().selectedFindingIds).toEqual([]);
  });

  it("keeps partial capture coverage visible with the completed report", () => {
    useDesignReviewStore
      .getState()
      .setScreenshots([automaticScreenshot(1)], ["tablet failed"]);
    useDesignReviewStore.getState().complete({
      overview: "Limited responsive coverage.",
      findings: [],
    });
    render(
      <DesignReviewDialog
        open
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        isGenerating={false}
      />,
    );

    expect(
      screen.getByText(/Some responsive previews could not be captured/),
    ).toBeVisible();
    expect(screen.getByText("tablet failed")).toBeVisible();
  });

  it("uses the same upload-only review flow on every platform", async () => {
    const user = userEvent.setup();
    const onRunReview = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    render(
      <DesignReviewDialog
        open
        onOpenChange={onOpenChange}
        onRunReview={onRunReview}
        onApplyFixes={vi.fn()}
        isGenerating={false}
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(
      input!,
      new File([pngBytes], "web-preview.png", { type: "image/png" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Run read-only review" }),
    );
    expect(onRunReview).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "web-preview.png",
        mimeType: "image/png",
      }),
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("appends manual screenshots to partial automatic coverage when the total stays within three", async () => {
    const user = userEvent.setup();
    useDesignReviewStore
      .getState()
      .setScreenshots(
        [automaticScreenshot(1), automaticScreenshot(2)],
        ["mobile failed"],
      );
    render(
      <DesignReviewDialog
        open
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        isGenerating={false}
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      input,
      new File([pngBytes], "mobile-manual.png", { type: "image/png" }),
    );

    await waitFor(() =>
      expect(useDesignReviewStore.getState().screenshots).toHaveLength(3),
    );
    expect(
      useDesignReviewStore
        .getState()
        .screenshots.map((screenshot) => screenshot.source),
    ).toEqual(["automatic", "automatic", "manual"]);
  });

  it("replaces a full automatic set when manual screenshots are selected", async () => {
    const user = userEvent.setup();
    useDesignReviewStore
      .getState()
      .setScreenshots([
        automaticScreenshot(1),
        automaticScreenshot(2),
        automaticScreenshot(3),
      ]);
    render(
      <DesignReviewDialog
        open
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        isGenerating={false}
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      input,
      new File([pngBytes], "replacement.png", { type: "image/png" }),
    );

    await waitFor(() =>
      expect(useDesignReviewStore.getState().screenshots).toHaveLength(1),
    );
    expect(useDesignReviewStore.getState().screenshots[0]).toMatchObject({
      name: "replacement.png",
      source: "manual",
    });
  });

  it("shows persistent run history and can cancel the active review", async () => {
    const user = userEvent.setup();
    const run = useDesignReviewStore.getState().createRun({
      id: "review-active",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt-review" },
    })!;
    useDesignReviewStore.getState().updateRunStatus(run.id, "running");
    const onCancelRun = vi.fn();
    render(
      <DesignReviewDialog
        open
        conversationId="conversation"
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        onCancelRun={onCancelRun}
        isGenerating={false}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Review history" }),
    ).toBeVisible();
    expect(
      screen.getByRole("list", { name: "Design Review execution log" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel review" }));
    expect(onCancelRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "review-active" }),
    );
  });

  it("confirms and deletes terminal review history", async () => {
    const user = userEvent.setup();
    const store = useDesignReviewStore.getState();
    store.createRun({
      id: "review-history-delete",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt-review" },
    });
    store.updateRunStatus("review-history-delete", "succeeded");
    render(
      <DesignReviewDialog
        open
        conversationId="conversation"
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        isGenerating={false}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete review history" }),
    );
    expect(requestConfirmationMock).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true }),
    );
    await waitFor(() =>
      expect(
        useDesignReviewStore.getState().runsByConversation.conversation,
      ).toEqual([]),
    );
  });

  it("keeps terminal review history when deletion is cancelled", async () => {
    const user = userEvent.setup();
    const store = useDesignReviewStore.getState();
    store.createRun({
      id: "review-history-keep",
      conversationId: "conversation",
      kind: "manual",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "api", provider: "openai", model: "gpt-review" },
    });
    store.updateRunStatus("review-history-keep", "succeeded");
    requestConfirmationMock.mockResolvedValue(false);
    render(
      <DesignReviewDialog
        open
        conversationId="conversation"
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        isGenerating={false}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete review history" }),
    );
    await waitFor(() => expect(requestConfirmationMock).toHaveBeenCalledOnce());
    expect(
      useDesignReviewStore.getState().runsByConversation.conversation,
    ).toEqual([expect.objectContaining({ id: "review-history-keep" })]);
  });

  it("keeps stale findings visible but disables applying them", async () => {
    const user = userEvent.setup();
    const store = useDesignReviewStore.getState();
    const run = store.createRun({
      id: "review-stale",
      conversationId: "conversation",
      kind: "automatic",
      sourceDigest: "a".repeat(64),
      provider: { runtime: "local", provider: "codex", model: "review" },
    })!;
    store.completeRun(run.id, {
      overview: "One finding.",
      findings: [findings[0]],
    });
    store.markConversationFreshness("conversation", "b".repeat(64));
    const onRetryRun = vi.fn();
    render(
      <DesignReviewDialog
        open
        conversationId="conversation"
        onOpenChange={vi.fn()}
        onRunReview={vi.fn()}
        onApplyFixes={vi.fn()}
        onRetryRun={onRetryRun}
        isGenerating={false}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: /Primary action lacks contrast/ }),
    );
    expect(
      screen.getByRole("button", { name: "Apply 1 selected fixes" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Recapture & retry" }));
    expect(onRetryRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "review-stale", freshness: "stale" }),
    );
  });
});
