import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { waitForAppReady } from "./helpers/app-ready";

test("previews standalone HTML using the desktop Parcel configuration", async ({
  page,
}) => {
  await page.route("**/__desktop_preview_test__", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><script type="module">
        import RefreshRuntime from "/@react-refresh";
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script></head><body><div id="root"></div><script type="module">
        import { mountDesktopStaticPreview } from "/e2e/helpers/desktop-preview-fixture.ts";
        mountDesktopStaticPreview();
      </script></body></html>`,
    }),
  );
  await page.goto("/__desktop_preview_test__");
  await expect(
    page.locator('[data-sonner-toast][data-type="success"]'),
  ).toBeVisible();
  await expect(page.locator("[data-preview-compilation]")).toHaveCount(0);
  await expect(
    page
      .frameLocator(".sp-preview-iframe")
      .getByRole("heading", { name: "Desktop static source" }),
  ).toBeVisible();
  await expect(
    page.locator('iframe[title="Project import verification"]'),
  ).toHaveCount(0);
});

for (const project of ["static", "vite-react", "broken-source"]) {
  test(`imports ${project} locally when Sandpack is unreachable`, async ({
    page,
  }) => {
    const sandpackRequests: string[] = [];
    await page.route(
      /https:\/\/.*(?:sandpack|codesandbox|csb\.app)/,
      (route) => {
        sandpackRequests.push(route.request().url());
        return route.abort();
      },
    );
    await page.goto("/");
    await waitForAppReady(page);
    const original = await page.evaluate(async () => {
      const { useSettingsStore: settings } =
        await import("/src/store/settings/index.ts");
      settings.setState((state) => ({
        system: { ...state.system, language: "en" },
      }));
      const { useConversationStore: store } =
        await import("/src/store/conversation.ts");
      return {
        id: store.getState().activeId!,
        count: Object.keys(store.getState().conversations).length,
      };
    });
    const zip = new JSZip();
    zip.file(
      "demo/index.html",
      '<!doctype html><html><body><h1>Imported source</h1><script type="module" src="/app.js"></script></body></html>',
    );
    zip.file(
      "demo/app.js",
      project === "broken-source"
        ? 'import missing from "./missing-file.js";'
        : 'console.log("imported");',
    );
    zip.file(
      "demo/public/pixel.gif",
      Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    );
    if (project === "vite-react") {
      zip.file(
        "demo/package.json",
        JSON.stringify({
          dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
          devDependencies: { vite: "4.2.0" },
          scripts: { dev: "vite" },
        }),
      );
    }
    await page
      .getByRole("button", { name: "Add attachment", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Upload project", exact: true })
      .click();
    await page.locator('input[accept*="application/zip"]').setInputFiles({
      name: `${project}.zip`,
      mimeType: "application/zip",
      buffer: await zip.generateAsync({ type: "nodebuffer" }),
    });
    await expect(
      page.getByText("Checked and ready to import", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('iframe[title="Project import verification"]'),
    ).toHaveCount(0);
    expect(sandpackRequests).toHaveLength(0);
    await page
      .getByRole("button", { name: "Import project", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Upload Project" }),
    ).toHaveCount(0);
    const state = await page.evaluate(async () => {
      const { useConversationStore: store } =
        await import("/src/store/conversation.ts");
      const state = store.getState();
      const current = state.conversations[state.activeId!];
      return {
        id: state.activeId,
        count: Object.keys(state.conversations).length,
        files: current.files,
        assets: current.assets,
        mode: current.previewMode,
      };
    });
    expect(state.id).not.toBe(original.id);
    expect(state.count).toBe(original.count + 1);
    expect(state.mode).toBe("sandpack");
    expect(state.files["app.js"]).toContain(
      project === "broken-source" ? "missing-file.js" : "imported",
    );
    expect(state.assets?.["public/pixel.gif"].mimeType).toBe("image/gif");
  });
}
