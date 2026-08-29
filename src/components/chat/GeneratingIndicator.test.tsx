// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../store/settings";
import { GeneratingIndicator } from "./GeneratingIndicator";

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("GeneratingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installMatchMedia(false);
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("types, holds, deletes and randomly selects the next progressive verb", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const { container } = render(<GeneratingIndicator />);
    const indicator = container.querySelector<HTMLElement>("[role='status']");
    const visibleText = () =>
      container.querySelector("span[aria-hidden='true']")?.textContent;
    const target = "Thinking…";

    expect(indicator).toHaveClass("h-7", "shrink-0");
    expect(visibleText()).toBe("");
    for (let index = 0; index < target.length; index += 1) {
      act(() => vi.advanceTimersByTime(85));
    }
    expect(visibleText()).toBe(target);

    act(() => vi.advanceTimersByTime(2_999));
    expect(visibleText()).toBe(target);
    act(() => vi.advanceTimersByTime(1));
    expect(visibleText()).toBe(target);
    for (let index = 0; index < target.length; index += 1) {
      act(() => vi.advanceTimersByTime(50));
    }
    expect(visibleText()).toBe("");
    expect(indicator).toHaveClass("h-7", "shrink-0");

    act(() => vi.advanceTimersByTime(200));
    expect(random).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(85));
    expect(visibleText()).toBe("T");
  });

  it("shows a complete static phrase when reduced motion is requested", () => {
    installMatchMedia(true);
    const { container } = render(<GeneratingIndicator />);
    const visible = container.querySelector("span[aria-hidden='true']");

    expect(visible).toHaveTextContent("Thinking…");
    act(() => vi.advanceTimersByTime(10_000));
    expect(visible).toHaveTextContent("Thinking…");
  });
});
