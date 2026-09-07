// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  PreviewErrorBoundary,
  type PreviewErrorBoundaryFallbackProps,
} from "./PreviewErrorBoundary";

function ThrowOnRender({ message }: { message: string }): ReactNode {
  throw new Error(message);
}

function ErrorFallback({ error }: PreviewErrorBoundaryFallbackProps) {
  return <div role="alert">{error.message}</div>;
}

describe("PreviewErrorBoundary", () => {
  it("keeps provider render errors local to the preview workspace", () => {
    render(
      <PreviewErrorBoundary fallback={ErrorFallback}>
        <ThrowOnRender message="Invalid package.json" />
      </PreviewErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Invalid package.json");
  });

  it("resets after the project input changes so a repair can recover the preview", () => {
    const { rerender } = render(
      <PreviewErrorBoundary resetKey="invalid" fallback={ErrorFallback}>
        <ThrowOnRender message="Invalid package.json" />
      </PreviewErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <PreviewErrorBoundary resetKey="repaired" fallback={ErrorFallback}>
        <p>Preview recovered</p>
      </PreviewErrorBoundary>,
    );

    expect(screen.getByText("Preview recovered")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
