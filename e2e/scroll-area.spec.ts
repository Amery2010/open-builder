import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

async function mountScrollArea(page: Page) {
  await page.route("**/__scroll_area_test__", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><div id="fixture"></div>
        <script type="module">
          import RefreshRuntime from '/@react-refresh';
          RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$ = () => {};
          window.$RefreshSig$ = () => type => type;
          window.__vite_plugin_react_preamble_installed__ = true;
        </script></body></html>`,
    }),
  );
  await page.goto("/__scroll_area_test__");
  await page.waitForFunction(() => "$RefreshReg$" in window);
  await page.evaluate(async () => {
    const reactUrl = "/node_modules/.vite/deps/react.js";
    const domUrl = "/node_modules/.vite/deps/react-dom_client.js";
    const componentUrl = "/src/components/ui/scroll-area.tsx";
    const cssUrl = "/src/index.css";
    const [{ default: React }, { default: ReactDOM }, { ScrollArea }] =
      await Promise.all([
        import(reactUrl),
        import(domUrl),
        import(componentUrl),
        import(cssUrl),
      ]);
    ReactDOM.createRoot(document.getElementById("fixture")!).render(
      React.createElement(
        ScrollArea,
        {
          orientation: "both",
          style: { width: 320, height: 240, margin: 32 },
          viewportProps: { "aria-label": "Scrollable fixture" },
        },
        React.createElement(
          "div",
          { style: { width: 900, height: 1600, padding: 24 } },
          "Scrollable content",
        ),
      ),
    );
  });
  const root = page.locator('[data-slot="scroll-area"]');
  await expect(root.locator('[data-slot="scroll-area-thumb"]')).toHaveCount(2);
  return root;
}

async function visualThickness(visual: Locator, axis: "width" | "height") {
  return visual.evaluate(
    (node, axis) => node.getBoundingClientRect()[axis],
    axis,
  );
}

test("animates both handles without reflow and preserves wheel, track and drag scrolling", async ({
  page,
}) => {
  const root = await mountScrollArea(page);
  const viewport = root.locator('[data-slot="scroll-area-viewport"]');
  const before = await viewport.boundingBox();

  for (const [orientation, axis] of [
    ["vertical", "width"],
    ["horizontal", "height"],
  ] as const) {
    const bar = root.locator(`[data-orientation="${orientation}"]`);
    const visual = bar.locator(".app-scroll-area-thumb-visual");
    await expect.poll(() => visualThickness(visual, axis)).toBeCloseTo(4, 1);
    const box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const middle = await visual.evaluate(
      (node, axis) =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() =>
            resolve(node.getBoundingClientRect()[axis]),
          ),
        ),
      axis,
    );
    expect(middle).toBeGreaterThan(4);
    expect(middle).toBeLessThan(8);
    await expect.poll(() => visualThickness(visual, axis)).toBeCloseTo(8, 1);
    expect(await viewport.boundingBox()).toEqual(before);
    await page.mouse.move(0, 0);
    await expect.poll(() => visualThickness(visual, axis)).toBeCloseTo(4, 1);
  }

  await viewport.hover();
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  const bar = root.locator('[data-orientation="vertical"]');
  const track = (await bar.boundingBox())!;
  await page.mouse.click(track.x + track.width / 2, track.y + track.height - 8);
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(800);

  const thumb = (await bar
    .locator('[data-slot="scroll-area-thumb"]')
    .boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x - 40, track.y + 20, { steps: 5 });
  await expect(bar).toHaveAttribute("data-dragging", "true");
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollTop))
    .toBeLessThan(400);
  await page.mouse.up();
  await expect(bar).not.toHaveAttribute("data-dragging", "true");

  await viewport.focus();
  const top = await viewport.evaluate((node) => node.scrollTop);
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(top);
});

test("honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const root = await mountScrollArea(page);
  const bar = root.locator('[data-orientation="vertical"]');
  const visual = bar.locator(".app-scroll-area-thumb-visual");
  expect(
    await visual.evaluate((node) =>
      parseFloat(getComputedStyle(node).transitionDuration),
    ),
  ).toBeLessThanOrEqual(0.00001);
  await bar.hover();
  expect(await visualThickness(visual, "width")).toBeCloseTo(8, 1);
});

test("keeps virtualized messages scrollable and follows new messages only at the bottom", async ({
  page,
}) => {
  const renderErrors: string[] = [];
  page.on("console", (message) => {
    if (/flushSync|Maximum update depth/.test(message.text()))
      renderErrors.push(message.text());
  });
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const settingsUrl = "/src/store/settings/index.ts";
    const conversationUrl = "/src/store/conversation.ts";
    const { useSettingsStore } = await import(settingsUrl);
    const { useConversationStore } = await import(conversationUrl);
    useSettingsStore.setState((state: { system: object }) => ({
      system: { ...state.system, language: "en" },
    }));
    useConversationStore.getState().setMessages(
      Array.from({ length: 80 }, (_, index) => ({
        id: `scroll-message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Scroll message ${index}. `.repeat(12),
      })),
    );
  });
  const viewport = page.locator('[data-slot="scroll-area-viewport"]').first();
  await expect
    .poll(() =>
      viewport.evaluate((node) => node.scrollHeight - node.clientHeight),
    )
    .toBeGreaterThan(2000);
  await expect(page.locator('[data-index="79"]')).toBeVisible();
  await viewport.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.locator('[data-index="0"]')).toBeVisible();
  await expect(page.locator('[data-index="79"]')).toHaveCount(0);
  const appendMessage = () =>
    page.evaluate(async () => {
      const url = "/src/store/conversation.ts";
      const { useConversationStore } = await import(url);
      useConversationStore.getState().setMessages((messages: object[]) => [
        ...messages,
        {
          id: `scroll-message-${messages.length}`,
          role: messages.length % 2 === 0 ? "user" : "assistant",
          content: `New message ${messages.length}. `.repeat(12),
        },
      ]);
    });
  await appendMessage();
  await expect(page.locator('[data-index="0"]')).toBeVisible();
  expect(await viewport.evaluate((node) => node.scrollTop)).toBeLessThan(100);
  await viewport.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.locator('[data-index="80"]')).toBeVisible();
  await appendMessage();
  await expect(page.locator('[data-index="81"]')).toBeVisible();
  await expect
    .poll(() =>
      viewport.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeLessThan(96);
  expect(renderErrors).toEqual([]);
});

test.describe("touch scrollbars", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("keeps handles expanded without hover", async ({ page }) => {
    const root = await mountScrollArea(page);
    const visual = root.locator(
      '[data-orientation="vertical"] .app-scroll-area-thumb-visual',
    );
    await expect.poll(() => visualThickness(visual, "width")).toBeCloseTo(8, 1);
  });
});

test("preserves file-tree drops and keeps settings actions visible while scrolling", async ({
  page,
}) => {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const settingsUrl = "/src/store/settings/index.ts";
    const conversationUrl = "/src/store/conversation.ts";
    const { useSettingsStore } = await import(settingsUrl);
    const { useConversationStore } = await import(conversationUrl);
    useSettingsStore.setState((state: { system: object }) => ({
      system: { ...state.system, language: "en" },
    }));
    useConversationStore.getState().replaceProject({
      files: {
        "index.html": "<h1>File-tree scrolling</h1>",
        "drag.txt": "Move me",
        "docs/keep.txt": "Keep me",
        [`${"long-name-".repeat(20)}.txt`]: "Long filename",
        ...Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [
            `file-${index}.txt`,
            "File",
          ]),
        ),
      },
      template: "static",
      previewMode: "code-only",
      activeFile: "index.html",
    });
  });
  const files = page.getByLabel("Files", { exact: true });
  await expect
    .poll(() => files.evaluate((node) => node.scrollHeight > node.clientHeight))
    .toBe(true);
  const widths = await files.evaluate((node) => ({
    viewport: node.clientWidth,
    row: node.querySelector("button")!.getBoundingClientRect().width,
  }));
  expect(widths.row).toBeLessThanOrEqual(widths.viewport);
  await files
    .getByRole("button", { name: "drag.txt", exact: true })
    .dragTo(files.getByRole("button", { name: "docs", exact: true }));
  const filePaths = () =>
    page.evaluate(async () => {
      const url = "/src/store/conversation.ts";
      const { useConversationStore } = await import(url);
      const state = useConversationStore.getState();
      return Object.keys(state.conversations[state.activeId!].files);
    });
  await expect.poll(filePaths).toContain("docs/drag.txt");
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "docs/drag.txt");
    return data;
  });
  await files.dispatchEvent("drop", { dataTransfer: transfer });
  await expect.poll(filePaths).toContain("drag.txt");
  expect(await filePaths()).not.toContain("docs/drag.txt");
  await transfer.dispose();

  await page.setViewportSize({ width: 980, height: 360 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Advanced", exact: true }).click();
  const viewport = dialog.locator('[data-slot="scroll-area-viewport"]');
  await expect
    .poll(() =>
      viewport.evaluate((node) => node.scrollHeight > node.clientHeight),
    )
    .toBe(true);
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  const saveBefore = await save.boundingBox();
  await viewport.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(save).toBeInViewport();
  expect(await save.boundingBox()).toEqual(saveBefore);
});
