import { describe, expect, it } from "vitest";
import {
  classifyGenerationError,
  formatGenerationErrorMessage,
  getGenerationErrorStatus,
  isRetryableGenerationError,
} from "./generation-error";
import { en } from "../../i18n/en";
import { zh } from "../../i18n/zh";
import { LocalCliRuntimeError } from "../local-agent/runtime";

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

  it("maps typed local CLI failures without parsing provider prose", () => {
    const error = new LocalCliRuntimeError({
      code: "credentialRejected",
      phase: "handshake",
      provider: "claude",
      safeMessage: "The local CLI rejected its configured credentials.",
      diagnosticId: "diag-1",
      hadActivity: false,
      hadHostSideEffect: false,
      retryPolicy: "afterSetup",
    });

    expect(classifyGenerationError(error)).toMatchObject({
      kind: "auth",
      retryable: false,
      message: "The local CLI rejected its configured credentials.",
    });
  });

  it("maps cancelled local runs to the non-retryable aborted kind", () => {
    const error = new LocalCliRuntimeError({
      code: "cancelled",
      phase: "shutdown",
      provider: "pi",
      safeMessage: "The local CLI run was cancelled.",
      diagnosticId: "diag-2",
      hadActivity: true,
      hadHostSideEffect: false,
      retryPolicy: "none",
    });

    expect(classifyGenerationError(error)).toMatchObject({
      kind: "aborted",
      retryable: false,
    });
  });

  it.each([en, zh])(
    "distinguishes trusted rate-limit and interrupted-run summaries without exposing provider text",
    (translations) => {
      const format = (safeMessage: string) =>
        formatGenerationErrorMessage(
          classifyGenerationError(
            new LocalCliRuntimeError({
              code: "processExit",
              phase: "stream",
              provider: "codex",
              safeMessage,
              diagnosticId: "diag-process-exit",
              hadActivity: true,
              hadHostSideEffect: true,
              retryPolicy: "manual",
            }),
          ),
          translations,
        );
      const quota = format(
        "The local CLI provider rate limit prevented this request from completing.",
      );
      const interrupted = format(
        "The local CLI stopped before completing the request. Your changes have been kept. Retry to continue.",
      );

      expect(quota).not.toEqual(interrupted);
      expect(quota).toContain(
        translations.message.generationError.localCli.failureDetails
          .rateLimited,
      );
      expect(interrupted).toContain(
        translations.message.generationError.localCli.failureDetails
          .unexpectedStop,
      );
      const unknown = format("private provider diagnostic sentinel");
      expect(unknown).toContain(
        translations.message.generationError.localCli.failureCodes.processExit,
      );
      expect(unknown).not.toContain("private provider diagnostic sentinel");
    },
  );

  it("keeps local runtime diagnostics out of the network category", () => {
    const error = new LocalCliRuntimeError({
      code: "providerApprovalRejected",
      phase: "tool",
      provider: "codex",
      safeMessage: "The local CLI cannot invoke the approved Host tool.",
      diagnosticId: "diag-approval",
      hadActivity: true,
      hadHostSideEffect: false,
      retryPolicy: "none",
    });

    const classified = classifyGenerationError(error);
    expect(classified).toMatchObject({
      kind: "tool",
      retryable: false,
      localCliFailure: {
        code: "providerApprovalRejected",
        provider: "codex",
        phase: "tool",
        diagnosticId: "diag-approval",
      },
    });
    expect(classified.kind).not.toBe("network");
    const message = formatGenerationErrorMessage(classified, en);
    expect(message).toContain("Provider:** Codex");
    expect(message).toContain("Phase:** Host tool");
    expect(message).toContain("Retry policy:** Do not retry automatically");
    expect(message).toContain("Diagnostic ID:** `diag-approval`");
    expect(message).toContain(
      "The headless CLI rejected a Host tool at its provider approval layer.",
    );
    expect(message).not.toContain(
      "The local CLI cannot invoke the approved Host tool.",
    );
    expect(message).not.toContain("stderr");

    const chineseMessage = formatGenerationErrorMessage(classified, zh);
    expect(chineseMessage).toContain(
      "无界面的 CLI 在服务商授权层拒绝了 Host 工具。",
    );
    expect(chineseMessage).not.toContain(
      "The local CLI cannot invoke the approved Host tool.",
    );
  });

  it("rejects malformed local CLI failure objects at the UI boundary", () => {
    const classified = classifyGenerationError({
      message: "opaque failure",
      failure: {
        code: "futureFailure",
        phase: "tool",
        provider: "codex",
        safeMessage: "must not be trusted",
        diagnosticId: "diag-malformed",
        hadActivity: "yes",
        hadHostSideEffect: false,
        retryPolicy: "automatic",
      },
    });

    expect(classified.kind).toBe("unknown");
    expect(classified.localCliFailure).toBeUndefined();
  });

  it("redacts bearer and whitespace-delimited API credentials", () => {
    const bearer = "bearer-secret-sentinel";
    const apiKey = "api-key-secret-sentinel";
    const classified = classifyGenerationError({
      message: "local failure",
      failure: {
        code: "credentialRejected",
        phase: "handshake",
        provider: "claude",
        safeMessage: `Authorization: Bearer ${bearer}; API key ${apiKey}`,
        diagnosticId: "diag-redaction",
        hadActivity: false,
        hadHostSideEffect: false,
        retryPolicy: "afterSetup",
      },
    });

    expect(classified.message).not.toContain(bearer);
    expect(classified.message).not.toContain(apiKey);
    expect(classified.message).toContain("[redacted]");
  });
});
