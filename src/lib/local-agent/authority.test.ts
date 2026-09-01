import { tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLocalToolAuthoritySnapshot } from "./authority";

const tools: ToolSet = {
  list_files: tool({
    description: "List files",
    inputSchema: z.object({}),
  }),
  write_file: tool({
    description: "Write a file",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  }),
  screenshot_to_code: tool({
    description: "Must never be exposed to a local CLI",
    inputSchema: z.object({}),
  }),
  mcp_read: tool({
    description: "Read from an approved MCP server",
    inputSchema: z.object({ id: z.string() }),
  }),
};

describe("local Host Tool Authority", () => {
  it("uses one filtered snapshot for visibility and execution", async () => {
    const snapshot = await createLocalToolAuthoritySnapshot({
      tools,
      mode: "chat",
      platform: "desktop",
      allowedMcpAliases: new Set(["mcp_read"]),
      annotations: new Map([
        [
          "mcp_read",
          {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        ],
      ]),
    });

    const visibleNames = snapshot.specs.map((spec) => spec.name);
    expect(visibleNames).toEqual(["list_files", "mcp_read", "write_file"]);
    expect([...snapshot.names]).toEqual(visibleNames);
    expect(snapshot.has("screenshot_to_code")).toBe(false);
    expect(snapshot.has("mcp_read")).toBe(true);
    expect(snapshot.isReadOnly("mcp_read")).toBe(false);
    expect(snapshot.get("mcp_read")?.spec.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true }),
    );
    expect(snapshot.get("mcp_read")?.spec.hostApproval).toBe("session");
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.get("list_files")?.spec.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true }),
    );
    expect(snapshot.get("write_file")?.spec).toEqual(
      expect.objectContaining({ hostApproval: "session" }),
    );
  });

  it("adds attachment access as an explicit read-only capability", async () => {
    const snapshot = await createLocalToolAuthoritySnapshot({
      tools: {},
      mode: "chat",
      platform: "desktop",
      extraSpecs: [
        {
          name: "read_attachment",
          description: "Read an attachment",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(snapshot.specs).toEqual([
      expect.objectContaining({
        name: "read_attachment",
        annotations: expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
        }),
        hostApproval: "none",
      }),
    ]);
    expect(snapshot.isReadOnly("read_attachment")).toBe(true);
  });

  it("does not expose dynamic tools without this run's MCP allowlist", async () => {
    const snapshot = await createLocalToolAuthoritySnapshot({
      tools: { mcp_read: tools.mcp_read },
      mode: "chat",
      platform: "desktop",
    });

    expect(snapshot.specs).toEqual([]);
    expect(snapshot.names).not.toContain("mcp_read");
  });
});
