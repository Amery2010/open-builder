import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

test("reopens history with null tool arguments and continues rendering messages", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://history-recovery.invalid/**", (route) =>
    route.fulfill({
      status: 503,
      body: "No live model calls in this history test",
    }),
  );
  await page.goto("/");
  await waitForAppReady(page);
  const history = await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const settingsUrl = "/src/store/settings/index.ts";
    const { useConversationStore: store, flushConversationPersistence } =
      await import(conversationUrl);
    const { useSettingsStore } = await import(settingsUrl);
    useSettingsStore.setState(
      (state: {
        system: Record<string, unknown>;
        ai: Record<string, unknown>;
      }) => ({
        system: { ...state.system, language: "en", autoQaEnabled: false },
        ai: {
          ...state.ai,
          runtime: "api",
          apiType: "openai-compatible",
          apiBaseUrl: "https://history-recovery.invalid/v1",
          apiKey: "test-only",
          model: "test",
        },
      }),
    );
    const id = store.getState().createConversation();
    store.getState().switchConversation(id);
    const result = store.getState().replaceProject({
      files: { "README.md": "History recovery fixture" },
      template: "static",
      previewMode: "code-only",
      activeFile: "README.md",
    });
    if (!result.ok) throw new Error(result.error);
    const messages = [
      { id: "history-user", role: "user", content: "History recovery request" },
      {
        id: "history-assistant",
        role: "assistant",
        content: "Checking previous work",
        tool_calls: [
          {
            id: "null-args",
            type: "function",
            function: { name: "project_health_check", arguments: "null" },
          },
        ],
      },
      {
        id: "history-tool-result",
        role: "tool",
        tool_call_id: "null-args",
        content: "Error: failed to parse arguments",
      },
    ];
    store.getState().setMessages(messages);
    await flushConversationPersistence();
    return messages;
  });
  await expect(
    page.getByText("History recovery request", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await waitForAppReady(page);
  await expect(
    page.getByText("History recovery request", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Check Project Health/i }).click();
  await expect(
    page.getByText("Error: failed to parse arguments", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByPlaceholder("Describe the app you want..."),
  ).toBeEditable();
  const before = await page.evaluate(async () => {
    const url = "/src/store/conversation.ts";
    const { useConversationStore: store } = await import(url);
    const state = store.getState();
    const history = state.conversations[state.activeId!].messages;
    state.setMessages([
      ...history,
      { role: "user", content: "Continue after recovery" },
      { role: "assistant", content: "Continuation displayed" },
    ]);
    return history;
  });
  expect(before).toEqual(history);
  await expect(
    page.getByText("Continuation displayed", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
