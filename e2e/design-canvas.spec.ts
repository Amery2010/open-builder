import { expect, test, type Page } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

const renderErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  renderErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.text().includes("Maximum update depth"))
      errors.push(message.text());
  });
});
test.afterEach(({ page }) => {
  expect(renderErrors.get(page)).toEqual([]);
});

async function seedCanvas(
  page: Page,
  blueprint = true,
  theme: "light" | "dark" = "light",
) {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(
    async ({ blueprint, theme }) => {
      const settingsUrl = "/src/store/settings/index.ts";
      const storeUrl = "/src/store/conversation.ts";
      const { useSettingsStore } = await import(settingsUrl);
      const { useConversationStore } = await import(storeUrl);
      useSettingsStore.setState((state: { system: object }) => ({
        system: { ...state.system, language: "en", theme },
      }));
      const files: Record<string, string> = {
        "index.html": `<!doctype html><html><head><meta charset="utf-8"><title>Canvas fixture</title><style>body{margin:0;font:18px system-ui;color:#203729;background:#fafaf7}header{padding:48px 64px;border-bottom:1px solid #d6dfd8;display:flex;justify-content:space-between}main{padding:80px 64px;min-height:1550px;box-sizing:border-box}h1{font-size:88px;max-width:800px;line-height:1.05;letter-spacing:-4px;font-weight:500}p{max-width:520px;line-height:1.6}section{margin-top:140px;padding:64px;background:#e2ebe4;height:420px}input{padding:16px;border:1px solid #b9c9be;background:transparent}a{color:inherit}</style></head><body><header><strong>COMMON GROUND</strong><a href="#/library">Explore the library</a></header><main></main><script>window.bootCount=(window.bootCount||0)+1;function render(){const library=location.hash.includes('library');document.querySelector('main').style.minHeight=library?'2400px':'1550px';document.querySelector('main').innerHTML='<p>A place for considered ideas</p><h1>'+(library?'The library':'Make room for what matters.')+'</h1><p>Stories, objects and ideas for a more thoughtful everyday.</p><input aria-label="Preview draft" value="original"><section>Selected stories</section>';}addEventListener('hashchange',render);render();</script></body></html>`,
      };
      if (blueprint)
        files["design-project.json"] = JSON.stringify({
          schemaVersion: "open-builder-design-project/v2",
          revision: 1,
          pages: [
            {
              id: "home",
              name: "Home",
              route: "#/home",
              filePaths: ["index.html"],
            },
            {
              id: "library",
              name: "Library",
              route: "#/library",
              filePaths: ["index.html"],
            },
            { id: "draft", name: "Draft", route: "/items/[id]" },
          ],
        });
      const result = useConversationStore.getState().replaceProject({
        files,
        template: "static",
        previewMode: "sandpack",
        activeFile: "index.html",
      });
      if (!result.ok) throw new Error(result.error);
      useConversationStore.getState().setWorkspaceMode("design");
    },
    { blueprint, theme },
  );
  await expect(page.getByTestId("design-canvas")).toBeVisible();
}

async function layout(page: Page) {
  return page.evaluate(async () => {
    const url = "/src/store/project-design-workspace.ts";
    const { useProjectDesignWorkspaceStore } = await import(url);
    return Object.values(
      useProjectDesignWorkspaceStore.getState().layouts,
    )[0] as {
      camera: { x: number; y: number; zoom: number };
      positions: Record<string, { x: number; y: number }>;
    };
  });
}

test("shows full pages, selects without navigation and keeps one live runtime across focus", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await seedCanvas(page);
  const canvas = page.getByTestId("design-canvas");
  const headerBounds = await page.getByTestId("view-toolbar").boundingBox();
  const canvasBounds = await canvas.boundingBox();
  expect(canvasBounds!.y).toBeGreaterThanOrEqual(
    headerBounds!.y + headerBounds!.height,
  );
  await expect(
    canvas.locator(".design-canvas-context, .design-canvas-top"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open project pages", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("project-design-navigator")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Arrange boards" }),
  ).toHaveCount(0);
  const glass = await canvas
    .locator(".design-canvas-bottom .design-canvas-panel")
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).backdropFilter),
    );
  expect(glass).toEqual(["blur(16px)", "blur(16px)"]);
  await expect(canvas.locator('[data-canvas-board="home"]')).toHaveAttribute(
    "data-preview-status",
    "ready",
    { timeout: 120_000 },
  );
  await expect(canvas.locator('[data-canvas-board="library"]')).toHaveAttribute(
    "data-preview-status",
    "ready",
    { timeout: 120_000 },
  );
  const heights = await canvas
    .locator("[data-canvas-board]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).offsetHeight),
    );
  expect(heights[1]).toBeGreaterThan(heights[0]);
  expect(heights[0]).toBeGreaterThan(900);
  const frame = page.frameLocator(".design-canvas-runtime .sp-preview-iframe");
  const route = await frame.locator("html").evaluate(() => location.hash);
  await canvas.getByRole("button", { name: "Library", exact: true }).click();
  expect(await frame.locator("html").evaluate(() => location.hash)).toBe(route);
  await expect(canvas.locator('[data-canvas-board="library"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("canvas-light.png"),
  });
  await page
    .locator(".sp-preview-iframe")
    .evaluate((node) => node.setAttribute("data-mount-token", "stable"));
  await canvas.getByRole("button", { name: "Library", exact: true }).dblclick();
  await expect(
    page.getByRole("button", { name: "Back to canvas" }),
  ).toBeVisible();
  await expect(
    page
      .frameLocator(".sp-preview-iframe")
      .getByRole("heading", { name: "The library" }),
  ).toBeVisible();
  await page
    .frameLocator(".sp-preview-iframe")
    .getByLabel("Preview draft")
    .fill("keep this draft");
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await canvas
    .getByRole("button", { name: "Library", exact: true })
    .press("Enter");
  await expect(
    page.frameLocator(".sp-preview-iframe").getByLabel("Preview draft"),
  ).toHaveValue("keep this draft");
  await expect(page.locator(".sp-preview-iframe")).toHaveAttribute(
    "data-mount-token",
    "stable",
  );
});

test("persists camera and dragged positions through reload without editing project files", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedCanvas(page);
  const canvas = page.getByTestId("design-canvas");
  await expect.poll(() => layout(page)).toBeTruthy();
  await canvas.focus();
  await canvas.press("+");
  await canvas.press("Shift+2");
  const header = canvas.locator(
    '[data-canvas-board="home"] [data-canvas-drag-handle]',
  );

  const point = await header.boundingBox();
  if (!point) throw new Error("Board header is missing");
  await page.mouse.move(point.x + 30, point.y + 10);
  await page.mouse.down();
  await page.mouse.move(point.x + 90, point.y + 15, { steps: 5 });
  await page.mouse.up();
  const saved = await layout(page);

  expect(saved.positions.home.x).not.toBe(0);
  expect(saved.positions.home.y).toBeCloseTo(0, 8);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByTestId("design-canvas")).toBeVisible();
  await expect.poll(() => layout(page)).toEqual(saved);
  await expect
    .poll(() =>
      page
        .getByTestId("design-canvas")
        .evaluate((node) =>
          Number(node.style.getPropertyValue("--canvas-zoom")),
        ),
    )
    .toBe(saved.camera.zoom);
});

test("keeps draft boards selectable and exposes all actions in a narrow dark workspace", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await seedCanvas(page, true, "dark");
  const canvas = page.getByTestId("design-canvas");
  await canvas.getByRole("button", { name: "Draft", exact: true }).click();
  await expect(canvas.locator('[data-canvas-board="draft"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await canvas
    .getByRole("button", { name: "Draft", exact: true })
    .press("Enter");
  await expect(canvas).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toHaveCount(0);
  await canvas.focus();
  await canvas.press("v");
  const appearance = await canvas.evaluate((node) => {
    const style = getComputedStyle(node);
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    node.appendChild(probe);
    const background = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      background: style.backgroundColor,
      expected: background,
      shadow: style.boxShadow,
      outline: style.outlineStyle,
    };
  });
  expect(appearance.background).toBe(appearance.expected);
  expect(appearance).toMatchObject({ shadow: "none", outline: "none" });
  expect(
    await page
      .getByTestId("view-toolbar")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe(appearance.expected);
  const sizes = page.getByRole("group", {
    name: "Preview screen size",
    exact: true,
  });
  await expect(
    sizes.getByRole("button", { name: "Web", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await sizes.getByRole("button", { name: "Pad", exact: true }).click();
  await expect(
    sizes.getByRole("button", { name: "Pad", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "More design actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Design system", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("canvas-dark-narrow.png"),
  });
});

test("uses a current-page board without inventing a Blueprint selection", async ({
  page,
}) => {
  await seedCanvas(page, false);
  await expect(
    page.getByTestId("design-canvas").locator("[data-canvas-board]"),
  ).toHaveCount(1);
  await page
    .getByTestId("design-canvas")
    .getByRole("button", { name: "Current page", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("button", { name: "Back to canvas" }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const url = "/src/store/project-design-workspace.ts";
      const { useProjectDesignWorkspaceStore } = await import(url);
      return Object.keys(useProjectDesignWorkspaceStore.getState().selections)
        .length;
    }),
  ).toBe(0);
});

test("zooms around the pointer and supports a two-finger gesture in the phone workspace", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedCanvas(page);
  const canvas = page.getByTestId("design-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const hand = canvas.getByRole("button", { name: "Hand (H)", exact: true });
  await hand.click();
  await hand.press("v");
  await expect(
    canvas.getByRole("button", { name: "Select (V)", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => layout(page)).toBeTruthy();
  const area = await canvas.boundingBox();
  if (!area) throw new Error("Canvas is missing");
  const point = { x: area.width / 2, y: area.height - 120 };
  const camera = () =>
    canvas.evaluate((node) => ({
      x: parseFloat((node as HTMLElement).style.getPropertyValue("--canvas-x")),
      y: parseFloat((node as HTMLElement).style.getPropertyValue("--canvas-y")),
      zoom: Number(
        (node as HTMLElement).style.getPropertyValue("--canvas-zoom"),
      ),
    }));
  const before = await camera();
  await page.mouse.move(area.x + point.x, area.y + point.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => (await camera()).zoom)
    .toBeGreaterThan(before.zoom);
  const after = await camera();
  expect((point.x - after.x) / after.zoom).toBeCloseTo(
    (point.x - before.x) / before.zoom,
    1,
  );
  expect((point.y - after.y) / after.zoom).toBeCloseTo(
    (point.y - before.y) / before.zoom,
    1,
  );
  const cdp = await page.context().newCDPSession(page);
  const center = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: center.x - 45, y: center.y },
      { id: 2, x: center.x + 45, y: center.y },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { id: 1, x: center.x - 75, y: center.y },
      { id: 2, x: center.x + 75, y: center.y },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(async () => (await camera()).zoom)
    .toBeGreaterThan(after.zoom);
  await cdp.detach();
});

test("captures full React page boards and preserves React state across canvas focus", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await seedCanvas(page);
  await page.evaluate(async () => {
    const storeUrl = "/src/store/conversation.ts";
    const toolsUrl = "/src/lib/tools/fs-tools.ts";
    const { useConversationStore } = await import(storeUrl);
    const { fsInitProject } = await import(toolsUrl);
    const initialized = await fsInitProject("vite-react-ts");
    if (!initialized.newFiles) throw new Error(initialized.result);
    const app = `import { useEffect, useState } from "react";
      export default function App() {
        const [library,setLibrary] = useState(location.hash.includes('library'));
        const [count,setCount] = useState(0);
        useEffect(()=>{const update=()=>setLibrary(location.hash.includes('library'));addEventListener('hashchange',update);return()=>removeEventListener('hashchange',update)},[]);
        return <main style={{minHeight:library?2300:1600,padding:64,boxSizing:'border-box'}}><p>COMMON GROUND / REACT</p><h1>{library?'React Library':'React Home'}</h1><button onClick={()=>setCount(count+1)}>Count {count}</button><section style={{marginTop:100,height:420,background:'#e0ebe5',padding:48}}>Selected stories</section></main>
      }`;
    const state = useConversationStore.getState();
    const blueprint =
      state.conversations[state.activeId].files["design-project.json"];
    const result = state.replaceProject({
      files: {
        ...initialized.newFiles,
        "App.tsx": app,
        "styles.css":
          "html,body,#root{margin:0;min-height:100%;font:18px system-ui;background:#f8faf8;color:#1f382b}h1{font-size:72px;font-weight:500;letter-spacing:-2px}button{padding:12px 20px;border:1px solid #9fb8a9;background:transparent;border-radius:6px}",
        "design-project.json": blueprint,
      },
      template: "vite-react-ts",
      previewMode: "sandpack",
      activeFile: "App.tsx",
    });
    if (!result.ok) throw new Error(result.error);
    useConversationStore.getState().setWorkspaceMode("design");
  });
  const canvas = page.getByTestId("design-canvas");
  for (const id of ["home", "library"])
    await expect(canvas.locator(`[data-canvas-board="${id}"]`)).toHaveAttribute(
      "data-preview-status",
      "ready",
      { timeout: 90_000 },
    );
  expect(
    await canvas
      .locator('[data-canvas-board="library"]')
      .evaluate((node) => (node as HTMLElement).offsetHeight),
  ).toBeGreaterThan(2000);
  await canvas.getByRole("button", { name: "Library", exact: true }).dblclick();
  const frame = page.frameLocator(".sp-preview-iframe");
  await expect(
    frame.getByRole("heading", { name: "React Library" }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Count 0", exact: true }).click();
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await canvas
    .getByRole("button", { name: "Library", exact: true })
    .press("Enter");
  await expect(
    frame.getByRole("button", { name: "Count 1", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to canvas" }).click();
  await canvas.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("react-canvas.png"),
  });
});

test("opens selected board code without a project design dialog", async ({
  page,
}) => {
  await seedCanvas(page);
  const canvas = page.getByTestId("design-canvas");
  const download = page.getByRole("button", {
    name: "Download project",
    exact: true,
  });
  await expect(download).toHaveCount(0);
  await canvas.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(download).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("COMMON GROUND");
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await expect(download).toHaveCount(0);
  await expect(canvas.locator('[data-canvas-board="library"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await canvas.getByRole("button", { name: "Draft", exact: true }).click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "No source file is available for this page." }),
  ).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Project design", exact: true }),
  ).toHaveCount(0);
});
