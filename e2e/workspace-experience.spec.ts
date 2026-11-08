import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

for (const { theme, language, width } of [
  { theme: "light", language: "zh", width: 1280 },
  { theme: "dark", language: "en", width: 1100 },
] as const) {
  test(`offers editable starter prompts in ${language} with ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await waitForAppReady(page);
    await page.evaluate(
      async ({ theme, language }) => {
        const { useSettingsStore } =
          await import("/src/store/settings/index.ts");
        useSettingsStore.setState((state) => ({
          system: { ...state.system, theme, language },
          ai: {
            ...state.ai,
            runtime: "api",
            apiType: "openai-compatible",
            apiBaseUrl: "http://127.0.0.1:9/v1",
            apiKey: "test-only",
            model: "test",
          },
        }));
      },
      { theme, language },
    );
    const chinese = language === "zh";
    const suggestions = page.getByRole("group", {
      name: chinese ? "快捷建议" : "Quick suggestions",
    });
    await expect(suggestions).toBeVisible();
    await expect(suggestions.getByRole("button")).toHaveCount(3);
    expect(
      await suggestions.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`onboarding-${theme}.png`),
    });
    await suggestions
      .getByRole("button", {
        name: chinese ? /个人作品集/ : /Personal portfolio/,
      })
      .click();
    const input = page.getByPlaceholder(
      chinese ? "一句话描述你想要的应用..." : "Describe the app you want...",
    );
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(
      chinese
        ? /包含个人介绍、作品展示和联系方式/
        : /a personal introduction, a project showcase, and contact details/,
    );
    const state = await page.evaluate(async () => {
      const { useConversationStore } =
        await import("/src/store/conversation.ts");
      const store = useConversationStore.getState();
      return store.conversations[store.activeId!];
    });
    expect(state.messages).toHaveLength(0);
    expect(state.workspaceMode).toBe("auto");
    await page
      .getByRole("button", {
        name: chinese ? "打开项目起始库" : "Open project starters",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
}

test("opens a single non-root design page directly and restores canvas only for multiple pages", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForAppReady(page);
  const blueprint = {
    schemaVersion: "open-builder-design-project/v3",
    revision: 1,
    pages: [
      { id: "menu", name: "Menu", route: "/menu", filePaths: ["index.html"] },
    ],
  };
  await page.evaluate(async (blueprint) => {
    const { useConversationStore } = await import("/src/store/conversation.ts");
    const { useSettingsStore } = await import("/src/store/settings/index.ts");
    useSettingsStore.setState((state) => ({
      system: { ...state.system, language: "en", theme: "light" },
    }));
    const store = useConversationStore.getState();
    const result = store.replaceProject({
      template: "static",
      previewMode: "sandpack",
      activeFile: "index.html",
      files: {
        "index.html":
          '<!doctype html><html><head><style>body{margin:0;font:20px system-ui;background:#f8fafc;color:#1e293b}main{padding:48px}</style></head><body><main><h1></h1><input aria-label="Page draft" value="original"></main><script>function render(){document.querySelector("h1").textContent="Page "+location.hash}window.addEventListener("hashchange",render);render();</script></body></html>',
        "design-project.json": JSON.stringify(blueprint),
      },
    });
    if (!result.ok) throw new Error(result.error);
    useConversationStore.getState().setWorkspaceMode("design");
  }, blueprint);
  const toolbar = page.getByTestId("view-toolbar");
  await expect(
    toolbar.getByRole("button", { name: "Preview", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("design-canvas")).toHaveCount(0);
  const frame = page.frameLocator(".sp-preview-iframe");
  await expect(
    frame.getByRole("heading", { name: "Page #/menu", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await frame
    .getByRole("textbox", { name: "Page draft" })
    .fill("keep my input");
  await toolbar.getByRole("button", { name: "Code", exact: true }).click();
  await toolbar.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(frame.getByRole("textbox", { name: "Page draft" })).toHaveValue(
    "keep my input",
  );

  await page.evaluate(async () => {
    const { useConversationStore } = await import("/src/store/conversation.ts");
    const store = useConversationStore.getState();
    const files = store.conversations[store.activeId!].files;
    const design = JSON.parse(files["design-project.json"]);
    design.pages.push({ id: "draft", name: "Draft page" });
    store.setFiles({ ...files, "design-project.json": JSON.stringify(design) });
  });
  const canvas = page.getByTestId("design-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas.locator("[data-canvas-board]")).toHaveCount(2);
  await expect(canvas.getByRole("img")).toBeVisible({ timeout: 60_000 });
  const board = canvas.locator('[data-canvas-board="menu"]');
  await board.getByRole("button", { name: "Menu", exact: true }).press("Space");
  const border = await board.evaluate((element) => {
    const zoom = Number(
      getComputedStyle(element).getPropertyValue("--canvas-zoom"),
    );
    const style = getComputedStyle(element, "::after");
    return {
      width: Number([...style.boxShadow.matchAll(/([\d.]+)px/g)][3][1]) * zoom,
      radius: parseFloat(style.borderRadius) * zoom,
      outlineOffset: style.outlineOffset,
    };
  });
  expect(border.width).toBeCloseTo(1, 1);
  expect(border.radius).toBeCloseTo(10, 1);
  expect(border.outlineOffset).toBe("0px");
  await page.screenshot({
    path: testInfo.outputPath("selected-canvas-board.png"),
  });
  await page.evaluate(async (blueprint) => {
    const { useConversationStore } = await import("/src/store/conversation.ts");
    const store = useConversationStore.getState();
    store.setFiles({
      ...store.conversations[store.activeId!].files,
      "design-project.json": JSON.stringify(blueprint),
    });
  }, blueprint);
  await expect(canvas).toHaveCount(0);
  await expect(
    toolbar.getByRole("button", { name: "Preview", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const { useConversationStore } =
        await import("/src/store/conversation.ts");
      const store = useConversationStore.getState();
      return store.conversations[store.activeId!].workspaceMode;
    }),
  ).toBe("design");
});
