// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { getT } from "../../i18n";
import { useConversationStore } from "../../store/conversation";
import { useDesignReviewStore } from "../../store/design-review";
import type { DesignReviewRun } from "../../lib/design/review-jobs/types";
import { DesignReviewActivityBlock } from "./DesignReviewActivityBlock";

function failedRun(): DesignReviewRun {
  return {
    id: "automatic-failure",
    conversationId: "conversation",
    kind: "automatic",
    phase: "initial",
    status: "failed",
    freshness: "fresh",
    sourceDigest: "a".repeat(64),
    provider: { runtime: "api", provider: "openai", model: "gpt" },
    logs: [],
    error: "Preview bridge timed out",
    createdAt: 1,
    updatedAt: 1,
    completedAt: 1,
  };
}

describe("DesignReviewActivityBlock", () => {
  beforeEach(() => {
    useConversationStore.setState({
      activeId: "conversation",
      conversations: {},
    });
    useDesignReviewStore.getState().reset();
    useDesignReviewStore.getState().clearRuns();
  });

  it("shows the recorded failure cause instead of the waiting placeholder", () => {
    useDesignReviewStore.setState({
      runsByConversation: { conversation: [failedRun()] },
    });

    render(<DesignReviewActivityBlock reviewJobId="automatic-failure" />);

    expect(screen.getByText("Preview bridge timed out")).toBeVisible();
    expect(
      screen.queryByText(getT().designReview.activityWaiting),
    ).not.toBeInTheDocument();
  });

  it("explains when an old failed activity has no persisted details", () => {
    render(
      <DesignReviewActivityBlock
        reviewJobId="pruned-failure"
        summary={{ status: "failed" }}
      />,
    );

    expect(
      screen.getByText(getT().designReview.failureDetailsUnavailable),
    ).toBeVisible();
    expect(
      screen.queryByText(getT().designReview.activityWaiting),
    ).not.toBeInTheDocument();
  });
});
