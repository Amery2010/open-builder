import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { waitForAppReady } from "./helpers/app-ready";

// Use the installed browser for the same browser checks in local development.
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL });

test("restores both branches and downloads immutable OPFS project versions", async ({
  page,
}) => {
  await page.goto("/");
  await waitForAppReady(page);
  const fixture = await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const snapshotUrl = "/src/store/snapshot.ts";
    const settingsUrl = "/src/store/settings/index.ts";
    const assetsUrl = "/src/lib/project-assets/core.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { useSnapshotStore } = await import(snapshotUrl);
    const { useSettingsStore } = await import(settingsUrl);
    const assets = await import(assetsUrl);
    useSettingsStore.setState((state: { system: Record<string, unknown> }) => ({
      system: { ...state.system, language: "en" },
    }));
    const id = useConversationStore.getState().createConversation();
    const store = useConversationStore.getState();
    store.renameConversation(id, "Branch package test");
    store.replaceProject({
      files: {
        "index.html": "B",
        "src/nested/中文.txt": "checkpoint B",
        "package.json": "{}",
      },
      template: "static",
      previewMode: "code-only",
    });
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const staged = await assets.stageProjectAsset(
      "public/logo.png",
      new Blob([bytes], { type: "image/png" }),
    );
    const asset = assets.createProjectAssetRecord(
      staged,
      await assets.storeStagedProjectAsset(staged),
    );
    store.setAssetsForConversation(id, { "public/logo.png": asset });
    store.setMessages([
      { role: "user", content: "Build B" },
      { role: "assistant", content: "Built checkpoint B" },
    ]);
    const bState = useConversationStore.getState().conversations[id];
    const b = useSnapshotStore
      .getState()
      .createSnapshot(
        id,
        `assistant-${bState.messages[1].id}`,
        bState.files,
        bState.assets,
      );
    store.setMessages((previous: object[]) => [
      ...previous,
      { role: "user", content: "Build C" },
      { role: "assistant", content: "Built checkpoint C" },
    ]);
    store.setFiles((previous: Record<string, string>) => ({
      ...previous,
      "index.html": "C",
    }));
    const cState = useConversationStore.getState().conversations[id];
    const main = cState.activeBranchId;
    const c = useSnapshotStore
      .getState()
      .createSnapshot(
        id,
        `assistant-${cState.messages[3].id}`,
        cState.files,
        cState.assets,
      );
    store.checkoutSnapshot(id, b.id);
    store.ensureWritableBranch(id);
    store.setMessages((previous: object[]) => [
      ...previous,
      { role: "user", content: "Build D" },
      { role: "assistant", content: "Built checkpoint D" },
    ]);
    store.setFiles((previous: Record<string, string>) => ({
      ...previous,
      "index.html": "D",
      "only-d.txt": "branch D",
    }));
    const dState = useConversationStore.getState().conversations[id];
    const d = useSnapshotStore
      .getState()
      .createSnapshot(
        id,
        `assistant-${dState.messages[3].id}`,
        dState.files,
        dState.assets,
      );
    return {
      id,
      main,
      child: dState.activeBranchId,
      b: b.id,
      c: c.id,
      d: d.id,
      bytes: Array.from(bytes),
    };
  });
  await expect(
    page.getByText("Built checkpoint D", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "2 branches", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Conversation branches" }),
  ).toBeVisible();
  await expect(dialog.getByText("Build C", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Build D", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "Switch branch", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    page.getByText("Built checkpoint C", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Built checkpoint D", { exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const url = "/src/store/conversation.ts";
        return (await import(url)).useConversationStore.getState()
          .conversations[id].files["index.html"];
      }, fixture.id),
    )
    .toBe("C");

  await expect(
    page
      .getByRole("button", { name: "Download project ZIP", exact: true })
      .last(),
  ).toBeEnabled();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download project ZIP", exact: true })
    .last()
    .click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^Branch package test-.+\.zip$/);
  expect(download.suggestedFilename()).not.toContain("Unknown");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  expect(await zip.file("index.html")!.async("string")).toBe("C");
  expect(await zip.file("src/nested/中文.txt")!.async("string")).toBe(
    "checkpoint B",
  );
  expect(
    Array.from(await zip.file("public/logo.png")!.async("uint8array")),
  ).toEqual(fixture.bytes);
  expect(zip.file("only-d.txt")).toBeNull();

  await page.reload();
  await expect(
    page.getByText("Built checkpoint C", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "2 branches", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Switch branch", exact: true })
    .filter({ visible: true })
    .last()
    .click();
  await expect(
    page.getByText("Built checkpoint D", { exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(async ({ id, d }) => {
    const url = "/src/lib/project-archives/service.ts";
    const service = await import(url);
    const record = await service.ensureSnapshotArchive(id, d);
    return { status: record.status, size: record.size };
  }, fixture);
  expect(saved.status).toBe("ready");
  expect(saved.size).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Open snapshot history" }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Download project ZIP", exact: true })
      .last(),
  ).toBeVisible();
  const historyDownload = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Download project ZIP", exact: true })
    .last()
    .click();
  const historic = await historyDownload;
  const historicStream = await historic.createReadStream();
  const historicChunks: Buffer[] = [];
  for await (const chunk of historicStream)
    historicChunks.push(Buffer.from(chunk));
  const historicZip = await JSZip.loadAsync(Buffer.concat(historicChunks));
  expect(await historicZip.file("index.html")!.async("string")).toBe("B");
  expect(historicZip.file("only-d.txt")).toBeNull();
  await page.evaluate(async (id) => {
    const url = "/src/store/conversation.ts";
    (await import(url)).useConversationStore.getState().deleteConversation(id);
  }, fixture.id);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = "/src/lib/project-archives/opfs.ts";
        return (await (await import(url)).opfsArchiveStorage.estimate()).items;
      }),
    )
    .toBe(0);
});

test("shows distinct subagent status and a ten-pixel stop icon with themed scrollbars", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const settingsUrl = "/src/store/settings/index.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { useSettingsStore } = await import(settingsUrl);
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
          apiBaseUrl: "http://127.0.0.1:8811/v1",
          apiKey: "test-only",
          model: "test",
        },
      }),
    );
    const store = useConversationStore.getState();
    const id = store.createConversation();
    store.renameConversation(id, "Subagent test");
    store.setMessages([
      { role: "user", content: "Inspect the project entry" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "child",
            type: "function",
            function: {
              name: "dispatch_subagent",
              arguments: JSON.stringify({
                subagent: "code-explorer",
                task: "Inspect the project entry",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "child",
        content: JSON.stringify({
          ok: true,
          subagent: "code-explorer",
          task: "Inspect the project entry",
          status: "done",
          text: "Inspection complete",
          durationMs: 1200,
          events: [
            {
              name: "read_files",
              toolCallId: "empty-result",
              resultPreview: "",
              status: "completed",
              startedAt: 1,
              finishedAt: 2,
            },
          ],
        }),
      },
    ]);
  });
  const child = page.getByRole("button", { name: /Code Explorer/ });
  await expect(child.getByText("Inspect the project entry")).toBeVisible();
  await expect(child.getByText("Done", { exact: true })).toBeVisible();
  await child.click();
  await page.getByRole("button", { name: /^Read Files/ }).click();
  await expect(
    page.getByText("Completed with no text output", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("subagent-dark.png") });

  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/chat/completions", async (route) => {
    await response;
    await route
      .fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "data: [DONE]\n\n",
      })
      .catch(() => undefined);
  });
  try {
    await page
      .getByPlaceholder("Describe the app you want...")
      .fill("Inspect the project");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    await stop.hover();
    await expect
      .poll(() =>
        stop.locator(".lucide-square").evaluate((element) => ({
          width: getComputedStyle(element).width,
          height: getComputedStyle(element).height,
        })),
      )
      .toEqual({ width: "10px", height: "10px" });
    expect(
      await stop.evaluate((element) => getComputedStyle(element).width),
    ).toBe("28px");
    const scrollStyle = await page
      .locator('[class*="overflow-y-auto"]')
      .first()
      .evaluate((element) => ({
        scrollbarColor: getComputedStyle(element).scrollbarColor,
        track: getComputedStyle(element, "::-webkit-scrollbar").width,
        thumbRadius: getComputedStyle(element, "::-webkit-scrollbar-thumb")
          .borderRadius,
      }));
    expect(scrollStyle).toEqual({
      scrollbarColor: "auto",
      track: "8px",
      thumbRadius: "9999px",
    });
    await stop.click();
    await expect(stop).toHaveCount(0);
  } finally {
    release();
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(pageErrors).toEqual([]);
});
