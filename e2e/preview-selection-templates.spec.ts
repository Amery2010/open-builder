import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

for (const template of [
  "react",
  "react-ts",
  "vue",
  "vue-ts",
  "svelte",
  "solid",
  "angular",
  "vanilla",
  "vanilla-ts",
  "vite-preact",
  "vite-preact-ts",
  "vite-vue",
  "vite-vue-ts",
  "vite-svelte",
  "vite-svelte-ts",
]) {
  test(`selects a real element in the ${template} template without persisting the bridge`, async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAppReady(page);
    const initialFiles = await page.evaluate(async (template) => {
      const conversationUrl = "/src/store/conversation.ts";
      const settingsUrl = "/src/store/settings/index.ts";
      const fsToolsUrl = "/src/lib/tools/fs-tools.ts";
      const { useConversationStore: store } = await import(conversationUrl);
      const { useSettingsStore } = await import(settingsUrl);
      const { fsInitProject } = await import(fsToolsUrl);
      useSettingsStore.setState(
        (state: { system: Record<string, unknown> }) => ({
          system: { ...state.system, language: "en" },
        }),
      );
      const initialized = await fsInitProject(template);
      if (!initialized.newFiles) throw new Error(initialized.result);
      const id = store.getState().createConversation();
      store.getState().switchConversation(id);
      const result = store.getState().replaceProject({
        files: initialized.newFiles,
        template,
        previewMode: "sandpack",
      });
      if (!result.ok) throw new Error(result.error);
      store.getState().setWorkspaceMode("design");
      return initialized.newFiles;
    }, template);

    await expect(page.getByTestId("design-canvas")).toBeVisible();
    await page
      .getByTestId("design-canvas")
      .getByRole("button", { name: "Current page", exact: true })
      .press("Enter");
    const preview = page.frameLocator(".sp-preview-iframe");
    const heading = preview.getByRole("heading").first();
    await expect(heading).toBeVisible({ timeout: 60_000 });
    const label = (await heading.innerText()).trim();
    await page
      .getByRole("button", {
        name: "Select an element in the preview",
        exact: true,
      })
      .click();
    await heading.click();
    await expect(page.getByLabel("Selected preview element")).toContainText(
      label,
    );

    // A reload must install the bridge again, including its nonce handshake.
    await page
      .getByRole("button", { name: "Reload preview", exact: true })
      .last()
      .click();
    await expect(heading).toBeVisible({ timeout: 60_000 });
    await page
      .getByRole("button", {
        name: "Select an element in the preview",
        exact: true,
      })
      .click();
    await heading.click();
    await expect(
      page.getByRole("button", {
        name: "Select an element in the preview",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "false");
    const files = await page.evaluate(async () => {
      const url = "/src/store/conversation.ts";
      const { useConversationStore: store } = await import(url);
      const state = store.getState();
      return state.conversations[state.activeId!].files;
    });
    expect(files).toEqual(initialFiles);
  });
}
