// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import type { MergedMessage } from "../../types";
import { MessageBubble } from "./MessageBubble";

const failure = {
  code: "providerApprovalRejected" as const,
  phase: "tool" as const,
  provider: "codex" as const,
  safeMessage: "The local CLI could not invoke the approved Host tool.",
  diagnosticId: "diag-ui-1",
  hadActivity: true,
  hadHostSideEffect: false,
  retryPolicy: "none" as const,
};

const message: MergedMessage = {
  id: "assistant-local-error",
  role: "assistant",
  blocks: [
    {
      type: "text",
      id: "error-text",
      content:
        "⚠️ **Local CLI runtime error**\n\nThe local CLI could not invoke the approved Host tool.\n\n**Provider:** codex\n**Phase:** tool\n**Diagnostic ID:** `diag-ui-1`",
    },
  ],
  isError: true,
  errorKind: "tool",
  errorRetryable: false,
  localCliFailure: failure,
};

describe("MessageBubble local CLI diagnostics", () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it("shows safe provider details and copies only the diagnostic id", async () => {
    const user = userEvent.setup();
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    render(<MessageBubble message={message} />);

    expect(
      await screen.findByText(/local CLI could not invoke/i),
    ).toBeInTheDocument();
    expect(await screen.findByText(/diag-ui-1/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy diagnostic ID" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/stderr/i)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Copy diagnostic ID" }),
    );
    expect(clipboardWrite).toHaveBeenCalledWith("diag-ui-1");
  });
});
