import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

async function pngSize(download: Download) {
  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function seed(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const { useConversationStore } = await import("/src/store/conversation.ts");
    const { useSettingsStore } = await import("/src/store/settings/index.ts");
    useSettingsStore.setState((state) => ({
      system: {
        ...state.system,
        language: "en",
        theme: "light",
        autoQaEnabled: false,
      },
    }));
    const store = useConversationStore.getState();
    const result = store.replaceProject({
      template: "static",
      previewMode: "sandpack",
      activeFile: "index.html",
      files: {
        "index.html":
          '<!doctype html><html><head><style>body{margin:0;min-height:2400px;font:20px system-ui;background:#fff;color:#222}main{padding:400px 32px 32px}section{margin-top:600px;background:#e0e7ff;padding:32px}</style></head><body><main><h1>Screenshot fixture</h1><input aria-label="Preview draft" value="original"><section>End of full page</section></main><script>window.fixtureBoots=(window.fixtureBoots||0)+1</script></body></html>',
      },
    });
    if (!result.ok) throw new Error(result.error);
  });
  const frame = page.frameLocator(".sp-preview-iframe");
  await expect(
    frame.getByRole("heading", { name: "Screenshot fixture" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("button", { name: "Export screenshot" }),
  ).toBeEnabled({ timeout: 45_000 });
  return frame;
}

test("downloads viewport and full-page PNGs while retaining live input, scroll and iframe state", async ({
  page,
}) => {
  const frame = await seed(page);
  await frame
    .getByRole("textbox", { name: "Preview draft" })
    .fill("keep this draft");
  await frame.locator("body").evaluate(() => window.scrollTo(0, 320));
  const before = await frame
    .locator("body")
    .evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      fullHeight: document.documentElement.scrollHeight,
      scroll: scrollY,
      boots: (window as unknown as { fixtureBoots: number }).fixtureBoots,
    }));
  const iframe = await page.locator(".sp-preview-iframe").elementHandle();
  for (const [label, scope] of [
    ["Current viewport", "viewport"],
    ["Full page", "full-page"],
  ]) {
    await page.getByRole("button", { name: "Export screenshot" }).click();
    const pending = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(
      new RegExp(`-${scope}-.*\\.png$`),
    );
    expect(await pngSize(download)).toEqual({
      width: before.width,
      height: scope === "viewport" ? before.height : before.fullHeight,
    });
    await expect(
      page.getByRole("region", { name: "Export screenshot" }),
    ).toHaveCount(0);
    await expect(
      frame.getByRole("textbox", { name: "Preview draft" }),
    ).toHaveValue("keep this draft");
    expect(
      await frame
        .locator("body")
        .evaluate(() => ({
          scroll: scrollY,
          boots: (window as unknown as { fixtureBoots: number }).fixtureBoots,
        })),
    ).toEqual({ scroll: before.scroll, boots: before.boots });
    expect(
      await iframe!.evaluate(
        (element) => element === document.querySelector(".sp-preview-iframe"),
      ),
    ).toBe(true);
  }
});

test("exports source pixel dimensions from a scaled reverse selection and excludes editor controls", async ({
  page,
}, testInfo) => {
  await seed(page);
  await page.getByRole("button", { name: "Zoom out preview" }).click();
  await page.getByRole("button", { name: "Zoom out preview" }).click();
  await page.getByRole("button", { name: "Export screenshot" }).click();
  await page.getByRole("menuitem", { name: "Selected area" }).click();
  const editor = page.getByRole("region", { name: "Export screenshot" });
  const area = editor.getByRole("img", { name: "Select screenshot area" });
  await expect(area).toBeVisible();
  const bounds = (await area.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.8,
    bounds.y + bounds.height * 0.8,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.2,
    bounds.y + bounds.height * 0.2,
    { steps: 6 },
  );
  await page.mouse.up();
  const dimensions = (await editor.getByRole("status").innerText()).match(
    /(\d+) × (\d+) px/,
  )!;
  await page.screenshot({ path: testInfo.outputPath("selected-area.png") });
  const pending = page.waitForEvent("download");
  await editor.getByRole("button", { name: "Export PNG" }).click();
  expect(await pngSize(await pending)).toEqual({
    width: Number(dimensions[1]),
    height: Number(dimensions[2]),
  });
  await expect(editor).toHaveCount(0);
});

test("cancels a selected area with Escape without a download", async ({
  page,
}) => {
  await seed(page);
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  await page.getByRole("button", { name: "Export screenshot" }).click();
  await page.getByRole("menuitem", { name: "Selected area" }).click();
  await expect(
    page.getByRole("img", { name: "Select screenshot area" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("region", { name: "Export screenshot" }),
  ).toHaveCount(0);
  expect(downloads).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Export screenshot" }),
  ).toBeEnabled();
});
