// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { useDesignReviewStore } from "../../store/design-review";
import { DesignReviewDialog } from "./DesignReviewDialog";

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
    render(
      <DesignReviewDialog
        open
        onOpenChange={vi.fn()}
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
});
