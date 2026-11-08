import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// jsdom has no layout engine. Real scrollbar measurements are covered in E2E.
beforeEach(() => {
  if (typeof window !== "undefined" && !globalThis.ResizeObserver) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
  }
});

afterEach(() => {
  cleanup();
});
