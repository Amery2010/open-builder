import { describe, expect, it } from "vitest";
import { redactStorageExport } from "./export-redaction";

describe("storage export redaction", () => {
  it("never exposes settings or MCP credential values", () => {
    const sentinel = "storage-export-secret";
    const exported = redactStorageExport({
      apiKey: sentinel,
      agnes: { apiKey: sentinel, enabled: true },
      url: `https://example.com/v1?token=${sentinel}`,
      headers: { Authorization: `Bearer ${sentinel}` },
      oauth: { accessToken: sentinel, clientSecret: sentinel },
      files: { ".env": `TOKEN=${sentinel}`, "src/App.tsx": "visible" },
      safe: "visible",
    });
    const text = JSON.stringify(exported);

    expect(text).not.toContain(sentinel);
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("visible");
    expect(text).not.toContain("TOKEN=");
  });
});
