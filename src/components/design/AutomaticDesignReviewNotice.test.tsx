// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { Toaster, toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "../../i18n/en";
import { AutomaticDesignReviewNotice } from "./AutomaticDesignReviewNotice";

vi.mock("../../i18n", () => ({ useT: () => en }));
afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function Notifications({ children }: PropsWithChildren) {
  return (
    <>
      <Toaster />
      {children}
    </>
  );
}

async function advance(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it("can dismiss a failure and show a fresh notice for a new request", async () => {
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const props = { stage: "unavailable" as const, visible: true, onOpen };
  const { rerender } = render(
    <AutomaticDesignReviewNotice {...props} key="first" />,
    { wrapper: Notifications },
  );
  await advance();
  fireEvent.click(
    screen.getByRole("button", { name: en.designReview.dismissNotice }),
  );
  await advance(200);
  expect(
    screen.queryByText(en.designReview.automaticStages.unavailable),
  ).toBeNull();
  rerender(<AutomaticDesignReviewNotice {...props} key="second" />);
  await advance();
  expect(
    screen.getByText(en.designReview.automaticStages.unavailable),
  ).toBeInTheDocument();
  await advance(8_200);
  expect(
    screen.queryByText(en.designReview.automaticStages.unavailable),
  ).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
});

it("opens details explicitly and dismisses its toast on unmount", async () => {
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const { unmount } = render(
    <AutomaticDesignReviewNotice stage="unavailable" visible onOpen={onOpen} />,
    { wrapper: Notifications },
  );
  await advance();
  fireEvent.click(
    screen.getByRole("button", { name: en.designReview.openWorkspace }),
  );
  expect(onOpen).toHaveBeenCalledOnce();
  await advance(200);
  expect(
    screen.queryByText(en.designReview.automaticStages.unavailable),
  ).toBeNull();
  unmount();
  await advance(50);
  expect(toast.getToasts()).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("hides progress while the review is open and restores it when closed", async () => {
  vi.useFakeTimers();
  const props = { stage: "reviewing" as const, visible: true, onOpen: vi.fn() };
  const { rerender } = render(<AutomaticDesignReviewNotice {...props} />, {
    wrapper: Notifications,
  });
  await advance();
  expect(
    screen.getByText(en.designReview.automaticStages.reviewing),
  ).toBeInTheDocument();
  rerender(<AutomaticDesignReviewNotice {...props} visible={false} />);
  await advance(50);
  await advance(200);
  expect(
    screen.queryByText(en.designReview.automaticStages.reviewing),
  ).toBeNull();
  rerender(<AutomaticDesignReviewNotice {...props} />);
  await advance();
  expect(
    screen.getByText(en.designReview.automaticStages.reviewing),
  ).toBeInTheDocument();
});
