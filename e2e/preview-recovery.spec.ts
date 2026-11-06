import { expect, test, type Page } from "@playwright/test";
import { waitForAppReady } from "./helpers/app-ready";

const previewFiles = {
  "index.html": `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>html,body{margin:0;background:#181818;color:#eee;font-family:system-ui}main{min-height:100vh;padding:24px;box-sizing:border-box}</style>
    </head><body><main><h1>Preview recovery fixture</h1>
    <button onclick="console.log('Plain console output', {count:123});console.warn('Warning output');console.error('Error output')">Write logs</button>
    </main></body></html>`,
};

async function seedPreview(page: Page, design = false): Promise<void> {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(
    async ({ files, design }) => {
      const conversationUrl = "/src/store/conversation.ts";
      const settingsUrl = "/src/store/settings/index.ts";
      const { useConversationStore } = await import(conversationUrl);
      const { useSettingsStore } = await import(settingsUrl);
      useSettingsStore.setState(
        (state: { system: Record<string, unknown> }) => ({
          system: { ...state.system, language: "en", theme: "dark" },
        }),
      );
      const state = useConversationStore.getState();
      const id = state.createConversation();
      state.switchConversation(id);
      const result = state.replaceProject({
        files,
        template: "static",
        previewMode: "sandpack",
        activeFile: "index.html",
      });
      if (!result.ok) throw new Error(result.error);
      if (design) useConversationStore.getState().setWorkspaceMode("design");
    },
    { files: previewFiles, design },
  );
  await expect(
    page.frameLocator(".sp-preview-iframe").getByRole("heading", {
      name: "Preview recovery fixture",
    }),
  ).toBeVisible({ timeout: 60_000 });
}

for (const runtime of ["static", "parcel"] as const) {
  test(`loads screenshot runtime before capturing actual desktop and mobile viewports (${runtime})`, async ({
    page,
  }) => {
    if (runtime === "parcel") {
      await page.addInitScript(() => {
        const encode = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
          return encode.call(
            this,
            type === "image/webp" ? "image/png" : type,
            quality,
          );
        };
      });
      // Exercise the desktop renderer without enabling native filesystem tools.
      await page.route("**/src/lib/design/desktop.ts*", async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        expect(source).toContain("return isTauriMcpHost();");
        await route.fulfill({
          response,
          body: source.replace("return isTauriMcpHost();", "return true;"),
        });
      });
    }
    await seedPreview(page, true);
    const result = await page.evaluate(async () => {
      const conversationUrl = "/src/store/conversation.ts";
      const evidenceUrl = "/src/lib/design/preview-evidence.ts";
      const { useConversationStore } = await import(conversationUrl);
      const { capturePreviewEvidence } = await import(evidenceUrl);
      const state = useConversationStore.getState();
      const conversation = state.conversations[state.activeId!];
      const output = await capturePreviewEvidence({
        conversationId: conversation.id,
        files: conversation.files,
        template: conversation.template,
        previewMode: "sandpack",
        viewports: ["desktop", "mobile"],
      });
      return output.structuredContent as {
        status: string;
        errors: string[];
        evidence: Array<{
          view: string;
          image: { mimeType: string };
          viewport: { width: number; height: number };
        }>;
      };
    });
    expect(result.errors).toEqual([]);
    expect(result.status).toBe("complete");
    expect(result.evidence.map((item) => item.view)).toEqual([
      "desktop",
      "mobile",
    ]);
    expect(result.evidence[0].viewport.width).toBeGreaterThanOrEqual(1024);
    expect(result.evidence[1].viewport.width).toBeLessThan(768);
    expect(result.evidence.every((item) => item.viewport.height > 0)).toBe(
      true,
    );
    if (runtime === "parcel") {
      expect(
        result.evidence.every((item) => item.image.mimeType === "image/png"),
      ).toBe(true);
    }
  });
}

test("keeps mobile content full width and console readable across theme and scale changes", async ({
  page,
}) => {
  await seedPreview(page);
  const frame = page.frameLocator(".sp-preview-iframe");
  await page.getByRole("button", { name: "Mobile", exact: true }).click();
  await expect
    .poll(() =>
      page.locator(".sp-preview-iframe").evaluate((node) => node.clientWidth),
    )
    .toBe(375);
  await page.getByRole("button", { name: "Show Console", exact: true }).click();
  await frame.getByRole("button", { name: "Write logs" }).click();
  await expect(
    page.locator(".sp-console").getByText('"Plain console output"'),
  ).toBeVisible();

  for (const theme of ["light", "dark"]) {
    await page.evaluate(async (theme) => {
      const settingsUrl = "/src/store/settings/index.ts";
      const { useSettingsStore } = await import(settingsUrl);
      useSettingsStore.setState(
        (state: { system: Record<string, unknown> }) => ({
          system: { ...state.system, theme },
        }),
      );
    }, theme);
    await expect
      .poll(() =>
        page
          .locator(".sp-console")
          .evaluate((node) => getComputedStyle(node).colorScheme),
      )
      .toBe(theme);
    const textColor = await page
      .locator(".sp-console code")
      .first()
      .evaluate((node) => getComputedStyle(node).color);
    expect(textColor).not.toBe(
      theme === "dark" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
    );
    await page
      .getByRole("button", { name: "Zoom out preview", exact: true })
      .click();
    await expect(
      page.locator(".sp-console").getByText('"Plain console output"'),
    ).toBeVisible();
  }
});

test("shows the latest rapid edit with assets and rebuilds from either reload control", async ({
  page,
}) => {
  await seedPreview(page);
  await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const assetsUrl = "/src/lib/project-assets/core.ts";
    const { useConversationStore } = await import(conversationUrl);
    const assets = await import(assetsUrl);
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const staged = await assets.stageProjectAsset(
      "public/pixel.png",
      new Blob([bytes], { type: "image/png" }),
    );
    const asset = assets.createProjectAssetRecord(
      staged,
      await assets.storeStagedProjectAsset(staged),
    );
    const state = useConversationStore.getState();
    state.setAssetsForConversation(state.activeId!, {
      "public/pixel.png": asset,
    });
  });
  const preview = page.locator(".sp-preview-iframe");
  const mountedFrame = await preview.elementHandle();
  await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const { useConversationStore } = await import(conversationUrl);
    const source =
      useConversationStore.getState().conversations[
        useConversationStore.getState().activeId!
      ].files["index.html"];
    for (let i = 0; i < 12; i += 1) {
      useConversationStore.getState().setFiles({
        "index.html": source.replace(
          "Preview recovery fixture",
          `Rapid edit ${i}`,
        ),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  await expect(
    page
      .frameLocator(".sp-preview-iframe")
      .getByRole("heading", { name: "Rapid edit 11" }),
  ).toBeVisible({ timeout: 60_000 });
  expect(await mountedFrame!.evaluate((node) => node.isConnected)).toBe(true);
  for (const index of [0, 1]) {
    const beforeReload = await preview.elementHandle();
    await page
      .getByRole("button", { name: "Reload preview", exact: true })
      .nth(index)
      .click();
    await expect
      .poll(() => beforeReload!.evaluate((node) => node.isConnected))
      .toBe(false);
    await expect(
      page
        .frameLocator(".sp-preview-iframe")
        .getByRole("heading", { name: "Rapid edit 11" }),
    ).toBeVisible({ timeout: 60_000 });
  }
});

test("animates conversation details in both directions and removes closed content", async ({
  page,
}) => {
  await page.goto("/");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const conversationUrl = "/src/store/conversation.ts";
    const settingsUrl = "/src/store/settings/index.ts";
    const { useConversationStore } = await import(conversationUrl);
    const { useSettingsStore } = await import(settingsUrl);
    useSettingsStore.setState((state: { system: Record<string, unknown> }) => ({
      system: { ...state.system, language: "en" },
    }));
    const state = useConversationStore.getState();
    state.createConversation();
    state.setMessages([
      { role: "user", content: "Inspect the file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "animated-tool",
            type: "function",
            function: {
              name: "patch_file",
              arguments: '{"path":"index.html"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "animated-tool",
        content: "Animated tool details",
      },
      { role: "assistant", content: "Inspection complete" },
    ]);
  });
  const trigger = page.locator('[data-slot="collapsible-trigger"]').first();
  await trigger.click();
  const content = page.locator('[data-slot="collapsible-content"]').first();
  await expect(content).toHaveCSS("animation-name", "chat-expand");
  await expect(content.getByText("Animated tool details")).toBeVisible();
  await content.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  await trigger.click();
  await expect(content).toHaveAttribute("inert");
  await expect(content).toHaveCSS("animation-name", "chat-collapse");
  await expect(content.getByText("Animated tool details")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect(content).toHaveCSS("animation-duration", "1e-05s");
  await trigger.click();
  await expect(content.getByText("Animated tool details")).toHaveCount(0);
});
