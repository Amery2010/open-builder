// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  projectReactPreview,
  REACT_PREVIEW_ENTRY,
} from "./sandpack-react-preview";

function fixture(entry = "index.tsx") {
  return {
    "package.json": JSON.stringify({
      scripts: { dev: "vite", build: "tsc && vite build" },
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
      devDependencies: { vite: "4.2.0", "@vitejs/plugin-react": "^4.3.4" },
    }),
    "vite.config.ts": `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// https://vitejs.dev/config/
export default defineConfig({ plugins: [react()], })`,
    "index.html": `<!doctype html><html lang="zh-CN"><head><title>摄影</title></head><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`,
    [entry]:
      'import App from "./App"; import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")!).render(<App />);',
    "App.tsx": "export default function App(){return <h1>摄影</h1>}",
  };
}

describe("default React/Vite browser preview", () => {
  it.each(["index.tsx", "src/main.tsx"])(
    "renders %s without changing source files",
    (entry) => {
      const files = fixture(entry);
      const before = structuredClone(files);
      const result = projectReactPreview(files, files, "vite-react-ts");
      expect(result.customSetup).toEqual({
        environment: "create-react-app",
        entry: `/${REACT_PREVIEW_ENTRY}`,
      });
      expect(JSON.parse(result.files["package.json"]).main).toBe(
        `/${REACT_PREVIEW_ENTRY}`,
      );
      expect(result.files[REACT_PREVIEW_ENTRY]).toContain(
        `require("./${entry}")`,
      );
      expect(result.sourceEntry).toBe(`/${entry}`);
      const html = new DOMParser().parseFromString(
        result.files["public/index.html"],
        "text/html",
      );
      expect(html.querySelector('script[type="module"]')).toBeNull();
      expect(html.querySelector("#root")).not.toBeNull();
      expect(html.title).toBe("摄影");
      expect(files).toEqual(before);
      expect(
        result.restore("public/index.html", "an editor echo"),
      ).toBeUndefined();
      expect(result.restore("package.json", result.files["package.json"])).toBe(
        files["package.json"],
      );
    },
  );

  it("copies the final Design bridge and retains genuine package edits", () => {
    const files = fixture();
    const prepared = {
      ...files,
      "index.html": files["index.html"].replace(
        "</body>",
        '<script src="/__open_builder_design_bridge__.js"></script></body>',
      ),
    };
    const result = projectReactPreview(files, prepared, "vite-react-ts");
    expect(result.files["public/index.html"]).toContain(
      "__open_builder_design_bridge__.js",
    );
    const pkg = JSON.parse(result.files["package.json"]);
    pkg.description = "edited";
    expect(
      JSON.parse(result.restore("package.json", JSON.stringify(pkg))!),
    ).toEqual({ ...JSON.parse(files["package.json"]), description: "edited" });
    pkg.main = "/other.tsx";
    expect(
      JSON.parse(result.restore("package.json", JSON.stringify(pkg))!).main,
    ).toBe("/other.tsx");
  });

  it.each<Record<string, string>>([
    { "vite.config.ts": "export default {base:'/app/'}" },
    { "public/index.html": "<main>user-owned</main>" },
    { ".babelrc": "{}" },
    { "postcss.config.js": "export default {}" },
    { "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}' },
    { "App.tsx": "export default () => import.meta.env.VITE_NAME" },
    { "App.tsx": "export default () => import /* comment */ .meta.env.MODE" },
    { "tsconfig.json": '{"compilerOptions":{"verbatimModuleSyntax":true}}' },
    { "tsconfig.json": '{"compilerOptions":"strict"}' },
    { "tsconfig.json": '{"compilerOptions":[]}' },
    {
      "index.html":
        '<html class="dark"><body><script type="module" src="/index.tsx"></script></body></html>',
    },
    {
      "App.tsx": "import text from './text.txt?raw'; export default () => text",
    },
    {
      "index.html":
        '<div id="root"></div><script type="module" src="https://example.com/main.js"></script>',
    },
    {
      "index.html":
        '<script type="module" src="/index.tsx"></script><script type="module" src="/other.ts"></script>',
    },
  ])("keeps Nodebox for custom/unsupported semantics %j", (changes) => {
    const files = { ...fixture(), ...changes };
    const result = projectReactPreview(files, files, "vite-react-ts");
    expect(result.customSetup).toBeUndefined();
    expect(result.files).toBe(files);
  });

  it("does not adapt other templates, code-only mode, or custom startup commands", () => {
    const files = fixture();
    expect(
      projectReactPreview(files, files, "node").customSetup,
    ).toBeUndefined();
    expect(
      projectReactPreview(files, files, "vite-react-ts", false).files,
    ).toBe(files);
    const pkg = JSON.parse(files["package.json"]);
    pkg.scripts.dev = "node server.js && vite";
    files["package.json"] = JSON.stringify(pkg);
    expect(
      projectReactPreview(files, files, "vite-react-ts").customSetup,
    ).toBeUndefined();
  });

  it.each([
    { postcss: { plugins: { custom: {} } } },
    { overrides: { "@vitejs/plugin-react": "custom" } },
    {
      devDependencies: {
        vite: "4.2.0",
        "@vitejs/plugin-react": "npm:custom-react@1",
      },
    },
  ])("does not bypass package customization %j", (change) => {
    const files = fixture();
    files["package.json"] = JSON.stringify({
      ...JSON.parse(files["package.json"]),
      ...change,
    });
    expect(
      projectReactPreview(files, files, "vite-react-ts").customSetup,
    ).toBeUndefined();
  });
});
