import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

test("captures a changing live page without refreshing its interactive state", async ({
  page,
}) => {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const storeUrl = "/src/store/conversation.ts";
    const { useConversationStore: store } = await import(storeUrl);
    store.getState().createConversation();
    store.getState().replaceProject({
      template: "static",
      previewMode: "sandpack",
      files: {
        "index.html": `<!doctype html><html><head><meta charset="UTF-8"><style>body{margin:0;min-height:2500px;font:20px sans-serif;background:white;color:black}main{padding-top:450px}dialog{position:fixed;top:10px;background:rgb(240,20,30);border:2px solid black}h1{font-size:28px}</style></head><body><main><h1>Live initial state</h1><input aria-label="Draft" value="original"><button id="start">Start changes</button><dialog>Visible dialog</dialog></main><script>window.bootCount=(window.bootCount||0)+1;document.getElementById('start').onclick=()=>{document.querySelector('dialog').show();setTimeout(()=>{document.querySelector('h1').textContent='Live changed state'},1000)}</script></body></html>`,
      },
      activeFile: "index.html",
    });
  });
  const preview = page.frameLocator(".sp-preview-iframe");
  await expect(
    preview.getByRole("heading", { name: "Live initial state" }),
  ).toBeVisible({ timeout: 60_000 });
  await preview.getByRole("textbox", { name: "Draft" }).fill("unsaved draft");
  await preview.getByRole("button", { name: "Start changes" }).click();
  const iframe = page
    .frames()
    .find(
      (frame) => frame !== page.mainFrame() && frame.url().includes("sandpack"),
    );
  const input = preview.getByRole("textbox", { name: "Draft" });
  await input.evaluate(() => window.scrollTo(0, 400));
  const before = await input.evaluate((node) => ({
    value: (node as HTMLInputElement).value,
    scroll: window.scrollY,
    dialog: document.querySelector("dialog")!.open,
    boot: (window as unknown as { bootCount: number }).bootCount,
  }));
  const dialogProbe = await preview.locator("dialog").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + 8), y: Math.round(rect.top + 8) };
  });
  let navigationCount = 0;
  const navigated = (frame: import("@playwright/test").Frame) => {
    if (frame === iframe) navigationCount += 1;
  };
  page.on("framenavigated", navigated);
  const result = await page.evaluate(async (probe) => {
    const storeUrl = "/src/store/conversation.ts";
    const { useConversationStore: store } = await import(storeUrl);
    const sequenceUrl = "/src/lib/design/preview-sequence.ts";
    const { capturePreviewSequence, createPreviewSequenceToolOutput } =
      await import(sequenceUrl);
    const collection = await capturePreviewSequence({
      conversationId: store.getState().activeId,
      atMs: [0, 1500, 3000],
    });
    const output = await createPreviewSequenceToolOutput(collection);
    const image = new Image();
    image.src = collection.frames[0].capture.dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const pixel = Array.from(ctx.getImageData(probe.x, probe.y, 1, 1).data);
    return {
      fixedDialogPixel: pixel,
      summary: output.structuredContent,
      imageCount: output.content.filter(
        (part: { type: string }) => part.type === "image",
      ).length,
    };
  }, dialogProbe);
  page.off("framenavigated", navigated);
  expect(result.summary.status).toBe("complete");
  expect(result.imageCount).toBe(3);
  expect(result.fixedDialogPixel[0]).toBeGreaterThan(200);
  expect(result.fixedDialogPixel[1]).toBeLessThan(60);
  expect(result.fixedDialogPixel[2]).toBeLessThan(70);
  expect(
    result.summary.frames.map(
      (frame: { scheduledAtMs: number }) => frame.scheduledAtMs,
    ),
  ).toEqual([0, 1500, 3000]);
  expect(
    new Set(
      result.summary.frames.map(
        (frame: { evidence: { image: { digest: string } } }) =>
          frame.evidence.image.digest,
      ),
    ).size,
  ).toBeGreaterThan(1);
  const after = await input.evaluate((node) => ({
    value: (node as HTMLInputElement).value,
    scroll: window.scrollY,
    dialog: document.querySelector("dialog")!.open,
    boot: (window as unknown as { bootCount: number }).bootCount,
  }));
  expect(after).toEqual(before);
  expect(navigationCount).toBe(0);
});
