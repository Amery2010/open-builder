import { describe, expect, it } from "vitest";
import type { Conversation } from "../../types";
import {
  computeConversationFingerprint,
  formatConversationBootstrap,
} from "./context";

function conversation(
  overrides: Partial<Conversation> = {},
): Pick<Conversation, "messages" | "files" | "compressedContext" | "template"> {
  return {
    messages: [{ role: "user", content: "Build a dashboard" }],
    files: { "src/App.tsx": "export default function App() {}" },
    compressedContext: undefined,
    template: "vite-react-ts",
    ...overrides,
  };
}

describe("local-agent conversation context", () => {
  it("creates stable fingerprints and invalidates them on authoritative changes", async () => {
    const base = conversation();

    await expect(computeConversationFingerprint(base)).resolves.toBe(
      await computeConversationFingerprint(conversation()),
    );
    await expect(
      computeConversationFingerprint(
        conversation({
          files: {
            "src/App.tsx": "export default function App() { return null }",
          },
        }),
      ),
    ).resolves.not.toBe(await computeConversationFingerprint(base));
    await expect(
      computeConversationFingerprint(
        conversation({
          messages: [...base.messages, { role: "assistant", content: "Done" }],
        }),
      ),
    ).resolves.not.toBe(await computeConversationFingerprint(base));
  });

  it("excludes transient errors and rich model output from the fingerprint", async () => {
    const baseline = conversation();
    const withTransientData = conversation({
      messages: [
        ...baseline.messages,
        {
          role: "tool",
          content: "result",
          toolOutput: {
            text: "result",
            modelOutput: { type: "text", value: "provider-specific" },
          },
        },
        {
          role: "assistant",
          content: "temporary failure",
          isError: true,
          errorKind: "network",
        },
      ],
    });
    const withoutTransientData = conversation({
      messages: [
        ...baseline.messages,
        {
          role: "tool",
          content: "result",
          toolOutput: { text: "result" },
        },
      ],
    });

    await expect(
      computeConversationFingerprint(withTransientData),
    ).resolves.toBe(await computeConversationFingerprint(withoutTransientData));
  });

  it("excludes transient memory-management messages from the fingerprint", async () => {
    const baseline = conversation({
      messages: [{ role: "user", content: "Remember this preference" }],
    });
    const withMemoryTool = conversation({
      messages: [
        ...baseline.messages,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "memory-call",
              type: "function",
              function: {
                name: "manage_memories",
                arguments: '{"operations":[]}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "memory-call",
          content: "Memory updated",
        },
      ],
    });

    await expect(computeConversationFingerprint(withMemoryTool)).resolves.toBe(
      await computeConversationFingerprint(baseline),
    );
  });

  it("excludes UI-only Design Review activity from the fingerprint", async () => {
    const baseline = conversation();
    const withReviewActivity = conversation({
      messages: [
        ...baseline.messages,
        {
          role: "user",
          content: "Automatic Design Review",
          metadata: {
            origin: "design_review",
            reviewJobId: "review-job-1",
            reviewSummary: { status: "succeeded", findingCount: 2 },
          },
        },
      ],
    });

    await expect(
      computeConversationFingerprint(withReviewActivity),
    ).resolves.toBe(await computeConversationFingerprint(baseline));
  });

  it("normalizes a compressed boundary shifted by a UI-only review block", async () => {
    const baseline = conversation({
      messages: [
        { role: "user", content: "Earlier request" },
        { role: "assistant", content: "Earlier response" },
        { role: "user", content: "Recent request" },
      ],
      compressedContext: { summary: "Earlier work", fromIndex: 2 },
    });
    const withReviewActivity = conversation({
      messages: [
        { role: "user", content: "Earlier request" },
        { role: "assistant", content: "Earlier response" },
        {
          role: "user",
          content: "",
          metadata: {
            origin: "design_review",
            reviewJobId: "review-job-1",
            reviewSummary: { status: "succeeded", findingCount: 0 },
          },
        },
        { role: "user", content: "Recent request" },
      ],
      compressedContext: { summary: "Earlier work", fromIndex: 3 },
    });

    await expect(
      computeConversationFingerprint(withReviewActivity),
    ).resolves.toBe(await computeConversationFingerprint(baseline));
  });

  it("uses the canonical compressed continuation boundary", () => {
    const bootstrap = formatConversationBootstrap({
      compressedContext: {
        summary: "Configured token=sk-secret-value",
        fromIndex: 2,
      },
      messages: [
        { role: "user", content: "OLD_SENTINEL_REQUEST" },
        { role: "assistant", content: "OLD_SENTINEL_RESPONSE" },
        { role: "user", content: "Recent request" },
      ],
    });

    expect(bootstrap).toContain("[Previous conversation summary]");
    expect(bootstrap).toContain("Recent request");
    expect(bootstrap).not.toContain("OLD_SENTINEL_REQUEST");
    expect(bootstrap).not.toContain("OLD_SENTINEL_RESPONSE");
    expect(bootstrap).not.toContain("sk-secret-value");
    expect(bootstrap).toContain("[REDACTED]");
  });

  it("bootstraps attachment metadata without exposing inline attachment bytes", () => {
    const secretBytes = "data:image/png;base64,DO_NOT_FORWARD";
    const bootstrap = formatConversationBootstrap({
      compressedContext: { summary: "Earlier project work", fromIndex: 1 },
      messages: [
        { role: "user", content: "Earlier request covered by summary" },
        {
          role: "user",
          content: [
            { type: "text", text: "Match this screenshot" },
            { type: "image_url", image_url: { url: secretBytes } },
            {
              type: "file",
              file: {
                data: "PRIVATE_PDF_BYTES",
                mediaType: "application/pdf",
                filename: "brief.pdf",
              },
            },
          ],
        },
      ],
    });

    expect(bootstrap).toContain("Earlier project work");
    expect(bootstrap).toContain("[Image attachment]");
    expect(bootstrap).toContain("brief.pdf (application/pdf)");
    expect(bootstrap).not.toContain(secretBytes);
    expect(bootstrap).not.toContain("PRIVATE_PDF_BYTES");
  });
});
