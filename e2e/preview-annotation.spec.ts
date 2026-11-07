import { expect, test, type Page } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

async function seed(
  page: Page,
  react = false,
  longConversation = false,
  theme: "light" | "dark" = "light",
) {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(
    async ({ react, longConversation, theme }) => {
      const settingsUrl = "/src/store/settings/index.ts";
      const { useSettingsStore } = await import(settingsUrl);
      useSettingsStore.setState((state: { system: object }) => ({
        system: {
          ...state.system,
          language: "en",
          theme,
          imageCompressionEnabled: false,
        },
      }));
      const storeUrl = "/src/store/conversation.ts";
      const { useConversationStore: store } = await import(storeUrl);
      store.getState().createConversation();
      const body = `<main style="padding-top:440px"><h1>Annotation preview</h1><input aria-label="Preview draft" value="original"><button id="open">Open dialog</button><dialog style="position:fixed;top:60px;left:20px;margin:0;background:rgb(240,20,30);border:0;padding:20px">Visible dialog</dialog></main>`;
      const css =
        "body{margin:0;min-height:2500px;font:20px sans-serif;background:white;color:black}";
      let files: Record<string, string> = {
        "index.html": `<!doctype html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>${body}<script>window.bootCount=(window.bootCount||0)+1;document.querySelector('#open').onclick=()=>document.querySelector('dialog').show()</script></body></html>`,
      };
      if (react) {
        const fsToolsUrl = "/src/lib/tools/fs-tools.ts";
        const { fsInitProject } = await import(fsToolsUrl);
        const initialized = await fsInitProject("vite-react-ts");
        if (!initialized.newFiles) throw new Error(initialized.result);
        files = {
          ...initialized.newFiles,
          "App.tsx": `import React from "react";export default function App(){return <main><h1>Annotation preview</h1><input aria-label="Preview draft" defaultValue="original" /></main>}`,
          "styles.css":
            "body{margin:0;background:white;color:black;font:20px sans-serif}",
        };
      }
      store.getState().replaceProject({
        template: react ? "vite-react-ts" : "static",
        previewMode: "sandpack",
        files,
        activeFile: "index.html",
      });
      if (longConversation)
        store.getState().setMessages(
          Array.from({ length: 6 }, (_, index) => ({
            id: `history-${index}`,
            role: "assistant",
            content: "A previous design discussion. ".repeat(30),
          })),
        );
    },
    { react, longConversation, theme },
  );
  await expect(
    page
      .frameLocator(".sp-preview-iframe")
      .getByRole("heading", { name: "Annotation preview" }),
  ).toBeVisible({ timeout: 90_000 });
}

async function openAnnotation(page: Page, scope = "Current viewport") {
  await page.getByRole("button", { name: "Annotate preview" }).click();
  await page.getByRole("menuitem", { name: scope, exact: true }).click();
}

async function drag(
  page: Page,
  area: { x: number; y: number; width: number; height: number },
  from: [number, number],
  to: [number, number],
) {
  await page.mouse.move(
    area.x + area.width * from[0],
    area.y + area.height * from[1],
  );
  await page.mouse.down();
  await page.mouse.move(
    area.x + area.width * to[0],
    area.y + area.height * to[1],
    { steps: 6 },
  );
  await page.mouse.up();
}

for (const { width, theme } of [
  { width: 1440, theme: "light" },
  { width: 390, theme: "dark" },
] as const) {
  test(`uses custom annotation controls at ${width}px in ${theme} theme`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: 900 });
    await seed(page, false, false, theme);
    await openAnnotation(page);
    const editor = page.getByRole("region", { name: "Annotate preview" });
    await expect(editor.getByLabel("Draw on the preview image")).toBeVisible();
    const toolbar = editor.getByRole("toolbar");
    expect(
      await toolbar.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    expect(
      await editor.locator('input[type="color"], select:visible').count(),
    ).toBe(0);
    const color = editor.getByRole("button", {
      name: "Annotation color",
      exact: true,
    });
    await color.click();
    const palette = page.getByRole("dialog", {
      name: "Annotation color",
      exact: true,
    });
    await palette.getByRole("button", { name: "Blue", exact: true }).click();
    await expect(
      palette.getByRole("button", { name: "Blue", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const hex = palette.getByRole("textbox", { name: "HEX color" });
    await hex.fill("#123ABC");
    await expect(hex).toHaveAttribute("aria-invalid", "false");
    const paletteBounds = (await palette.boundingBox())!;
    expect(paletteBounds.x).toBeGreaterThanOrEqual(0);
    expect(paletteBounds.x + paletteBounds.width).toBeLessThanOrEqual(width);
    await editor.screenshot({
      path: testInfo.outputPath(`annotation-palette-${theme}.png`),
      animations: "disabled",
    });
    await palette.getByRole("button", { name: "Blue", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(palette).not.toBeAttached();
    await expect(editor).toBeVisible();
    await expect(color).toBeFocused();

    const stroke = editor.getByRole("combobox", { name: "Stroke width" });
    await stroke.focus();
    await page.keyboard.press("Space");
    await expect(
      page.getByRole("option", { name: "Thick", exact: true }),
    ).toBeVisible();
    await page.locator('section[aria-label="Annotate preview"]').screenshot({
      path: testInfo.outputPath(`annotation-stroke-${theme}.png`),
      animations: "disabled",
    });
    await page.getByRole("option", { name: "Thick", exact: true }).click();
    await expect(stroke).toHaveText("Thick");
    await stroke.press("Space");
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(stroke).toBeFocused();
    await editor.getByRole("button", { name: "Attach image" }).click();
    await expect(
      page.getByRole("button", { name: "Remove preview-annotation.png" }),
    ).toBeAttached();
  });
}

test("annotates the frozen scrolled viewport and appends a cropped PNG to the existing draft", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seed(page);
  const chat = page.getByPlaceholder("Describe the app you want...");
  await chat.fill("Please fix these details");
  await page.locator('input[type="file"][accept^="text/"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Existing attachment"),
  });
  await expect(
    page.getByRole("button", { name: "Remove notes.txt" }),
  ).toBeAttached();
  const preview = page.frameLocator(".sp-preview-iframe");
  const input = preview.getByRole("textbox", { name: "Preview draft" });
  await input.fill("unsaved preview input");
  await preview.getByRole("button", { name: "Open dialog" }).click();
  await input.evaluate(() => window.scrollTo(0, 400));
  const before = await input.evaluate((node) => ({
    value: (node as HTMLInputElement).value,
    scroll: window.scrollY,
    boot: (window as unknown as { bootCount: number }).bootCount,
  }));
  await openAnnotation(page);
  const editor = page.getByRole("region", { name: "Annotate preview" });
  const canvas = editor.getByLabel("Draw on the preview image");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  const original = await editor
    .locator("img")
    .evaluate((image: HTMLImageElement) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
      src: image.src,
    }));
  const bounds = (await canvas.boundingBox())!;
  const afterCapture = await input.evaluate((node) => ({
    value: (node as HTMLInputElement).value,
    scroll: window.scrollY,
    boot: (window as unknown as { bootCount: number }).bootCount,
  }));
  expect(afterCapture).toEqual(before);
  await editor.getByRole("button", { name: "Line", exact: true }).click();
  await drag(page, bounds, [0.3, 0.4], [0.7, 0.4]);
  await editor.getByRole("button", { name: "Select screenshot area" }).click();
  await drag(page, bounds, [0.9, 0.9], [0.1, 0.1]);
  // Updating the project must not replace or invalidate the already frozen image.
  await page.evaluate(async () => {
    const url = "/src/store/conversation.ts";
    const { useConversationStore: store } = await import(url);
    const id = store.getState().activeId;
    store
      .getState()
      .setFilesForConversation(id, (files: Record<string, string>) => ({
        ...files,
        "notes.md": "Updated while annotating",
      }));
  });
  await expect(editor.locator("img")).toHaveAttribute("src", original.src);
  await editor.getByRole("button", { name: "Attach image" }).click();
  await expect(editor).not.toBeAttached();
  await expect(chat).toHaveValue("Please fix these details");
  await expect(
    page.getByRole("button", { name: "Remove notes.txt" }),
  ).toBeAttached();
  const attached = page.getByRole("button", {
    name: "Remove preview-annotation.png",
  });
  await expect(attached).toBeAttached();
  const image = attached.locator("..").locator("img");
  const result = await image.evaluate(async (node: HTMLImageElement) => {
    await node.decode();
    const canvas = document.createElement("canvas");
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(node, 0, 0);
    // Original y=.4 becomes (.4-.1)/.8 after cropping.
    const centerX = Math.floor(canvas.width / 2);
    const centerY = Math.round(canvas.height * 0.375);
    const pixels = Array.from(
      context.getImageData(centerX, Math.max(0, centerY - 2), 1, 5).data,
    );
    return {
      width: canvas.width,
      height: canvas.height,
      type: (await (await fetch(node.src)).blob()).type,
      pixels,
    };
  });
  expect(Math.abs(result.width - original.width * 0.8)).toBeLessThanOrEqual(2);
  expect(Math.abs(result.height - original.height * 0.8)).toBeLessThanOrEqual(
    2,
  );
  expect(result.type).toBe("image/png");
  expect(
    result.pixels.some(
      (red, index, all) => index % 4 === 0 && red > 210 && all[index + 1] < 110,
    ),
  ).toBe(true);
});

test("supports React previews, all drawing tools, undo, clear and text", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page, true);
  await openAnnotation(page);
  const editor = page.getByRole("region", { name: "Annotate preview" });
  const canvas = editor.getByLabel("Draw on the preview image");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  const bounds = (await canvas.boundingBox())!;
  for (const name of [
    "Arrow",
    "Rectangle",
    "Ellipse",
    "Line",
    "Freehand brush",
  ]) {
    await editor.getByRole("button", { name, exact: true }).click();
    await drag(page, bounds, [0.2, 0.3], [0.6, 0.5]);
  }
  await editor.getByRole("button", { name: "Undo", exact: true }).click();
  await editor.getByRole("button", { name: "Redo", exact: true }).click();
  await editor.getByRole("button", { name: "Clear annotations" }).click();
  await editor.getByRole("button", { name: "Undo", exact: true }).click();
  await editor.getByRole("button", { name: "Text", exact: true }).click();
  await canvas.click({
    position: { x: bounds.width * 0.2, y: bounds.height * 0.6 },
  });
  await editor
    .getByRole("textbox", { name: "Enter text" })
    .fill("Review this heading");
  await editor.getByRole("button", { name: "Add text", exact: true }).click();
  await editor.screenshot({
    path: testInfo.outputPath("annotation-editor.png"),
  });
  await editor.getByRole("button", { name: "Attach image" }).click();
  await expect(
    page.getByRole("button", { name: "Remove preview-annotation.png" }),
  ).toBeAttached();
});

test("uses actual iframe dimensions at different device widths and preview zoom levels", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seed(page);
  for (const device of ["Pad", "Mobile", "Web"]) {
    await page.getByRole("button", { name: device, exact: true }).click();
    await page
      .getByRole("button", {
        name: device === "Pad" ? "Zoom out preview" : "Zoom in preview",
        exact: true,
      })
      .click();
    // The preview applies animated size changes; wait for their final viewport.
    await expect
      .poll(() =>
        page.locator(".sp-preview-iframe").evaluate((node) => ({
          width: node.clientWidth,
          height: node.clientHeight,
        })),
      )
      .toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    await openAnnotation(page);
    const editor = page.getByRole("region", { name: "Annotate preview" });
    await expect(editor.getByLabel("Draw on the preview image")).toBeVisible();
    const viewport = await page
      .locator(".sp-preview-iframe")
      .evaluate((node) => ({
        width: node.clientWidth,
        height: node.clientHeight,
      }));
    const captured = await editor
      .locator("img")
      .evaluate((node: HTMLImageElement) => ({
        width: node.naturalWidth,
        height: node.naturalHeight,
      }));
    expect(captured).toEqual(viewport);
    await editor.getByRole("button", { name: "Cancel annotation" }).click();
  }
});

test("keeps the annotation toolbar reachable in a phone conversation and cancels on a branch change", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, false, true);
  await openAnnotation(page);
  const editor = page.getByRole("region", { name: "Annotate preview" });
  await expect(editor.getByLabel("Draw on the preview image")).toBeVisible({
    timeout: 20_000,
  });
  const toolbar = await editor.getByRole("toolbar").boundingBox();
  expect(toolbar!.width).toBeLessThanOrEqual(390);
  expect(toolbar!.height).toBeLessThan(200);
  await editor.getByRole("button", { name: "Attach image" }).click();
  await expect(
    page.getByRole("button", { name: "Remove preview-annotation.png" }),
  ).toBeAttached();
  await openAnnotation(page);
  await expect(editor.getByLabel("Draw on the preview image")).toBeVisible();
  await page.evaluate(async () => {
    const url = "/src/store/conversation.ts";
    const { useConversationStore: store } = await import(url);
    const id = store.getState().activeId;
    store.setState(
      (state: {
        conversations: Record<string, { checkoutEpoch?: number }>;
      }) => ({
        conversations: {
          ...state.conversations,
          [id]: {
            ...state.conversations[id],
            checkoutEpoch: (state.conversations[id].checkoutEpoch ?? 0) + 1,
          },
        },
      }),
    );
  });
  await expect(editor).not.toBeAttached();
});

for (const react of [false, true]) {
  test(`captures the complete long ${react ? "React page with modern colors" : "static page"} for AI and annotation`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await seed(page, react);
    const input = page
      .frameLocator(".sp-preview-iframe")
      .getByRole("textbox", { name: "Preview draft" });
    await input.fill("preserved long-page draft");
    const before = await input.evaluate((node, modernColors) => {
      document.body.style.minHeight = "10000px";
      if (modernColors) document.body.style.color = "oklch(0.25 0.02 260)";
      const footer = document.createElement("footer");
      footer.textContent = "Full-page footer";
      footer.style.cssText =
        "position:absolute;left:0;top:9400px;height:600px;width:100%;background:rgb(20,180,60)";
      document.body.append(footer);
      window.scrollTo(0, 400);
      return {
        value: (node as HTMLInputElement).value,
        scroll: window.scrollY,
        height: document.documentElement.scrollHeight,
      };
    }, react);
    const evidence = await page.evaluate(async () => {
      const runtimeUrl = "/src/lib/design/preview-sequence.ts";
      const storeUrl = "/src/store/conversation.ts";
      const { capturePreviewSequence, createPreviewSequenceToolOutput } =
        await import(runtimeUrl);
      const { useConversationStore: store } = await import(storeUrl);
      const collection = await capturePreviewSequence({
        conversationId: store.getState().activeId,
        scope: "full-page",
      });
      const output = await createPreviewSequenceToolOutput(collection);
      const capture = collection.frames[0]?.capture;
      if (!capture) throw new Error(collection.errors.join("; "));
      const image = new Image();
      image.src = capture.dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return {
        summary: output.structuredContent,
        footerPixel: Array.from(
          context.getImageData(
            Math.floor(canvas.width / 2),
            canvas.height - 20,
            1,
            1,
          ).data,
        ),
      };
    });
    expect(evidence.summary.status).toBe("complete");
    expect(evidence.summary.frames[0].evidence).toMatchObject({
      capture: { scope: "full-page", region: { height: before.height } },
      viewport: {
        fullHeight: before.height,
        capturedHeight: before.height,
        truncated: false,
      },
    });
    expect(evidence.summary.frames[0].evidence.capture.scale).toBeLessThan(1);
    expect(
      evidence.summary.frames[0].evidence.image.height,
    ).toBeLessThanOrEqual(4096);
    expect(evidence.footerPixel[1]).toBeGreaterThan(150);
    expect(evidence.footerPixel[0]).toBeLessThan(50);

    await openAnnotation(page, "Full page");
    const editor = page.getByRole("region", { name: "Annotate preview" });
    const canvas = editor.getByLabel("Draw on the preview image");
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const original = await editor
      .locator("img")
      .evaluate(async (image: HTMLImageElement) => {
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      });
    expect(original.height).toBe(before.height);
    const stage = canvas.locator("../..");
    await stage.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await editor
      .getByRole("button", { name: "Select screenshot area" })
      .click();
    const visible = (await stage.boundingBox())!;
    const bounds = (await canvas.boundingBox())!;
    const cropTop = Math.max(visible.y + 20, bounds.y);
    await page.mouse.move(bounds.x + bounds.width * 0.1, cropTop);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width * 0.9,
      visible.y + visible.height - 20,
      { steps: 6 },
    );
    await page.mouse.up();
    await editor.screenshot({
      path: testInfo.outputPath("long-page-annotation.png"),
    });
    await editor.getByRole("button", { name: "Attach image" }).click();
    const attached = page
      .getByRole("button", { name: "Remove preview-annotation.png" })
      .locator("..")
      .locator("img");
    await expect(attached).toBeAttached();
    const cropped = await attached.evaluate(async (image: HTMLImageElement) => {
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        footerPixel: Array.from(
          context.getImageData(
            Math.floor(canvas.width / 2),
            canvas.height - 5,
            1,
            1,
          ).data,
        ),
      };
    });
    expect(Math.abs(cropped.width - original.width * 0.8)).toBeLessThanOrEqual(
      2,
    );
    expect(cropped.height).toBeLessThan(original.height);
    expect(cropped.footerPixel[1]).toBeGreaterThan(150);
    expect(cropped.footerPixel[0]).toBeLessThan(50);
    expect(
      await input.evaluate((node) => ({
        value: (node as HTMLInputElement).value,
        scroll: window.scrollY,
        height: document.documentElement.scrollHeight,
      })),
    ).toEqual(before);
  });
}
