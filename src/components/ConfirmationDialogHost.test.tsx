// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmationDialogHost } from "./ConfirmationDialogHost";
import {
  cancelAllConfirmations,
  requestConfirmation,
} from "../lib/confirmation";

describe("ConfirmationDialogHost", () => {
  afterEach(() => {
    cancelAllConfirmations();
  });

  it("renders text-only destructive confirmations and resolves cancel", async () => {
    const user = userEvent.setup();
    render(<ConfirmationDialogHost />);
    const result = requestConfirmation({
      title: "Delete project",
      message: "<img src=x onerror=alert(1)>",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      destructive: true,
    });

    expect(await screen.findByRole("alertdialog")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(result).resolves.toBe(false);
  });

  it("does not settle when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    render(<ConfirmationDialogHost />);
    let settled = false;
    const result = requestConfirmation({ message: "Keep this open" });
    void result.then(() => {
      settled = true;
    });

    expect(await screen.findByRole("alertdialog")).toBeVisible();
    await user.click(
      document.querySelector('[data-slot="alert-dialog-overlay"]')!,
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await expect(result).resolves.toBe(true);
  });

  it("keeps queued prompts serial and focuses cancel for each prompt", async () => {
    const user = userEvent.setup();
    render(<ConfirmationDialogHost />);
    const first = requestConfirmation({ message: "First prompt" });
    const second = requestConfirmation({ message: "Second prompt" });

    expect(await screen.findByText("First prompt")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await expect(first).resolves.toBe(true);

    expect(await screen.findByText("Second prompt")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(second).resolves.toBe(false);
  });

  it("resolves Escape as cancellation", async () => {
    const user = userEvent.setup();
    render(<ConfirmationDialogHost />);
    const result = requestConfirmation({ message: "Escape me" });

    expect(await screen.findByRole("alertdialog")).toBeVisible();
    await user.keyboard("{Escape}");
    await expect(result).resolves.toBe(false);
  });
});
