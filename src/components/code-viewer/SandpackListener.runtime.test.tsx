// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSandpackStore } from "../../store/sandpack";

const fixture = vi.hoisted(() => {
  const listeners = new Set<(message: unknown) => void>();
  return {
    listeners,
    listen: (callback: (message: unknown) => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    logs: [] as Array<{ id: string; method: string; data: string[] }>,
  };
});

vi.mock("@codesandbox/sandpack-react", () => ({
  useSandpack: () => ({
    sandpack: { files: {}, activeFile: "", setActiveFile: vi.fn() },
    listen: fixture.listen,
  }),
  useSandpackConsole: () => ({ logs: fixture.logs }),
}));

import { SandpackListener } from "./SandpackListener";

function dispatch(message: unknown) {
  act(() => fixture.listeners.forEach((listener) => listener(message)));
}

describe("Sandpack runtime diagnostics", () => {
  beforeEach(() => {
    fixture.listeners.clear();
    fixture.logs = [];
    useSandpackStore.setState({ consoleLogs: [] });
  });

  it("keeps a new browser error after a full buffer of older server output", () => {
    const { rerender } = render(
      <SandpackListener
        conversationId="test"
        requestedActiveFile=""
        onFileChange={vi.fn()}
      />,
    );
    for (let index = 0; index < 30; index += 1) {
      dispatch({
        type: "stdout",
        payload: { type: "out", data: `startup ${index}` },
      });
    }
    fixture.logs = [
      { id: "new-error", method: "error", data: ["React render failed"] },
    ];
    rerender(
      <SandpackListener
        conversationId="test"
        requestedActiveFile=""
        onFileChange={vi.fn()}
      />,
    );
    expect(useSandpackStore.getState().consoleLogs).toHaveLength(30);
    expect(useSandpackStore.getState().consoleLogs.at(-1)?.data).toEqual([
      "React render failed",
    ]);
  });

  it("retains server errors alongside browser logs and clears them on restart", () => {
    const element = (
      <SandpackListener
        conversationId="test"
        requestedActiveFile=""
        onFileChange={vi.fn()}
      />
    );
    const { rerender, unmount } = render(element);
    dispatch({
      type: "stdout",
      payload: {
        type: "err",
        data: "[vite] Internal server error: The service is no longer running",
      },
    });
    fixture.logs = [
      { id: "browser", method: "log", data: ["client connected"] },
    ];
    rerender(
      <SandpackListener
        conversationId="test"
        requestedActiveFile=""
        onFileChange={vi.fn()}
      />,
    );
    expect(useSandpackStore.getState().consoleLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "error",
          data: [expect.stringContaining("The service is no longer running")],
        }),
        expect.objectContaining({ id: "browser" }),
      ]),
    );
    dispatch({ type: "start", firstLoad: false });
    expect(
      useSandpackStore
        .getState()
        .consoleLogs.some((log) => log.method === "error"),
    ).toBe(false);
    unmount();
    expect(fixture.listeners.size).toBe(0);
  });

  it("records runtime failure notifications but keeps normal stdout informational", () => {
    render(
      <SandpackListener
        conversationId="test"
        requestedActiveFile=""
        onFileChange={vi.fn()}
      />,
    );
    dispatch({ type: "stdout", payload: { type: "out", data: "VITE ready" } });
    dispatch({
      type: "action",
      action: "notification",
      notificationType: "error",
      title: "process.exit(2) called",
    });
    expect(useSandpackStore.getState().consoleLogs).toEqual([
      expect.objectContaining({ method: "log" }),
      expect.objectContaining({
        method: "error",
        data: [expect.stringContaining("process.exit(2)")],
      }),
    ]);
  });
});
