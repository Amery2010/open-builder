import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

test("shows preview notices in the global shadcn toaster across themes and narrow screens", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const settingsUrl = "/src/store/settings/index.ts";
    const conversationUrl = "/src/store/conversation.ts";
    const { useSettingsStore } = await import(settingsUrl);
    const { useConversationStore } = await import(conversationUrl);
    useSettingsStore.setState((state: { system: object }) => ({
      system: { ...state.system, language: "en", theme: "dark" },
    }));
    const result = useConversationStore.getState().replaceProject({
      files: { "index.html": "<h1>Code-only project</h1>" },
      template: "static",
      previewMode: "code-only",
      activeFile: "index.html",
    });
    if (!result.ok) throw new Error(result.error);
  });

  const notice = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "This project uses code mode" });
  const toaster = page.locator("[data-sonner-toaster]");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCSS("opacity", "1");
  await expect(notice).toHaveAttribute("data-type", "info");
  await expect(toaster).toHaveAttribute("data-sonner-theme", "dark");
  await expect(page.locator(".editor [data-sonner-toast]")).toHaveCount(0);
  await expect(page.locator("[data-preview-compilation]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("toast-dark.png") });

  await page.evaluate(async () => {
    const settingsUrl = "/src/store/settings/index.ts";
    const { useSettingsStore } = await import(settingsUrl);
    useSettingsStore.setState((state: { system: object }) => ({
      system: { ...state.system, theme: "light" },
    }));
  });
  await expect(toaster).toHaveAttribute("data-sonner-theme", "light");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toHaveCount(0);
  await page.evaluate(async () => {
    const fixtureUrl = "/e2e/helpers/desktop-preview-fixture.ts";
    const { mountCodeOnlyPreviewNotice } = await import(fixtureUrl);
    mountCodeOnlyPreviewNotice();
  });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCSS("opacity", "1");
  await expect
    .poll(async () => {
      const bounds = await notice.boundingBox();
      return bounds ? bounds.y + bounds.height <= 844 : false;
    })
    .toBe(true);
  const bounds = await notice.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("toast-mobile.png") });
  await notice.getByRole("button", { name: "Close notification" }).click();
  await expect(notice).toHaveCount(0);
});
