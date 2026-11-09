import { redactSecrets } from "@open-builder/core";
import { ProjectError } from "./project-service.js";

export interface OperationResult {
  operation: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface OperationOutcome {
  result: OperationResult;
  exitCode: number;
  isError: boolean;
}

export async function executeOperation(
  operation: string,
  action: () => unknown | Promise<unknown>,
): Promise<OperationOutcome> {
  try {
    const data = await action();
    let exitCode = 0;
    if (
      operation === "check" &&
      !(data as { report: { ok: boolean } }).report.ok
    )
      exitCode = 1;
    if (operation === "verify") {
      const status = (data as { status: string }).status;
      if (status === "cancelled") exitCode = 130;
      else if (status === "timed-out") exitCode = 124;
      else if (status !== "passed") exitCode = 1;
    }
    return {
      result: { operation, ok: exitCode === 0, data },
      exitCode,
      isError: false,
    };
  } catch (error) {
    const known = error instanceof ProjectError;
    return {
      result: {
        operation,
        ok: false,
        error: {
          code: known ? error.code : "OPERATION_FAILED",
          message: redactSecrets(
            error instanceof Error ? error.message : "Operation failed.",
            { diagnosticForms: true },
          ),
        },
      },
      exitCode: known ? error.exitCode : 1,
      isError: true,
    };
  }
}
