import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const templates = [
  "vite",
  "vite-react",
  "vite-react-ts",
  "vite-preact",
  "vite-preact-ts",
  "vite-vue",
  "vite-vue-ts",
  "vite-svelte",
  "vite-svelte-ts",
];

for (const template of templates) {
  test(`deploys ${template} from its downloaded build ZIP`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.route("**/__runtime_test__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      }),
    );
    await page.goto("/__runtime_test__");
    const artifact = await page.evaluate(async (name) => {
      // @ts-expect-error Vite serves source modules in the browser.
      const { buildStaticDeployment } =
        await import("/src/lib/project-build/index.ts");
      // @ts-expect-error Vite serves source modules in the browser.
      const { SANDBOX_TEMPLATES } =
        await import("/node_modules/.vite/deps/@codesandbox_sandpack-react.js");
      // @ts-expect-error Vite serves source modules in the browser.
      const { applyOpenBuilderTemplateProfile } =
        await import("/src/lib/tools/sandpack-template-manifest.ts");
      const source = SANDBOX_TEMPLATES[name];
      const files = Object.fromEntries(
        Object.entries(
          source.files as Record<string, string | { code: string }>,
        ).map(([key, value]) => [
          key.replace(/^\//, ""),
          typeof value === "string" ? value : value.code,
        ]),
      );
      applyOpenBuilderTemplateProfile(name, files);
      const assets: Record<string, unknown> = {};
      if (name === "vite-react-ts") {
        // Exercise the asset emitter rather than Vite's <4KiB data-URL path.
        const png = Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPd8AAAAASUVORK5CYII=",
          ),
          (character) => character.charCodeAt(0),
        );
        const largePng = new Uint8Array(png.length + 6_000);
        largePng.set(png);
        // @ts-expect-error Vite serves source modules in the browser.
        const {
          stageProjectAsset,
          storeStagedProjectAsset,
          createProjectAssetRecord,
        } = await import("/src/lib/project-assets/core.ts");
        const staged = await stageProjectAsset(
          "src/deployment-image.png",
          new Blob([largePng], { type: "image/png" }),
        );
        const blobRef = await storeStagedProjectAsset(staged);
        assets[staged.path] = createProjectAssetRecord(staged, blobRef);
        files["index.html"] +=
          '<script type="module" src="/deployment-probe.js"></script>';
        files["deployment-probe.js"] =
          'import "./deployment-probe.css"; import image from "./src/deployment-image.png"; import { title as first } from "./deployment-large-a.tsx"; import { title as second } from "./deployment-large-b.tsx"; const heading = document.createElement("h2"); heading.id = "large-modules"; heading.textContent = first + second; document.body.append(heading); const img = new Image(); img.id = "deployment-image"; img.src = image; document.body.append(img); import("./deployment-lazy.js").then(module => module.ready());';
        // Exercise concurrent esbuild packets beyond Nodebox's stdin read buffer.
        for (const [name, title] of [
          ["a", "Large "],
          ["b", "modules compiled"],
        ]) {
          files[`deployment-large-${name}.tsx`] =
            `/*${"padding".repeat(5_000)}*/\nexport const title = ${JSON.stringify(title)};`;
        }
        files["deployment-lazy.js"] =
          'export function ready() { document.body.dataset.deploymentProbe = "ready"; }';
        files["deployment-probe.css"] =
          'body { background-image: url("./src/deployment-image.png"); }';
        files["public/deployment-probe.svg"] =
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="white"/></svg>';
      }
      const result = await buildStaticDeployment({
        files,
        assets,
        signal: new AbortController().signal,
      });
      // @ts-expect-error Vite serves dependencies in the browser.
      const { default: JSZip } =
        await import("/node_modules/.vite/deps/jszip.js");
      const zip = await JSZip.loadAsync(result.blob);
      const entries: Array<{ path: string; bytes: number[] }> = [];
      for (const entry of Object.values(zip.files) as Array<{
        dir: boolean;
        name: string;
        async: (type: string) => Promise<Uint8Array>;
      }>) {
        if (!entry.dir)
          entries.push({
            path: entry.name,
            bytes: Array.from(await entry.async("uint8array")),
          });
      }
      return {
        files: entries,
        mode: result.mode,
        frames: document.querySelectorAll(
          'iframe[title="Static deployment build"]',
        ).length,
      };
    }, template);
    expect(artifact.mode).toBe("vite4-compatibility");
    expect(artifact.frames).toBe(0);
    expect(artifact.files.some((file) => file.path === "index.html")).toBe(
      true,
    );
    const root = testInfo.outputPath("deployment");
    await mkdir(root, { recursive: true });
    for (const file of artifact.files) {
      const target = path.join(root, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.bytes));
    }
    let server: ChildProcess | undefined;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        server = spawn(
          "python3",
          [
            "-u",
            "-c",
            "import http.server; s=http.server.ThreadingHTTPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler); print(s.server_port,flush=True); s.serve_forever()",
          ],
          { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
        );
        server.once("error", reject);
        server.stdout!.once("data", (bytes) =>
          resolve(`http://127.0.0.1:${String(bytes).trim()}`),
        );
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (
          response.url().startsWith(url) &&
          response.status() >= 400 &&
          !response.url().endsWith("favicon.ico")
        )
          errors.push(`${response.status()} ${response.url()}`);
      });
      await page.goto(url);
      await expect(page.locator("body")).not.toHaveText("");
      if (template === "vite-react-ts") {
        await expect(page.locator("body")).toHaveAttribute(
          "data-deployment-probe",
          "ready",
        );
        await expect(page.locator("#large-modules")).toHaveText(
          "Large modules compiled",
        );
        const image = page.locator("#deployment-image");
        await expect(image).toBeVisible();
        await expect
          .poll(() =>
            image.evaluate(
              (element) => (element as HTMLImageElement).naturalWidth,
            ),
          )
          .toBe(1);
        const imageUrl = await image.getAttribute("src");
        expect(imageUrl).toMatch(/^\/assets\/.+\.png$/);
        const response = await page.request.get(new URL(imageUrl!, url).href);
        expect(response.status()).toBe(200);
        expect(response.headers()["content-type"]).toBe("image/png");
        expect((await response.body()).length).toBeGreaterThan(4_096);
        const background = await page
          .locator("body")
          .evaluate((element) => getComputedStyle(element).backgroundImage);
        expect(background).toContain(imageUrl);
      }
      await page.waitForLoadState("networkidle");
      expect(errors).toEqual([]);
    } finally {
      server?.kill("SIGTERM");
    }
  });
}

test("cancels an active browser build and removes its runtime frame", async ({
  page,
}) => {
  await page.route("**/__runtime_test__", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/__runtime_test__");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { buildStaticDeployment } =
      await import("/src/lib/project-build/index.ts");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await buildStaticDeployment({
        files: {
          "index.html": '<script type="module" src="/main.js"></script>',
          "main.js": 'document.body.textContent="Hello"',
          "package.json": JSON.stringify({
            devDependencies: { vite: "4.2.0" },
            scripts: { dev: "vite" },
          }),
        },
        signal: controller.signal,
      });
      return { cancelled: false, frames: -1 };
    } catch (error) {
      return {
        cancelled: (error as Error).name === "AbortError",
        frames: document.querySelectorAll(
          'iframe[title="Static deployment build"]',
        ).length,
      };
    } finally {
      clearTimeout(timer);
    }
  });
  expect(result).toEqual({ cancelled: true, frames: 0 });
});
