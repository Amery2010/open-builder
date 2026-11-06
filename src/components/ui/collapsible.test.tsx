// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";

describe("animated collapsible accessibility", () => {
  it("makes closing content inert and returns its keyboard focus to the trigger", () => {
    function Panel({ open }: { open: boolean }) {
      return (
        <Collapsible open={open}>
          <CollapsibleTrigger>Details</CollapsibleTrigger>
          <CollapsibleContent forceMount>
            <button>Copy details</button>
          </CollapsibleContent>
        </Collapsible>
      );
    }

    const { rerender } = render(<Panel open />);
    const trigger = screen.getByRole("button", { name: "Details" });
    const copy = screen.getByRole("button", { name: "Copy details" });
    const content = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    );
    copy.focus();
    rerender(<Panel open={false} />);

    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(content).toHaveAttribute("inert");
    expect(content).toHaveAttribute("aria-hidden", "true");

    rerender(<Panel open />);
    expect(content).not.toHaveAttribute("inert");
    expect(content).not.toHaveAttribute("aria-hidden");
  });
});
