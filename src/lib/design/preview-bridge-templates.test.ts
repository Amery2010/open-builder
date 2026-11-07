// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fsInitProject } from "../tools/fs-tools";
import {
  DESIGN_BRIDGE_MARKER,
  DESIGN_BRIDGE_VIRTUAL_PATH,
  DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH,
  injectDesignBridge,
} from "./preview-bridge";

const htmlTemplates = [
  "static",
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
const scriptTemplates = [
  "react",
  "react-ts",
  "vue",
  "vue-ts",
  "svelte",
  "solid",
  "angular",
  "vanilla",
  "vanilla-ts",
];

describe("design bridge template projections", () => {
  it.each([...htmlTemplates, ...scriptTemplates])(
    "instruments the executable entry of %s without changing project files",
    async (template) => {
      const initialized = await fsInitProject(template);
      const files = initialized.newFiles!;
      const before = { ...files };
      const result = injectDesignBridge(
        files,
        template,
        true,
        "window.capture = {};",
        "generation-1",
      );
      const isScript = scriptTemplates.includes(template);
      const entry = isScript
        ? JSON.parse(files["package.json"]).main.replace(/^\//, "")
        : "index.html";
      expect(result.supported).toBe(true);
      expect(result.files[DESIGN_BRIDGE_VIRTUAL_PATH]).not.toMatch(
        /\bcatch\s*\{/,
      );
      expect(result.files[entry]).toContain(DESIGN_BRIDGE_MARKER);
      const relativeRoot = "../".repeat(entry.split("/").length - 1) || "./";
      expect(result.files[entry]).toContain(
        isScript
          ? `import "${relativeRoot}${DESIGN_BRIDGE_VIRTUAL_PATH}";`
          : `src="/${DESIGN_BRIDGE_VIRTUAL_PATH}"`,
      );
      expect(
        result.files[entry].indexOf(DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH),
      ).toBeLessThan(result.files[entry].indexOf(DESIGN_BRIDGE_VIRTUAL_PATH));
      expect(result.restore(entry, result.files[entry])).toBe(files[entry]);
      expect(
        result.restore(DESIGN_BRIDGE_VIRTUAL_PATH, "edited bridge"),
      ).toBeUndefined();
      expect(
        result.restore(DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH, "edited capture"),
      ).toBeUndefined();
      expect(files).toEqual(before);
      expect(
        Object.keys(result.files).filter(
          (path) => result.files[path] !== files[path],
        ),
      ).toEqual(
        expect.arrayContaining([
          entry,
          DESIGN_BRIDGE_VIRTUAL_PATH,
          DESIGN_CAPTURE_RUNTIME_VIRTUAL_PATH,
        ]),
      );
      expect(Object.keys(result.files)).toHaveLength(
        Object.keys(files).length + 2,
      );
    },
  );

  it.each(scriptTemplates)(
    "uses %s implicit template entry without persisting it",
    (template) => {
      const files = { "README.md": "Partial project" };
      const result = injectDesignBridge(files, template);
      expect(result.supported).toBe(true);
      for (const [path, source] of Object.entries(result.files)) {
        expect(result.restore(path, source)).toBe(
          path === "README.md" ? files[path] : undefined,
        );
      }
    },
  );

  it("preserves edits and exact whitespace in a nested custom script entry", () => {
    const entry = "src/client/start.tsx";
    const source =
      '#!/usr/bin/env node\n\n"use strict";\nexport const title = "Before";\n';
    const files = {
      "package.json": JSON.stringify({ main: `./${entry}` }),
      [entry]: source,
    };
    const result = injectDesignBridge(files, "react-ts");
    expect(result.supported).toBe(true);
    expect(result.files[entry]).toMatch(/^#!\/usr\/bin\/env node\n\/\*/);
    expect(result.files[entry]).toContain(
      `import "../../${DESIGN_BRIDGE_VIRTUAL_PATH}";`,
    );
    expect(
      result.restore(entry, result.files[entry].replace("Before", "After")),
    ).toBe(source.replace("Before", "After"));
    expect(
      result.restore(
        entry,
        result.files[entry].replace(`/* ${DESIGN_BRIDGE_MARKER}:end */`, ""),
      ),
    ).toBeUndefined();
    expect(result.restore("App.tsx", "user edit")).toBe("user edit");
    expect(injectDesignBridge(result.files, "react-ts")).toMatchObject({
      supported: false,
      reason: "reserved-path",
    });
  });

  it("supports a Vanilla HTML entry and restores original closing-tag whitespace", () => {
    const source = "<body>\r\n<main>Before</main>\r\n</BODY >\r\n";
    const files = {
      "package.json": '{"main":"pages/start.html"}',
      "pages/start.html": source,
    };
    const result = injectDesignBridge(files, "vanilla");
    expect(result.supported).toBe(true);
    expect(result.files["pages/start.html"]).toContain(
      `src="/${DESIGN_BRIDGE_VIRTUAL_PATH}"`,
    );
    expect(
      result.restore(
        "pages/start.html",
        result.files["pages/start.html"].replace("Before", "After"),
      ),
    ).toBe(source.replace("Before", "After"));
  });

  it.each([
    ["react", { "package.json": "invalid" }],
    ["react", { "package.json": '{"main":"missing.js"}' }],
    ["react", { "package.json": '{"main":"../index.js"}' }],
    ["react", { "package.json": '{"main":"public/index.html"}' }],
    ["angular", { "angular.json": "{}" }],
    ["angular", { ".angular-cli.json": "{}" }],
  ] as const)(
    "does not guess an executable entry for %s (%j)",
    (template, files) => {
      const result = injectDesignBridge(files, template);
      expect(result).toMatchObject({
        supported: false,
        reason: "missing-entry",
      });
      expect(result.files).toBe(files);
    },
  );

  it.each(["node", "test-ts", "nextjs", "astro", "unknown"])(
    "keeps %s unavailable",
    (template) => {
      expect(
        injectDesignBridge({ "index.html": "<body></body>" }, template),
      ).toMatchObject({ supported: false, reason: "unsupported-template" });
    },
  );

  it("rejects a marker collision in the real script entry", () => {
    expect(
      injectDesignBridge(
        { "index.js": `/* ${DESIGN_BRIDGE_MARKER} */` },
        "react",
      ),
    ).toMatchObject({ supported: false, reason: "reserved-path" });
  });
});
