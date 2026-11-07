import { expect, test, type Page } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

async function openCatalog(page: Page) {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const settingsUrl = "/src/store/settings/index.ts";
    const conversationUrl = "/src/store/conversation.ts";
    const { useSettingsStore } = await import(settingsUrl);
    const { useConversationStore } = await import(conversationUrl);
    useSettingsStore.setState((state: { system: Record<string, unknown> }) => ({
      system: { ...state.system, language: "en" },
    }));
    useConversationStore.getState().setWorkspaceMode("design");
  });
  await page.getByRole("button", { name: /^Design system: Auto/ }).click();
  return page.getByRole("dialog", { name: "Design systems" });
}

async function addUserSystems(page: Page) {
  await page.evaluate(async () => {
    const registryUrl = "/src/lib/design-systems/registry.ts";
    const validationUrl = "/src/lib/design-systems/validation.ts";
    const { getDesignSystemRegistry } = await import(registryUrl);
    const { validateDesignSystemPackage } = await import(validationUrl);
    const tokens = await fetch("/design-systems/claude/tokens.css").then((r) =>
      r.text(),
    );
    for (const source of ["imported", "custom"] as const) {
      const id = `${source}-catalog-check`;
      const pkg = await validateDesignSystemPackage(
        [
          {
            path: "manifest.json",
            content: JSON.stringify({
              schemaVersion: "open-builder-design-system/v1",
              id,
              name: `Catalog check ${source}`,
              source: { kind: source },
              files: { design: "DESIGN.md", tokens: "tokens.css" },
            }),
          },
          { path: "DESIGN.md", content: "# Catalog check\nUse tokens.css." },
          { path: "tokens.css", content: tokens },
        ],
        { source, version: "catalog-e2e" },
      );
      await getDesignSystemRegistry().confirmImport(pkg);
    }
  });
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`searches and pages through real design packages on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const dialog = await openCatalog(page);
    const search = dialog.getByRole("textbox", {
      name: "Search design systems",
    });
    const cards = dialog.locator("button:has(img)");
    const next = dialog.getByRole("button", { name: "Next page", exact: true });
    const scroll = dialog.getByTestId("design-system-scroll-region");
    await expect(dialog.getByText("36 systems · page 1 of 4")).toBeVisible();

    const seen: string[] = [];
    for (let current = 1; current <= 4; current++) {
      await expect(cards).toHaveCount(9);
      seen.push(
        ...(await cards
          .locator("img")
          .evaluateAll((images) =>
            images.map((image) => image.getAttribute("src") ?? ""),
          )),
      );
      await expect(search).toBeInViewport();
      await expect(next).toBeInViewport();
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(search).toBeInViewport();
      await expect(next).toBeInViewport();
      if (current < 4) {
        await next.click();
        await expect(
          dialog.getByText(`Page ${current + 1} of 4`, { exact: true }),
        ).toBeVisible();
        await expect
          .poll(() => scroll.evaluate((element) => element.scrollTop))
          .toBe(0);
        if (current < 3) await expect(next).toBeFocused();
      }
    }
    expect(new Set(seen).size).toBe(36);
    await expect(next).toBeDisabled();

    await search.fill("  磁带   机械  ");
    await expect(cards).toHaveCount(1);
    await expect(
      dialog.getByRole("button", { name: /Cassette Futurism/ }),
    ).toBeVisible();
    await search.fill("FELT skeuomorphism");
    await expect(cards).toHaveCount(1);
    await expect(cards.locator("img")).toHaveJSProperty("naturalWidth", 640);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-felt.png`),
    });
    await search.fill("no-such-style-xyz");
    await expect(
      dialog.getByText("No design systems match this search."),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Clear search", exact: true })
      .first()
      .click();
    await expect(search).toBeFocused();
    await expect(cards).toHaveCount(9);

    await page.keyboard.press("Escape");
    await addUserSystems(page);
    await page.getByRole("button", { name: /^Design system: Auto/ }).click();
    await search.fill("catalog check");
    await expect(cards).toHaveCount(2);
    await expect(
      dialog.getByRole("heading", { name: "Custom systems", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Imported systems", exact: true }),
    ).toBeVisible();
    await expect(cards.first()).toContainText("Catalog check custom");

    await search.fill("任务控制");
    await dialog.getByRole("button", { name: /Mission Control/ }).click();
    await expect(dialog).not.toBeVisible();
    const selected = await page.evaluate(async () => {
      const conversationUrl = "/src/store/conversation.ts";
      const { useConversationStore } = await import(conversationUrl);
      const state = useConversationStore.getState();
      return state.conversations[state.activeId!].designState;
    });
    expect(selected.selectedSystem).toMatchObject({
      id: "mission-control",
      source: "builtin",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(selected.appliedSystem).toBeUndefined();
  });
}
