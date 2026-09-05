// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  PermissionRequestDialog,
  type PermissionRequestDialogLabels,
  type PermissionRequestDialogProps,
} from "./PermissionRequestDialog";

const labels: PermissionRequestDialogLabels = {
  title: "Permission required",
  description: "The Host wants to change files in this project.",
  operation: {
    delete: "Delete files",
    move: "Move or rename files",
    replace_project: "Replace project",
  },
  affected: "Affected paths",
  paths: "Paths",
  scope: "Session scope",
  exact: "Only these paths",
  exactDescription: "Limit future requests to the listed paths.",
  commonParent: "Common parent",
  commonParentDescription: "Include future requests under this folder.",
  project: "Entire project",
  projectDescription: "Include all paths in this project.",
  deny: "Deny",
  allowOnce: "Allow once",
  allowSession: "Allow this session",
  close: "Close permission request",
  sessionDisabled: "Session access is unavailable for this operation.",
  submitting: "Saving your decision…",
  error: "Permission error",
};

function renderDialog(overrides: Partial<PermissionRequestDialogProps> = {}) {
  const props: PermissionRequestDialogProps = {
    open: true,
    operation: "delete",
    paths: ["src/old.ts", "src/unused.ts"],
    count: 2,
    eligibleForSession: true,
    commonParent: "src",
    submitting: false,
    labels,
    onDeny: vi.fn(),
    onAllowOnce: vi.fn(),
    onAllowSession: vi.fn(),
    ...overrides,
  };
  render(<PermissionRequestDialog {...props} />);
  return props;
}

describe("PermissionRequestDialog", () => {
  it("shows only host-safe metadata and starts with the deny action focused", async () => {
    renderDialog();

    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Permission required",
    );
    expect(screen.getByText("Delete files")).toBeVisible();
    expect(screen.getByText("src/old.ts")).toBeVisible();
    expect(screen.getByText("src/unused.ts")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(screen.queryByText(/patch|secret|API_KEY/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Only these paths/ }),
    ).toBeChecked();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus(),
    );
  });

  it("emits deny, allow-once, and exact-path session decisions explicitly", async () => {
    const user = userEvent.setup();
    const onDeny = vi.fn();
    const onAllowOnce = vi.fn();
    const onAllowSession = vi.fn();
    renderDialog({ onDeny, onAllowOnce, onAllowSession });

    await user.click(screen.getByRole("button", { name: "Deny" }));
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    await user.click(
      screen.getByRole("button", { name: "Allow this session" }),
    );

    expect(onDeny).toHaveBeenCalledOnce();
    expect(onAllowOnce).toHaveBeenCalledOnce();
    expect(onAllowSession).toHaveBeenCalledWith({
      kind: "exact",
      paths: ["src/old.ts", "src/unused.ts"],
    });
  });

  it("passes the selected common-parent or project scope", async () => {
    const user = userEvent.setup();
    const onAllowSession = vi.fn();
    renderDialog({ onAllowSession });

    await user.click(screen.getByRole("radio", { name: /Common parent/ }));
    await user.click(
      screen.getByRole("button", { name: "Allow this session" }),
    );
    expect(onAllowSession).toHaveBeenCalledWith({
      kind: "subtree",
      path: "src",
    });

    await user.click(screen.getByRole("radio", { name: /Entire project/ }));
    await user.click(
      screen.getByRole("button", { name: "Allow this session" }),
    );
    expect(onAllowSession).toHaveBeenLastCalledWith({ kind: "project" });
  });

  it("disables session access and explains why project replacement is one-shot", () => {
    renderDialog({
      operation: "replace_project",
      eligibleForSession: false,
      paths: ["."],
      count: 4,
    });

    expect(
      screen.getByRole("button", { name: "Allow this session" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Session access is unavailable for this operation."),
    ).toBeVisible();
    expect(
      screen.getByRole("radio", { name: /Only these paths/ }),
    ).toBeDisabled();
  });

  it("denies on Escape and title-bar close, but not backdrop interaction", async () => {
    const user = userEvent.setup();
    const onDeny = vi.fn();
    renderDialog({ onDeny });

    const backdrop = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    );
    expect(backdrop).not.toBeNull();
    await user.click(backdrop!);
    expect(onDeny).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onDeny).toHaveBeenCalledOnce();
  });

  it("routes the title-bar close through deny", async () => {
    const user = userEvent.setup();
    const onDeny = vi.fn();
    renderDialog({ onDeny });

    await user.click(
      screen.getByRole("button", { name: "Close permission request" }),
    );
    expect(onDeny).toHaveBeenCalledOnce();
  });

  it("never treats Enter as an implicit approval", async () => {
    const user = userEvent.setup();
    const onAllowOnce = vi.fn();
    const onAllowSession = vi.fn();
    renderDialog({ onAllowOnce, onAllowSession });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus(),
    );
    await user.keyboard("{Enter}");

    expect(onAllowOnce).not.toHaveBeenCalled();
    expect(onAllowSession).not.toHaveBeenCalled();
  });

  it("locks actions while submitting and exposes an error state", async () => {
    const user = userEvent.setup();
    const onAllowOnce = vi.fn();
    renderDialog({
      submitting: true,
      error: "The permission request expired.",
      onAllowOnce,
    });

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving your decision…",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Permission error: The permission request expired.",
    );
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Allow this session" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onAllowOnce).not.toHaveBeenCalled();
  });

  it("shows a terminal submission error with only a safe close action", async () => {
    const user = userEvent.setup();
    const onDeny = vi.fn();
    renderDialog({
      error: "Audit storage is unavailable.",
      onDeny,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Audit storage is unavailable.",
    );
    expect(
      screen.queryByRole("button", { name: "Allow once" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow this session" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByText("Close permission request"));
    expect(onDeny).toHaveBeenCalledOnce();
  });
});
