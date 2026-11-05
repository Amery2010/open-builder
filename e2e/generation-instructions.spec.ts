import { createServer, type Server, type ServerResponse } from "node:http";
import { expect, test, type Page } from "@playwright/test";

interface ModelHarness {
  url: string;
  requests: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  release: () => void;
  closed: () => boolean;
  stop: () => Promise<void>;
}

async function startModel(): Promise<ModelHarness> {
  const requests: ModelHarness["requests"] = [];
  let firstResponse: ServerResponse | undefined;
  let firstClosed = false;
  function chunk(
    response: ServerResponse,
    delta: unknown,
    finishReason: string | null = null,
  ): void {
    response.write(
      `data: ${JSON.stringify({
        id: "test-completion",
        object: "chat.completion.chunk",
        model: "test",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  }
  const server: Server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "*");
    if (request.method === "OPTIONS") {
      response.end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      firstResponse = response;
      response.once("close", () => {
        firstClosed = true;
      });
      chunk(response, {
        role: "assistant",
        content: "Working on the original task.",
      });
      return;
    }
    chunk(response, { role: "assistant", content: "Updated task finished." });
    chunk(response, {}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No mock model port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    closed: () => firstClosed,
    release() {
      if (!firstResponse || firstResponse.destroyed) return;
      chunk(firstResponse, {
        tool_calls: [
          {
            index: 0,
            id: "read-current-files",
            type: "function",
            function: { name: "list_files", arguments: "{}" },
          },
        ],
      });
      chunk(firstResponse, {}, "tool_calls");
      firstResponse.end("data: [DONE]\n\n");
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function seedProject(page: Page, modelUrl: string): Promise<void> {
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = "/src/store/conversation.ts";
        const { useConversationStore } = await import(url);
        return useConversationStore.getState()._hasHydrated;
      }),
    )
    .toBe(true);
  await page.evaluate(async (apiBaseUrl) => {
    const settingsUrl = "/src/store/settings/index.ts";
    const conversationUrl = "/src/store/conversation.ts";
    const { useSettingsStore } = await import(settingsUrl);
    const { useConversationStore } = await import(conversationUrl);
    useSettingsStore.setState(
      (state: {
        system: Record<string, unknown>;
        ai: Record<string, unknown>;
      }) => ({
        system: {
          ...state.system,
          language: "en",
          theme: "dark",
          autoQaEnabled: false,
        },
        ai: {
          ...state.ai,
          runtime: "api",
          apiType: "openai-compatible",
          apiBaseUrl,
          apiKey: "test-only",
          model: "test",
        },
      }),
    );
    const store = useConversationStore.getState();
    const id = store.activeId ?? store.createConversation();
    store.switchConversation(id);
    const result = store.replaceProject({
      files: {
        "src/App.tsx": "export const App = 1;",
        "src/main.ts": "export const main = 2;",
      },
      template: "vite-react-ts",
      previewMode: "code-only",
      activeFile: "src/App.tsx",
    });
    if (!result.ok) throw new Error(result.error);
    useConversationStore.setState(
      (state: { conversations: Record<string, unknown> }) => ({
        conversations: {
          ...state.conversations,
          [id]: {
            ...useConversationStore.getState().conversations[id],
            title: "Instruction regression",
          },
        },
      }),
    );
  }, modelUrl);
}

test("delivers an update after the current tool without restarting the task", async ({
  page,
}) => {
  const model = await startModel();
  try {
    await seedProject(page, model.url);
    await page
      .getByPlaceholder("Describe the app you want...")
      .fill("Inspect current files, then respond.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => model.requests.length).toBe(1);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await page
      .getByPlaceholder("Add a requirement while the task continues…")
      .fill("Also keep the original layout.");
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("Also keep the original layout.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Task updates" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    expect(model.closed()).toBe(false);
    model.release();
    await expect(
      page.getByText("Updated task finished.", { exact: true }),
    ).toBeVisible();
    expect(model.requests).toHaveLength(2);
    const messages = model.requests[1].messages;
    const updates = messages.filter(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes(
          "Also keep the original layout.",
        ),
    );
    expect(updates).toHaveLength(1);
    const index = messages.indexOf(updates[0]);
    expect(messages[index - 1].role).toBe("tool");
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Also keep the original layout.", { exact: true }),
    ).toHaveCount(1);
  } finally {
    await model.stop();
  }
});

test("stops the transport and keeps unsent updates cancelled across a new task", async ({
  page,
}) => {
  const abortErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (error.name === "AbortError") abortErrors.push(error.message);
  });
  const model = await startModel();
  try {
    await seedProject(page, model.url);
    await page
      .getByPlaceholder("Describe the app you want...")
      .fill("Inspect the files.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => model.requests.length).toBe(1);
    await page
      .getByPlaceholder("Add a requirement while the task continues…")
      .fill("Unsent update for the stopped task.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("Unsent update for the stopped task.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByText("Cancelled · not sent", { exact: true }),
    ).toBeVisible();
    await expect.poll(model.closed).toBe(true);
    expect(model.requests).toHaveLength(1);
    await page
      .getByPlaceholder("Describe the app you want...")
      .fill("Start a fresh task.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("Updated task finished.", { exact: true }),
    ).toBeVisible();
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1].messages)).not.toContain(
      "Unsent update for the stopped task.",
    );
    expect(abortErrors).toEqual([]);
  } finally {
    await model.stop();
  }
});

test("keeps the dark file tree readable when an ancestor uses a light color scheme", async ({
  page,
}) => {
  await seedProject(page, "http://127.0.0.1:1/v1");
  const file = page.getByRole("button", { name: "main.ts", exact: true });
  await expect(file).toBeVisible();
  const colors = await file.evaluate((node) => {
    const wrapper = node.closest<HTMLElement>(".sp-wrapper");
    if (!wrapper) throw new Error("Missing Sandpack wrapper");
    wrapper.style.colorScheme = "light";
    const reference = document.createElement("span");
    reference.style.color = "var(--foreground)";
    wrapper.append(reference);
    const result = {
      actual: getComputedStyle(node).color,
      expected: getComputedStyle(reference).color,
    };
    reference.remove();
    return result;
  });
  expect(colors.actual).toBe(colors.expected);
});
