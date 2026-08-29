import { describe, expect, it } from "vitest";
import {
  classifyGenerationError,
  formatGenerationErrorMessage,
  getGenerationErrorStatus,
  isRetryableGenerationError,
} from "./generation-error";
import { en } from "../../i18n/en";

describe("generation error helpers", () => {
  it("classifies common recoverable and non-recoverable errors", () => {
    expect(
      classifyGenerationError({ status: 401, message: "nope" }),
    ).toMatchObject({
      kind: "auth",
      retryable: false,
    });
    expect(
      classifyGenerationError(new Error("context_length_exceeded")),
    ).toMatchObject({
      kind: "context_length",
      retryable: true,
    });
    expect(classifyGenerationError(new Error("failed to fetch"))).toMatchObject(
      {
        kind: "network",
        retryable: true,
      },
    );
    expect(
      classifyGenerationError(new Error("Automatic QA failed: bad build")),
    ).toMatchObject({
      kind: "runtime_check",
      retryable: true,
    });
  });

  it("formats user-facing recovery guidance", () => {
    const message = formatGenerationErrorMessage(
      {
        kind: "model",
        message: "rate limited",
        status: 429,
        retryable: true,
      },
      en,
    );

    expect(message).toContain("Model service error");
    expect(message).toContain("HTTP status: 429");
    expect(message).toContain("You can retry");
    expect(message).toContain("`rate limited`");
  });

  it("uses AI SDK statusCode and retry metadata consistently", () => {
    const transient = {
      message: "provider unavailable",
      statusCode: 503,
      isRetryable: true,
    };
    expect(getGenerationErrorStatus(transient)).toBe(503);
    expect(classifyGenerationError(transient)).toMatchObject({
      kind: "model",
      status: 503,
      retryable: true,
    });
    expect(isRetryableGenerationError(transient)).toBe(true);

    const permanent = {
      message: "invalid request",
      statusCode: 400,
      isRetryable: false,
    };
    expect(classifyGenerationError(permanent)).toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(isRetryableGenerationError(permanent)).toBe(false);
  });
});
