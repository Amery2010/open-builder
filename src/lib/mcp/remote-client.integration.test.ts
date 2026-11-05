import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createServer, type Server } from "node:http";
import { createMcpServerEntry } from "./validation";
import { RemoteMcpClient } from "./remote-client";

describe("RemoteMcpClient timeout waiting with the real SDK", () => {
  const clients: RemoteMcpClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    vi.useRealTimers();
  });

  async function fixture() {
    let calls = 0;
    let finish!: (result: unknown, error?: boolean) => void;
    const entry = createMcpServerEntry(
      {
        name: "Memory fixture",
        transport: "streamable-http",
        url: "https://mcp.example.test/rpc",
        requestTimeoutMs: 1_000,
      },
      { id: "memory" },
    );
    const client = new RemoteMcpClient(entry, {
      fetch: async (_url, init) => {
        if (init?.method !== "POST") return new Response(null, { status: 405 });
        const message = JSON.parse(String(init.body));
        const reply = (result: unknown, error = false) =>
          Response.json({
            jsonrpc: "2.0",
            id: message.id,
            [error ? "error" : "result"]: result,
          });
        if (message.method === "server/discover")
          return reply({
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: { listChanged: false } },
            ttlMs: 0,
            cacheScope: "private",
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "memory",
                version: "1",
              },
            },
          });
        if (message.method === "tools/list")
          return reply({
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [
              {
                name: "write_note",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: false, idempotentHint: false },
              },
            ],
          });
        if (message.method === "tools/call") {
          calls += 1;
          return new Promise<Response>((resolve) => {
            finish = (result, error = false) => resolve(reply(result, error));
          });
        }
        return new Response(null, { status: 202 });
      },
    });
    clients.push(client);
    await client.connect();
    return {
      client,
      calls: () => calls,
      finish: (result: unknown, error?: boolean) => finish(result, error),
    };
  }

  it("accepts a second-window result without resending a write tool", async () => {
    vi.useFakeTimers();
    const server = await fixture();
    const settled = vi.fn();
    const pending = server.client.callTool("write_note", {}).then(
      (result) => settled({ result }),
      (error) => settled({ error }),
    );
    await vi.waitFor(() => expect(server.calls()).toBe(1));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).not.toHaveBeenCalled();
    server.finish({
      resultType: "complete",
      content: [{ type: "text", text: "saved once" }],
    });
    await pending;
    expect(settled).toHaveBeenCalledWith({
      result: expect.objectContaining({
        content: [{ type: "text", text: "saved once" }],
      }),
    });
    expect(server.calls()).toBe(1);
  });

  it("fails only after three timeout windows while sending once", async () => {
    vi.useFakeTimers();
    const server = await fixture();
    const settled = vi.fn();
    const pending = server.client.callTool("write_note", {}).then(
      (result) => settled({ result }),
      (error) => settled({ error }),
    );
    await vi.waitFor(() => expect(server.calls()).toBe(1));
    await vi.advanceTimersByTimeAsync(2_800);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(settled).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message: expect.stringMatching(/timed out|timeout/i),
      }),
    });
    expect(server.calls()).toBe(1);
  });

  it("honors Stop immediately during the second waiting window", async () => {
    vi.useFakeTimers();
    const server = await fixture();
    const controller = new AbortController();
    const settled = vi.fn();
    const pending = server.client
      .callTool("write_note", {}, controller.signal)
      .then(
        (result) => settled({ result }),
        (error) => settled({ error }),
      );
    await vi.waitFor(() => expect(server.calls()).toBe(1));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).not.toHaveBeenCalled();
    controller.abort(new DOMException("Stopped", "AbortError"));
    await pending;
    expect(settled).toHaveBeenCalledWith({
      error: expect.objectContaining({ name: "AbortError" }),
    });
    expect(server.calls()).toBe(1);
  });

  it("reports a server rejection without waiting or retrying", async () => {
    vi.useFakeTimers();
    const server = await fixture();
    const settled = vi.fn();
    const pending = server.client.callTool("write_note", {}).then(
      (result) => settled({ result }),
      (error) => settled({ error }),
    );
    await vi.waitFor(() => expect(server.calls()).toBe(1));
    server.finish({ code: -32602, message: "invalid input" }, true);
    await pending;
    expect(settled).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message: expect.stringContaining("invalid input"),
      }),
    });
    expect(server.calls()).toBe(1);
  });
});

describe("RemoteMcpClient with Streamable HTTP", () => {
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const send = (result: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
          );
        };
        if (message.method === "server/discover") {
          send({
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: { listChanged: false } },
            instructions: "Local remote fixture",
            ttlMs: 0,
            cacheScope: "private",
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "remote-fixture",
                version: "1.0.0",
              },
            },
          });
          return;
        }
        if (message.method === "tools/list") {
          send({
            resultType: "complete",
            tools: [
              {
                name: "echo",
                description: "Echo text",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                },
                annotations: { readOnlyHint: true },
              },
            ],
            ttlMs: 0,
            cacheScope: "private",
          });
          return;
        }
        if (message.method === "tools/call") {
          const text = String(message.params?.arguments?.text ?? "");
          send({
            resultType: "complete",
            content: [{ type: "text", text }],
            structuredContent: { echoed: text },
            isError: false,
          });
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Remote MCP fixture did not bind a TCP port.");
    }
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("negotiates 2026-07-28, lists tools, calls a tool, and disconnects", async () => {
    const entry = createMcpServerEntry(
      {
        name: "Fixture",
        transport: "streamable-http",
        url: endpoint,
      },
      { id: "fixture" },
    );
    const client = new RemoteMcpClient(entry);
    const discovery = await client.connect();
    expect(discovery.instructions).toBe("Local remote fixture");
    expect(discovery.tools).toHaveLength(1);
    expect(discovery.tools[0]).toMatchObject({
      name: "echo",
      annotations: { readOnlyHint: true },
    });
    const result = await client.callTool("echo", { text: "hello" });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { echoed: "hello" },
    });
    await client.close();
  });
});
