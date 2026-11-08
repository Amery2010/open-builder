import { expect, test, type Download, type Page } from "@playwright/test";
import JSZip from "jszip";
import { waitForAppReady } from "./helpers/app-ready";

async function readZip(download: Download) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSZip.loadAsync(Buffer.concat(chunks));
}

async function seedProject(page: Page) {
  await page.goto("/");
  await waitForAppReady(page);
  return page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const settingsUrl = "/src/store/settings/index.ts";
    const snapshotUrl = "/src/store/snapshot.ts";
    const archivesUrl = "/src/lib/project-archives/service.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { useSettingsStore } = await import(settingsUrl);
    const { useSnapshotStore } = await import(snapshotUrl);
    const { ensureSnapshotArchive } = await import(archivesUrl);
    useSettingsStore.setState((state: { system: object }) => ({
      system: { ...state.system, language: "en" },
    }));
    const store = useConversationStore.getState();
    const id = store.activeId!;
    store.renameConversation(id, "Download fixture");
    store.replaceProject({
      files: { "index.html": "<h1>Current version</h1>" },
      template: "static",
      previewMode: "code-only",
      activeFile: "index.html",
    });
    store.setMessages([
      { role: "user", content: "Build a website" },
      { role: "assistant", content: "Historical website versions" },
    ]);
    const message =
      useConversationStore.getState().conversations[id].messages[1];
    const records = [];
    for (const version of [1, 2]) {
      const snapshot = useSnapshotStore
        .getState()
        .createSnapshot(id, `assistant-${message.id}`, {
          "index.html": `<h1>Historical version ${version}</h1>`,
        });
      const record = await ensureSnapshotArchive(id, snapshot.id);
      records.push({ id: snapshot.id, fileName: record.fileName });
    }
    return records;
  });
}

test("builds without downloading and saves a named deployment ZIP only on click", async ({
  page,
}) => {
  await seedProject(page);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
  });
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  await page
    .getByRole("button", { name: "Download project", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Build static deployment ZIP" })
    .click();
  await page.getByRole("button", { name: "Start build" }).click();
  const save = page.getByRole("button", { name: "Download deployment ZIP" });
  await expect(save).toBeEnabled();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The deployment ZIP is ready." }),
  ).toBeVisible();
  expect(downloads).toHaveLength(0);
  const downloadEvent = page.waitForEvent("download");
  await save.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^website\d+\.zip$/);
  expect(
    await (await readZip(download)).file("index.html")!.async("string"),
  ).toBe("<h1>Current version</h1>");
});

test("selects historical versions with the mouse for source and deployment, preserving picker activation", async ({
  page,
}) => {
  const records = await seedProject(page);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Download source", exact: true })
    .hover();
  const sourceDownload = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: records[0].fileName, exact: true })
    .click();
  const source = await sourceDownload;
  expect(
    await (await readZip(source)).file("index.html")!.async("string"),
  ).toBe("<h1>Historical version 1</h1>");

  await page.evaluate(() => {
    const state = {
      calls: 0,
      active: false,
      filename: "",
      bytes: [] as number[],
    };
    Object.assign(window, { downloadPickerEvidence: state });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: (options: { suggestedName: string }) => {
        state.calls++;
        state.active = navigator.userActivation.isActive;
        state.filename = options.suggestedName;
        return Promise.resolve({
          createWritable: async () => ({
            write: async (blob: Blob) => {
              state.bytes = Array.from(
                new Uint8Array(await blob.arrayBuffer()),
              );
            },
            close: async () => {},
            abort: async () => {},
          }),
        });
      },
    });
  });
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Build static deployment ZIP", exact: true })
    .hover();
  await page
    .getByRole("menuitem", { name: records[1].fileName, exact: true })
    .click();
  await page.getByRole("button", { name: "Start build" }).click();
  const save = page.getByRole("button", { name: "Download deployment ZIP" });
  await expect(save).toBeEnabled();
  const evidence = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            downloadPickerEvidence: {
              calls: number;
              active: boolean;
              filename: string;
              bytes: number[];
            };
          }
        ).downloadPickerEvidence,
    );
  expect((await evidence()).calls).toBe(0);
  await save.click();
  await expect
    .poll(async () => (await evidence()).bytes.length)
    .toBeGreaterThan(0);
  const saved = await evidence();
  expect(saved.active).toBe(true);
  expect(saved.calls).toBe(1);
  expect(saved.filename).toMatch(/^website\d+\.zip$/);
  const zip = await JSZip.loadAsync(new Uint8Array(saved.bytes));
  expect(await zip.file("index.html")!.async("string")).toBe(
    "<h1>Historical version 2</h1>",
  );
});
