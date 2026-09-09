import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const pending = new Map();

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "notifications/cancelled") {
    const requestId = message.params?.requestId;
    const timer = pending.get(requestId);
    if (timer) clearTimeout(timer);
    pending.delete(requestId);
    return;
  }
  if (message.id == null) return;

  if (message.method === "server/discover") {
    respond(message.id, {
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: { listChanged: false } },
      instructions: "Echo fixture instructions",
      ttlMs: 0,
      cacheScope: "private",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "open-builder-echo-fixture",
          version: "1.0.0",
        },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    respond(message.id, {
      resultType: "complete",
      tools: [
        {
          name: "echo",
          description: "Echo a message",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
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
    const text = String(message.params?.arguments?.message ?? "");
    const delayMs = Number(message.params?.arguments?.delayMs ?? 0);
    const finish = () => {
      pending.delete(message.id);
      respond(message.id, {
        resultType: "complete",
        content: [{ type: "text", text }],
        structuredContent: {
          echoed: text,
          canary: process.env.OPEN_BUILDER_ENV_CANARY ?? null,
          configured: process.env.OPEN_BUILDER_ENV_CONFIGURED ?? null,
        },
        isError: false,
      });
    };
    if (delayMs > 0) {
      pending.set(message.id, setTimeout(finish, delayMs));
    } else {
      finish();
    }
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    })}\n`,
  );
});
