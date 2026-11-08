// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "../../i18n/en";
import { AutomaticDesignReviewNotice } from "./AutomaticDesignReviewNotice";

vi.mock("../../i18n", () => ({ useT: () => en }));
afterEach(() => vi.useRealTimers());

it("can dismiss a failure and show a fresh notice for a new request", async () => {
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const props = { stage: "unavailable" as const, visible: true, onOpen };
  const { rerender } = render(
    <AutomaticDesignReviewNotice {...props} key="first" />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: en.designReview.dismissNotice }),
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  rerender(<AutomaticDesignReviewNotice {...props} key="second" />);
  expect(screen.getByRole("status")).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(onOpen).not.toHaveBeenCalled();
});

it("opens details explicitly and clears its display timer on unmount", () => {
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const { unmount } = render(
    <AutomaticDesignReviewNotice stage="unavailable" visible onOpen={onOpen} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: en.designReview.openWorkspace }),
  );
  expect(onOpen).toHaveBeenCalledOnce();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
