import { expect, test, type Page } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

async function seedBlueprintState(
  page: Page,
  status: "missing" | "invalid" | "draft",
) {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async (status) => {
    const storeUrl = "/src/store/conversation.ts";
    const settingsUrl = "/src/store/settings/index.ts";
    const { useConversationStore } = await import(storeUrl);
    const { useSettingsStore } = await import(settingsUrl);
    useSettingsStore.setState((state: { system: object }) => ({
      system: { ...state.system, language: "zh", theme: "light" },
    }));
    const files: Record<string, string> = {
      "index.html": "<!doctype html><html><body>Prototype</body></html>",
      "package.json": JSON.stringify({
        openBuilder: { profile: "complete-prototype", schemaVersion: 1 },
      }),
    };
    if (status === "invalid") files["design-project.json"] = "{";
    if (status === "draft")
      files["design-project.json"] = JSON.stringify({
        schemaVersion: "open-builder-design-project/v2",
        revision: 1,
        pages: [
          {
            id: "home",
            name: "首页",
            route: "#/首页/",
            filePaths: ["index.html"],
          },
          { id: "detail", name: "详情", route: "/items/[id]" },
        ],
      });
    const state = useConversationStore.getState();
    const result = state.replaceProject({
      files,
      template: "static",
      previewMode: "sandpack",
      activeFile: "index.html",
    });
    if (!result.ok) throw new Error(result.error);
    useConversationStore.getState().setWorkspaceMode("design");
  }, status);
  await expect(page.getByTestId("project-design-sidebar")).toBeVisible();
}

test("keeps draft selection and navigates a complete Unicode page without a contract", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedBlueprintState(page, "draft");
  const sidebar = page.getByTestId("project-design-sidebar");
  const selection = () =>
    page.evaluate(async () => {
      const url = "/src/store/project-design-workspace.ts";
      const { useProjectDesignWorkspaceStore } = await import(url);
      return Object.values(
        useProjectDesignWorkspaceStore.getState().selections,
      )[0];
    });
  await expect
    .poll(selection)
    .toMatchObject({ pageId: "home", explicit: false });
  const home = sidebar.locator(
    '[data-page-id="home"] [data-preview-available]',
  );
  await home.click();
  await expect
    .poll(selection)
    .toMatchObject({ pageId: "home", explicit: true });
  const frame = page.frameLocator(".sp-preview-iframe");
  await expect
    .poll(() => frame.locator("html").evaluate(() => location.hash))
    .toBe("#/%E9%A6%96%E9%A1%B5?scenario=default");
  const draft = sidebar.locator(
    '[data-page-id="detail"] [data-preview-available]',
  );
  await expect(draft).toHaveAttribute("data-preview-available", "false");
  await draft.click();
  await expect(draft).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(selection)
    .toMatchObject({ pageId: "detail", scenarioId: "default", explicit: true });
  // A real preview notification must not replace an explicitly selected draft.
  await frame
    .locator("html")
    .evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
  await expect(draft).toHaveAttribute("aria-selected", "true");
  await expect(home).toHaveAttribute("data-preview-available", "true");
  await home.click();
  await expect(home).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page
        .frameLocator(".sp-preview-iframe")
        .locator("html")
        .evaluate(() => location.hash),
    )
    .toBe("#/%E9%A6%96%E9%A1%B5?scenario=default");
  expect(
    await page.evaluate(async () => {
      const url = "/src/store/conversation.ts";
      const { useConversationStore } = await import(url);
      const state = useConversationStore.getState();
      return JSON.parse(
        state.conversations[state.activeId].files["design-project.json"],
      ).revision;
    }),
  ).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("draft-blueprint.png") });
});

for (const status of ["missing", "invalid"] as const) {
  test(`keeps the ${status} blueprint state compact when collapsed`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedBlueprintState(page, status);
    const sidebar = page.getByTestId("project-design-sidebar");
    const state = sidebar.locator(`[data-blueprint-status="${status}"]`);
    await expect(state).toBeVisible();
    const toggle = page.getByTestId("project-design-collapse");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect
      .poll(() => state.evaluate((node) => node.getBoundingClientRect().height))
      .toBeLessThan(64);
    expect(
      await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${status}-collapsed.png`),
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(state.locator("p").first()).toBeVisible();
    expect(
      await state
        .locator("p")
        .first()
        .evaluate((node) => node.parentElement!.clientWidth),
    ).toBeGreaterThan(100);

    // Desktop collapse must not squeeze the full-width mobile drawer.
    await toggle.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByTestId("project-design-navigator")
      .locator(":scope > button")
      .first()
      .click();
    await expect(state.locator("p").first()).toBeVisible();
    expect(
      await state
        .locator("p")
        .first()
        .evaluate((node) => node.parentElement!.clientWidth),
    ).toBeGreaterThan(100);
    expect(
      await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  });
}
