// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sandpackState, setActiveFile, setConsoleLogs } = vi.hoisted(() => ({
  sandpackState: {
    activeFile: "/src/App.tsx",
    files: { "/src/App.tsx": { code: "app" } },
  },
  setActiveFile: vi.fn(),
  setConsoleLogs: vi.fn(),
}));

vi.mock("@codesandbox/sandpack-react", () => ({
  useSandpack: () => ({
    sandpack: {
      ...sandpackState,
      setActiveFile,
    },
  }),
  useSandpackConsole: () => ({ logs: [] }),
}));

vi.mock("@/store/sandpack", () => ({
  useSandpackStore: (
    selector: (state: { setConsoleLogs: typeof setConsoleLogs }) => unknown,
  ) => selector({ setConsoleLogs }),
}));

vi.mock("./sandpack-file-changes", () => ({
  createSandpackFileChangeScheduler: () => ({
    schedule: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  }),
}));

import { SandpackListener } from "./SandpackListener";

describe("SandpackListener active file synchronization", () => {
  beforeEach(() => {
    sandpackState.activeFile = "/src/App.tsx";
    setActiveFile.mockClear();
  });

  it("updates Sandpack when the external current file changes", async () => {
    render(
      <SandpackListener
        conversationId="conversation-a"
        requestedActiveFile="/src/main.tsx"
        onFileChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(setActiveFile).toHaveBeenCalledWith("/src/main.tsx");
    });
  });

  it("does not reselect the active file when the path is unchanged", () => {
    render(
      <SandpackListener
        conversationId="conversation-a"
        requestedActiveFile="/src/App.tsx"
        onFileChange={vi.fn()}
      />,
    );

    expect(setActiveFile).not.toHaveBeenCalled();
  });
});
