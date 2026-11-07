import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

// Nodebox's esbuild onLoad response stalls on a module this size. Keep a real
// module and interactions around the payload so this catches blank previews.
const app = `import { useState } from "react";
export default function App() {
  const [count, setCount] = useState(0);
  return <main><h1>Large React preview</h1><button onClick={() => setCount(count + 1)}>Count {count}</button></main>;
}
/* ${"photography source ".repeat(1500)} */`;

for (const entry of ["index.tsx", "src/main.tsx"]) {
  test(`renders, updates, reloads and captures a large React project (${entry})`, async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAppReady(page);
    await page.evaluate(
      async ({ app, entry }) => {
        const conversationUrl = "/src/store/conversation.ts";
        const { useConversationStore: store } = await import(conversationUrl);
        const settingsUrl = "/src/store/settings/index.ts";
        const { useSettingsStore } = await import(settingsUrl);
        const fsToolsUrl = "/src/lib/tools/fs-tools.ts";
        const { fsInitProject } = await import(fsToolsUrl);
        useSettingsStore.setState(
          (state: { system: Record<string, unknown> }) => ({
            system: { ...state.system, language: "en" },
          }),
        );
        const initialized = await fsInitProject("vite-react-ts");
        if (!initialized.newFiles) throw new Error(initialized.result);
        const files = { ...initialized.newFiles, "App.tsx": app };
        if (entry !== "index.tsx") {
          files[entry] = files["index.tsx"]
            .replace('"./App"', '"../App"')
            .replace('"./styles.css"', '"../styles.css"');
          delete files["index.tsx"];
          files["index.html"] = files["index.html"].replace(
            "/index.tsx",
            `/${entry}`,
          );
        }
        const id = store.getState().createConversation();
        store.getState().switchConversation(id);
        const result = store.getState().replaceProject({
          files,
          template: "vite-react-ts",
          previewMode: "sandpack",
          activeFile: "App.tsx",
        });
        if (!result.ok) throw new Error(result.error);
        store.getState().setWorkspaceMode("design");
      },
      { app, entry },
    );

    const preview = page.frameLocator(".sp-preview-iframe");
    await expect(
      preview.getByRole("heading", { name: "Large React preview" }),
    ).toBeVisible({ timeout: 60_000 });
    await preview.getByRole("button", { name: "Count 0" }).click();
    await expect(
      preview.getByRole("button", { name: "Count 1" }),
    ).toBeVisible();
    await page.evaluate(async () => {
      const conversationUrl = "/src/store/conversation.ts";
      const { useConversationStore: store } = await import(conversationUrl);
      const state = store.getState();
      const files = { ...state.conversations[state.activeId!].files };
      files["App.tsx"] = files["App.tsx"].replace(
        "Large React preview",
        "Edited React preview",
      );
      state.setFiles(files);
    });
    await expect(
      preview.getByRole("heading", { name: "Edited React preview" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Reload preview", exact: true })
      .last()
      .click();
    await expect(
      preview.getByRole("heading", { name: "Edited React preview" }),
    ).toBeVisible({ timeout: 60_000 });

    const result = await page.evaluate(async () => {
      const conversationUrl = "/src/store/conversation.ts";
      const { useConversationStore: store } = await import(conversationUrl);
      const evidenceUrl = "/src/lib/design/preview-evidence.ts";
      const { capturePreviewEvidence } = await import(evidenceUrl);
      const state = store.getState();
      const conversation = state.conversations[state.activeId!];
      const result = await capturePreviewEvidence({
        conversationId: conversation.id,
        files: conversation.files,
        template: conversation.template,
        previewMode: "sandpack",
        viewports: ["desktop", "mobile"],
      });
      return {
        capture: result.structuredContent,
        files: store.getState().conversations[conversation.id].files,
      };
    });
    expect(result.capture).toMatchObject({ status: "complete", errors: [] });
    expect(result.files).not.toHaveProperty("public/index.html");
    expect(result.files).not.toHaveProperty(
      "__open_builder_react_preview__.js",
    );
    expect(JSON.parse(result.files["package.json"])).not.toHaveProperty("main");
    expect(result.files["index.html"]).not.toContain(
      "open-builder-design-bridge",
    );
    expect(result.files["App.tsx"]).toContain("Edited React preview");
    if (entry === "index.tsx") {
      await page.evaluate(async () => {
        const url = "/src/store/conversation.ts";
        const { useConversationStore: store } = await import(url);
        const state = store.getState();
        state.setFiles({
          ...state.conversations[state.activeId!].files,
          "App.tsx": "export default function App(){ return <main> }",
        });
      });
      await expect(page.locator(".sp-error-message").first()).toBeVisible();
      await page.evaluate(async (app) => {
        const url = "/src/store/conversation.ts";
        const { useConversationStore: store } = await import(url);
        const state = store.getState();
        state.setFiles({
          ...state.conversations[state.activeId!].files,
          "App.tsx": app.replace(
            "Large React preview",
            "Recovered React preview",
          ),
        });
      }, app);
      await expect(
        preview.getByRole("heading", { name: "Recovered React preview" }),
      ).toBeVisible();
    }
  });
}
