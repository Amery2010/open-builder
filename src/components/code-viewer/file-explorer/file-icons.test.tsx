import { describe, expect, it } from "vitest";

import { resolveMaterialIcon } from "./file-icons";

function endsWithIcon(icon: string, name: string) {
  expect(icon).toMatch(new RegExp(`${name}\\.svg(?:$|[?#])`));
}

describe("resolveMaterialIcon", () => {
  it("prioritizes special names and config patterns over extensions", () => {
    endsWithIcon(resolveMaterialIcon("package.json", "file"), "npm");
    endsWithIcon(resolveMaterialIcon("package-lock.json", "file"), "lock");
    endsWithIcon(resolveMaterialIcon("tsconfig.app.json", "file"), "tsconfig");
    endsWithIcon(resolveMaterialIcon("vite.config.ts", "file"), "vite");
    endsWithIcon(resolveMaterialIcon(".eslintrc.cjs", "file"), "eslint");
    endsWithIcon(resolveMaterialIcon(".prettierignore", "file"), "prettier");
    endsWithIcon(resolveMaterialIcon("README.zh-CN.md", "file"), "readme");
  });

  it("matches test and spec files before their language extension", () => {
    endsWithIcon(resolveMaterialIcon("Button.test.tsx", "file"), "test-jsx");
    endsWithIcon(resolveMaterialIcon("user.spec.ts", "file"), "test-ts");
    endsWithIcon(resolveMaterialIcon("Widget.SPEC.JS", "file"), "test-js");
  });

  it("matches common frontend extensions case-insensitively", () => {
    endsWithIcon(resolveMaterialIcon("App.TSX", "file"), "react");
    endsWithIcon(resolveMaterialIcon("theme.SCSS", "file"), "sass");
    endsWithIcon(resolveMaterialIcon("page.MDX", "file"), "mdx");
    endsWithIcon(resolveMaterialIcon("App.vue", "file"), "vue");
    endsWithIcon(resolveMaterialIcon("Inter.OTF", "file"), "font");
    endsWithIcon(resolveMaterialIcon("icon.svg", "file"), "svg");
  });

  it("uses the generic file icon for unknown extensions", () => {
    endsWithIcon(resolveMaterialIcon("notes.custom", "file"), "file");
  });

  it("resolves common folders and their expanded variants", () => {
    endsWithIcon(resolveMaterialIcon("src", "folder"), "folder-src");
    endsWithIcon(
      resolveMaterialIcon("pages", "folder", true),
      "folder-views-open",
    );
    endsWithIcon(resolveMaterialIcon("assets", "folder"), "folder-images");
    endsWithIcon(resolveMaterialIcon("helpers", "folder"), "folder-helper");
    endsWithIcon(resolveMaterialIcon("__tests__", "folder"), "folder-test");
    endsWithIcon(
      resolveMaterialIcon("build", "folder", true),
      "folder-dist-open",
    );
    endsWithIcon(
      resolveMaterialIcon("node_modules", "folder", true),
      "folder-node-open",
    );
    endsWithIcon(resolveMaterialIcon("unknown-folder", "folder"), "folder");
  });

  it("accepts a path while matching only its final segment", () => {
    endsWithIcon(
      resolveMaterialIcon("src/components/WeatherCard.tsx", "file"),
      "react",
    );
    endsWithIcon(
      resolveMaterialIcon("src/components", "folder", true),
      "folder-components-open",
    );
  });
});
