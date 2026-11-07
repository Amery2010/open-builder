import { test, expect } from "@playwright/test";

for (const template of ["static", "vite-react-ts"]) {
  test(`validates ${template} in an isolated preview and cleans it up`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.route("**/__runtime_test__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      }),
    );
    await page.goto("/__runtime_test__");
    const result = await page.evaluate(async (name) => {
      // @ts-expect-error Vite browser module
      const { validateProjectRuntime } =
        await import("/src/lib/project-runtime/index.ts");
      // @ts-expect-error Vite browser dependency
      const { SANDBOX_TEMPLATES } =
        await import("/node_modules/.vite/deps/@codesandbox_sandpack-react.js");
      // @ts-expect-error Vite browser module
      const { applyOpenBuilderTemplateProfile } =
        await import("/src/lib/tools/sandpack-template-manifest.ts");
      const files = Object.fromEntries(
        Object.entries(
          SANDBOX_TEMPLATES[name].files as Record<
            string,
            string | { code: string }
          >,
        ).map(([path, file]) => [
          path.replace(/^\//, ""),
          typeof file === "string" ? file : file.code,
        ]),
      );
      applyOpenBuilderTemplateProfile(name, files);
      const before = JSON.stringify(files);
      const validation = await validateProjectRuntime({
        files,
        signal: new AbortController().signal,
      });
      return {
        validation,
        unchanged: before === JSON.stringify(files),
        frames: document.querySelectorAll(
          'iframe[title="Project import verification"]',
        ).length,
      };
    }, template);
    expect(result.validation.previewMode).toBe("sandpack");
    expect(result.validation.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.unchanged).toBe(true);
    expect(result.frames).toBe(0);
  });
}

test("does not grant a successful verification for broken source", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.route("**/__runtime_test__", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/__runtime_test__");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { validateProjectRuntime } =
      await import("/src/lib/project-runtime/index.ts");
    try {
      await validateProjectRuntime({
        files: {
          "index.html": '<script type="module" src="/app.js"></script>',
          "app.js": 'import missing from "./missing-file.js";',
        },
        signal: new AbortController().signal,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, kind: (error as { kind?: string }).kind };
    }
  });
  expect(result.ok).toBe(false);
});
