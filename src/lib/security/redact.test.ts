import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets", () => {
  it.each([
    [
      "PEM private-key blocks",
      "-----BEGIN RSA PRIVATE KEY-----\nsentinel-1\n-----END RSA PRIVATE KEY-----",
      "sentinel-1",
    ],
    ["bearer values", "Authorization: Bearer sentinel-2", "sentinel-2"],
    ["query parameters", "https://x.example/?api_key=sentinel-3", "sentinel-3"],
    ["key/value pairs", "token = 'sentinel-4'", "sentinel-4"],
    ["ENV assignments", "OPENAI_API_KEY=sentinel-5", "sentinel-5"],
  ])("redacts %s", (_label, input, secret) => {
    const output = redactSecrets(input);
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
  });

  it("keeps the scheme word so audit text stays readable", () => {
    expect(redactSecrets("Authorization: Bearer sentinel-6")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("keeps prose that merely mentions credential words", () => {
    const prose = "GPT 5.6 Sol token efficient; secret sauce";
    expect(redactSecrets(prose)).toBe(prose);
    expect(redactSecrets(prose, { diagnosticForms: true })).toBe(prose);
  });

  it("redacts CLI flags and credential phrases only for diagnostics", () => {
    const command = "codex login --token sentinel-7";
    expect(redactSecrets(command)).toBe(command);
    expect(redactSecrets(command, { diagnosticForms: true })).toBe(
      "codex login --token [REDACTED]",
    );
    expect(
      redactSecrets("API key sentinel-8", {
        diagnosticForms: true,
        placeholder: "[redacted]",
      }),
    ).toBe("API key [redacted]");
  });

  it("applies the length cap after redaction", () => {
    const output = redactSecrets("Authorization: Bearer sentinel-9", {
      maxLength: 25,
    });
    expect(output).toHaveLength(25);
    expect(output).not.toContain("sentinel-9");
  });
});
