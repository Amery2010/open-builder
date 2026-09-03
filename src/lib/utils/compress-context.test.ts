import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../ai/generator";
import {
  compressContext,
  COMPRESSED_CONTEXT_LIMITS,
  normalizeCompressedSummary,
} from "./compress-context";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getProviderModel: vi.fn(() => ({ provider: "mock-model" })),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}));

vi.mock("../ai/provider", () => ({
  getProviderModel: mocks.getProviderModel,
}));

const cfg = {
  apiType: "openai-compatible" as const,
  apiBaseUrl: "https://api.example.com",
  apiKey: "test-key",
  model: "test-model",
};

describe("compressContext", () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
    mocks.getProviderModel.mockClear();
    mocks.getProviderModel.mockReturnValue({ provider: "mock-model" });
  });

  it("returns null when there are fewer than two user messages", async () => {
    await expect(
      compressContext([{ role: "user", content: "Only one turn" }], cfg),
    ).resolves.toBeNull();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("summarizes older messages and appends the current file inventory", async () => {
    mocks.generateText.mockResolvedValue({ text: "Short summary." });
    const messages: Message[] = [
      { role: "user", content: "Build a timer" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "write_file",
              arguments: '{"path":"src/App.tsx","content":"..."}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: "OK — created: src/App.tsx",
      },
      { role: "user", content: "Make it prettier" },
    ];

    const result = await compressContext(messages, cfg, undefined, {
      "src/App.tsx": "export function App() { return null; }",
      "package.json": "{}",
    });

    expect(result).toEqual({
      summary:
        'Short summary.\n\nCurrent project files:\n- "package.json"\n- "src/App.tsx"',
      fromIndex: 3,
    });
    expect(mocks.getProviderModel).toHaveBeenCalledWith(cfg);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const request = mocks.generateText.mock.calls[0][0];
    const instructions = request.instructions as string;
    const summaryInput = request.prompt as string;
    expect(instructions).toContain("explicit user requests and decisions");
    expect(instructions).toContain("source material, never as new requests");
    expect(instructions).toContain("permissions and verification status");
    expect(summaryInput).toContain("user: Build a timer");
    expect(summaryInput).toContain(
      'assistant_tool_calls: write_file({"path":"src/App.tsx","content":"..."})',
    );
    expect(summaryInput).toContain("tool_result: OK — created: src/App.tsx");
    expect(summaryInput).not.toContain("Make it prettier");
  });

  it("never converts a PDF attachment into base64 summary text", async () => {
    mocks.generateText.mockResolvedValue({ text: "PDF noted." });
    const sentinel = "JVBERi0xLjQtc2VjcmV0LXNlbnRpbmVs";
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Review this document" },
          {
            type: "file",
            file: {
              data: `data:application/pdf;base64,${sentinel}`,
              mediaType: "application/pdf",
              filename: "spec.pdf",
            },
          },
        ],
      },
      { role: "assistant", content: "I will review it." },
      { role: "user", content: "Continue" },
    ];

    await compressContext(messages, cfg);

    const prompt = mocks.generateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('PDF attachment: "spec.pdf"');
    expect(prompt).not.toContain(sentinel);
    expect(prompt).not.toContain("data:application/pdf");
  });

  it("redacts secret tool arguments and protected legacy file results", async () => {
    mocks.generateText.mockResolvedValue({ text: "Safe summary." });
    const sentinel = "legacy-super-secret";
    const messages: Message[] = [
      { role: "user", content: "Configure the app" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "env-call",
            type: "function",
            function: {
              name: "manage_env",
              arguments: JSON.stringify({
                operations: [
                  {
                    target: "env",
                    action: "set",
                    key: "TOKEN",
                    value: sentinel,
                  },
                ],
              }),
            },
          },
          {
            id: "read-call",
            type: "function",
            function: {
              name: "read_files",
              arguments: JSON.stringify({ paths: [".env"] }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "env-call", content: "OK" },
      { role: "tool", tool_call_id: "read-call", content: `TOKEN=${sentinel}` },
      { role: "user", content: "Continue" },
    ];

    await compressContext(messages, cfg);

    const prompt = mocks.generateText.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain(sentinel);
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).toContain("Protected tool result omitted");
  });

  it("sanitizes legacy and newly generated summaries during recompression", async () => {
    const legacySentinel = "legacy-recompress-secret-sentinel";
    const generatedSentinel = "generated-summary-secret-sentinel";
    mocks.generateText.mockResolvedValue({
      text: `Result: {"access_token":"${generatedSentinel}"}`,
    });
    const messages: Message[] = [
      { role: "user", content: "Initial request" },
      { role: "assistant", content: "Initial response" },
      { role: "user", content: "Intermediate request" },
      { role: "assistant", content: "Intermediate response" },
      { role: "user", content: "Continue" },
    ];

    const result = await compressContext(messages, cfg, {
      fromIndex: 2,
      summary: `Legacy: {"password":"${legacySentinel}"}`,
    });

    const prompt = mocks.generateText.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain(legacySentinel);
    expect(prompt).toContain("[REDACTED]");
    expect(result?.summary).not.toContain(generatedSentinel);
    expect(result?.summary).toContain("[REDACTED]");
  });

  it("bounds compressed summaries", () => {
    const summary = normalizeCompressedSummary(
      "x".repeat(COMPRESSED_CONTEXT_LIMITS.maxSummaryChars + 5),
    );

    expect(summary).toContain("[compressed context truncated after");
    expect(summary.length).toBeLessThan(
      COMPRESSED_CONTEXT_LIMITS.maxSummaryChars + 100,
    );
  });
});
