import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { waitForAppReady } from "./helpers/app-ready";

async function openImport(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page
    .getByRole("button", { name: "Add attachment", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Upload project", exact: true })
    .click();
}

test("imports a verified ZIP into a new conversation and downloads its deployment", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/");
  await waitForAppReady(page);
  const original = await page.evaluate(async () => {
    const settingsPath = "/src/store/settings/index.ts";
    const { useSettingsStore } = await import(settingsPath);
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    const storePath = "/src/store/conversation.ts";
    const { useConversationStore: store } = await import(storePath);
    store.getState().replaceProject({
      files: { "index.html": "<h1>Original project</h1>" },
      template: "static",
      previewMode: "sandpack",
    });
    store
      .getState()
      .setMessages([
        { role: "user", content: "Original conversation history" },
      ]);
    const id = store.getState().activeId!;
    return {
      id,
      conversation: JSON.stringify(store.getState().conversations[id]),
    };
  });
  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );
  const zip = new JSZip();
  zip.file(
    "demo/index.html",
    '<!doctype html><html><body><h1>Imported site</h1><img src="/pixel.gif" alt="Pixel"></body></html>',
  );
  zip.file("demo/public/pixel.gif", gif);
  await openImport(page);
  await page.locator('input[accept*="application/zip"]').setInputFiles({
    name: "demo.zip",
    mimeType: "application/zip",
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
  });
  const importButton = page.getByRole("button", {
    name: "Import project",
    exact: true,
  });
  await expect(importButton).toBeEnabled({ timeout: 120_000 });
  await expect(
    page.getByText("Sandpack compilation verified.", { exact: true }),
  ).toBeVisible();
  await importButton.click();
  await expect(
    page.getByRole("dialog", { name: "Upload Project" }),
  ).toHaveCount(0);
  await expect(
    page
      .frameLocator(".sp-preview-iframe")
      .getByRole("heading", { name: "Imported site" }),
  ).toBeVisible();
  const state = await page.evaluate(async (id) => {
    const storePath = "/src/store/conversation.ts";
    const { useConversationStore: store } = await import(storePath);
    const state = store.getState();
    return {
      id: state.activeId,
      original: JSON.stringify(state.conversations[id]),
      current: state.conversations[state.activeId!],
    };
  }, original.id);
  expect(state.id).not.toBe(original.id);
  expect(state.original).toBe(original.conversation);
  expect(state.current.assets["public/pixel.gif"].mimeType).toBe("image/gif");
  await page.getByRole("button", { name: "Code", exact: true }).last().click();
  await page
    .getByRole("button", { name: "Download project", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Build static deployment ZIP", exact: true })
    .click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Build and download", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("project-deploy.zip");
  const archive = await JSZip.loadAsync(
    await readFile((await download.path())!),
  );
  expect(await archive.file("index.html")!.async("string")).toContain(
    "Imported site",
  );
  expect(await archive.file("pixel.gif")!.async("nodebuffer")).toEqual(gif);
});

test("rejects an unsupported version without adding a conversation", async ({
  page,
}) => {
  await page.goto("/");
  await waitForAppReady(page);
  const count = await page.evaluate(async () => {
    const settingsPath = "/src/store/settings/index.ts";
    const { useSettingsStore } = await import(settingsPath);
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en" },
    }));
    const storePath = "/src/store/conversation.ts";
    const { useConversationStore: store } = await import(storePath);
    return Object.keys(store.getState().conversations).length;
  });
  const zip = new JSZip();
  zip.file("index.html", "<main>Unsupported</main>");
  zip.file(
    "package.json",
    JSON.stringify({
      devDependencies: { vite: "8.2.2" },
      scripts: { dev: "vite" },
    }),
  );
  await openImport(page);
  await page.locator('input[accept*="application/zip"]').setInputFiles({
    name: "unsupported.zip",
    mimeType: "application/zip",
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
  });
  await expect(page.getByRole("alert")).toContainText("Vite 8.2.2");
  await expect(
    page.getByRole("button", { name: "Import project", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(async () => {
      const storePath = "/src/store/conversation.ts";
      const { useConversationStore: store } = await import(storePath);
      return Object.keys(store.getState().conversations).length;
    }),
  ).toBe(count);
});
