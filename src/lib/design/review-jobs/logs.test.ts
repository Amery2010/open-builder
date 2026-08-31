import { describe, expect, it } from "vitest";
import { en } from "../../../i18n/en";
import { zh } from "../../../i18n/zh";
import {
  createDesignReviewLogEntry,
  formatDesignReviewLogEntry,
  sanitizeDesignReviewLogText,
} from "./logs";

describe("Design Review logs", () => {
  it("redacts credentials and removes control characters", () => {
    const output = sanitizeDesignReviewLogText(
      "failed\nAuthorization: Bearer secret-token api_key=sk-example123456789",
    );
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("sk-example");
    expect(output).not.toContain("\n");
    expect(output).toContain("[redacted]");
  });

  it("formats persisted events with the active locale", () => {
    const runtime = createDesignReviewLogEntry(
      "runtime_started",
      "Isolated local review runtime started.",
    );
    const tool = createDesignReviewLogEntry(
      "tool_call",
      "read_files invoked (2).",
      { level: "info", toolName: "read_files", count: 2 },
    );

    expect(formatDesignReviewLogEntry(runtime, en, "local")).toBe(
      "Isolated Local CLI review runtime started.",
    );
    expect(formatDesignReviewLogEntry(runtime, zh, "local")).toBe(
      "独立的 本地 CLI 审查运行时已启动。",
    );
    expect(formatDesignReviewLogEntry(tool, zh)).toBe(
      "已调用 read_files（第 2 次）。",
    );
  });
});
