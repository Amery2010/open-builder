import type { ImgHTMLAttributes } from "react";

import astroConfigIcon from "material-icon-theme/icons/astro-config.svg?url&no-inline";
import astroIcon from "material-icon-theme/icons/astro.svg?url&no-inline";
import babelIcon from "material-icon-theme/icons/babel.svg?url&no-inline";
import bunIcon from "material-icon-theme/icons/bun.svg?url&no-inline";
import cssIcon from "material-icon-theme/icons/css.svg?url&no-inline";
import dockerIcon from "material-icon-theme/icons/docker.svg?url&no-inline";
import editorconfigIcon from "material-icon-theme/icons/editorconfig.svg?url&no-inline";
import eslintIcon from "material-icon-theme/icons/eslint.svg?url&no-inline";
import faviconIcon from "material-icon-theme/icons/favicon.svg?url&no-inline";
import fileIcon from "material-icon-theme/icons/file.svg?url&no-inline";
import folderComponentsIcon from "material-icon-theme/icons/folder-components.svg?url&no-inline";
import folderComponentsOpenIcon from "material-icon-theme/icons/folder-components-open.svg?url&no-inline";
import folderConfigIcon from "material-icon-theme/icons/folder-config.svg?url&no-inline";
import folderConfigOpenIcon from "material-icon-theme/icons/folder-config-open.svg?url&no-inline";
import folderCssIcon from "material-icon-theme/icons/folder-css.svg?url&no-inline";
import folderCssOpenIcon from "material-icon-theme/icons/folder-css-open.svg?url&no-inline";
import folderDistIcon from "material-icon-theme/icons/folder-dist.svg?url&no-inline";
import folderDistOpenIcon from "material-icon-theme/icons/folder-dist-open.svg?url&no-inline";
import folderIcon from "material-icon-theme/icons/folder.svg?url&no-inline";
import folderHelperIcon from "material-icon-theme/icons/folder-helper.svg?url&no-inline";
import folderHelperOpenIcon from "material-icon-theme/icons/folder-helper-open.svg?url&no-inline";
import folderHookIcon from "material-icon-theme/icons/folder-hook.svg?url&no-inline";
import folderHookOpenIcon from "material-icon-theme/icons/folder-hook-open.svg?url&no-inline";
import folderImagesIcon from "material-icon-theme/icons/folder-images.svg?url&no-inline";
import folderImagesOpenIcon from "material-icon-theme/icons/folder-images-open.svg?url&no-inline";
import folderJavascriptIcon from "material-icon-theme/icons/folder-javascript.svg?url&no-inline";
import folderJavascriptOpenIcon from "material-icon-theme/icons/folder-javascript-open.svg?url&no-inline";
import folderLibIcon from "material-icon-theme/icons/folder-lib.svg?url&no-inline";
import folderLibOpenIcon from "material-icon-theme/icons/folder-lib-open.svg?url&no-inline";
import folderNodeIcon from "material-icon-theme/icons/folder-node.svg?url&no-inline";
import folderNodeOpenIcon from "material-icon-theme/icons/folder-node-open.svg?url&no-inline";
import folderOpenIcon from "material-icon-theme/icons/folder-open.svg?url&no-inline";
import folderPublicIcon from "material-icon-theme/icons/folder-public.svg?url&no-inline";
import folderPublicOpenIcon from "material-icon-theme/icons/folder-public-open.svg?url&no-inline";
import folderRoutesIcon from "material-icon-theme/icons/folder-routes.svg?url&no-inline";
import folderRoutesOpenIcon from "material-icon-theme/icons/folder-routes-open.svg?url&no-inline";
import folderSrcIcon from "material-icon-theme/icons/folder-src.svg?url&no-inline";
import folderSrcOpenIcon from "material-icon-theme/icons/folder-src-open.svg?url&no-inline";
import folderTestIcon from "material-icon-theme/icons/folder-test.svg?url&no-inline";
import folderTestOpenIcon from "material-icon-theme/icons/folder-test-open.svg?url&no-inline";
import folderTypescriptIcon from "material-icon-theme/icons/folder-typescript.svg?url&no-inline";
import folderTypescriptOpenIcon from "material-icon-theme/icons/folder-typescript-open.svg?url&no-inline";
import folderUtilsIcon from "material-icon-theme/icons/folder-utils.svg?url&no-inline";
import folderUtilsOpenIcon from "material-icon-theme/icons/folder-utils-open.svg?url&no-inline";
import folderViewsIcon from "material-icon-theme/icons/folder-views.svg?url&no-inline";
import folderViewsOpenIcon from "material-icon-theme/icons/folder-views-open.svg?url&no-inline";
import fontIcon from "material-icon-theme/icons/font.svg?url&no-inline";
import gitIcon from "material-icon-theme/icons/git.svg?url&no-inline";
import graphqlIcon from "material-icon-theme/icons/graphql.svg?url&no-inline";
import htmlIcon from "material-icon-theme/icons/html.svg?url&no-inline";
import imageIcon from "material-icon-theme/icons/image.svg?url&no-inline";
import javascriptIcon from "material-icon-theme/icons/javascript.svg?url&no-inline";
import jestIcon from "material-icon-theme/icons/jest.svg?url&no-inline";
import jsonIcon from "material-icon-theme/icons/json.svg?url&no-inline";
import lessIcon from "material-icon-theme/icons/less.svg?url&no-inline";
import licenseIcon from "material-icon-theme/icons/license.svg?url&no-inline";
import lockIcon from "material-icon-theme/icons/lock.svg?url&no-inline";
import markdownIcon from "material-icon-theme/icons/markdown.svg?url&no-inline";
import mdxIcon from "material-icon-theme/icons/mdx.svg?url&no-inline";
import npmIcon from "material-icon-theme/icons/npm.svg?url&no-inline";
import pnpmIcon from "material-icon-theme/icons/pnpm.svg?url&no-inline";
import prettierIcon from "material-icon-theme/icons/prettier.svg?url&no-inline";
import reactIcon from "material-icon-theme/icons/react.svg?url&no-inline";
import readmeIcon from "material-icon-theme/icons/readme.svg?url&no-inline";
import rollupIcon from "material-icon-theme/icons/rollup.svg?url&no-inline";
import sassIcon from "material-icon-theme/icons/sass.svg?url&no-inline";
import storybookIcon from "material-icon-theme/icons/storybook.svg?url&no-inline";
import svelteIcon from "material-icon-theme/icons/svelte.svg?url&no-inline";
import svgIcon from "material-icon-theme/icons/svg.svg?url&no-inline";
import tailwindIcon from "material-icon-theme/icons/tailwindcss.svg?url&no-inline";
import testJsIcon from "material-icon-theme/icons/test-js.svg?url&no-inline";
import testJsxIcon from "material-icon-theme/icons/test-jsx.svg?url&no-inline";
import testTsIcon from "material-icon-theme/icons/test-ts.svg?url&no-inline";
import tomlIcon from "material-icon-theme/icons/toml.svg?url&no-inline";
import tsconfigIcon from "material-icon-theme/icons/tsconfig.svg?url&no-inline";
import typescriptIcon from "material-icon-theme/icons/typescript.svg?url&no-inline";
import viteIcon from "material-icon-theme/icons/vite.svg?url&no-inline";
import vitestIcon from "material-icon-theme/icons/vitest.svg?url&no-inline";
import vueConfigIcon from "material-icon-theme/icons/vue-config.svg?url&no-inline";
import vueIcon from "material-icon-theme/icons/vue.svg?url&no-inline";
import webpackIcon from "material-icon-theme/icons/webpack.svg?url&no-inline";
import xmlIcon from "material-icon-theme/icons/xml.svg?url&no-inline";
import yamlIcon from "material-icon-theme/icons/yaml.svg?url&no-inline";
import yarnIcon from "material-icon-theme/icons/yarn.svg?url&no-inline";

export type MaterialIconKind = "file" | "folder";

const folderIcons = {
  components: [folderComponentsIcon, folderComponentsOpenIcon],
  config: [folderConfigIcon, folderConfigOpenIcon],
  css: [folderCssIcon, folderCssOpenIcon],
  dist: [folderDistIcon, folderDistOpenIcon],
  folder: [folderIcon, folderOpenIcon],
  helpers: [folderHelperIcon, folderHelperOpenIcon],
  hooks: [folderHookIcon, folderHookOpenIcon],
  images: [folderImagesIcon, folderImagesOpenIcon],
  javascript: [folderJavascriptIcon, folderJavascriptOpenIcon],
  lib: [folderLibIcon, folderLibOpenIcon],
  node_modules: [folderNodeIcon, folderNodeOpenIcon],
  public: [folderPublicIcon, folderPublicOpenIcon],
  routes: [folderRoutesIcon, folderRoutesOpenIcon],
  src: [folderSrcIcon, folderSrcOpenIcon],
  test: [folderTestIcon, folderTestOpenIcon],
  typescript: [folderTypescriptIcon, folderTypescriptOpenIcon],
  utils: [folderUtilsIcon, folderUtilsOpenIcon],
  views: [folderViewsIcon, folderViewsOpenIcon],
} as const;

type FolderIconName = keyof typeof folderIcons;

const folderNameToIcon: Record<string, FolderIconName> = {
  __tests__: "test",
  assets: "images",
  build: "dist",
  components: "components",
  config: "config",
  css: "css",
  dist: "dist",
  hooks: "hooks",
  helpers: "helpers",
  images: "images",
  javascript: "javascript",
  lib: "lib",
  node_modules: "node_modules",
  pages: "views",
  public: "public",
  routes: "routes",
  src: "src",
  style: "css",
  styles: "css",
  test: "test",
  tests: "test",
  typescript: "typescript",
  types: "typescript",
  utils: "utils",
  views: "views",
};

const fileNameIcons: Record<string, string> = {
  ".dockerignore": dockerIcon,
  ".editorconfig": editorconfigIcon,
  ".eslintignore": eslintIcon,
  ".eslintrc": eslintIcon,
  ".gitattributes": gitIcon,
  ".gitignore": gitIcon,
  ".npmrc": npmIcon,
  ".prettierrc": prettierIcon,
  ".prettierrc.json": prettierIcon,
  ".prettierrc.yml": prettierIcon,
  ".prettierignore": prettierIcon,
  "astro.config.js": astroConfigIcon,
  "astro.config.mjs": astroConfigIcon,
  "astro.config.ts": astroConfigIcon,
  "babel.config.js": babelIcon,
  "babel.config.json": babelIcon,
  "bun.lock": bunIcon,
  "bun.lockb": bunIcon,
  dockerfile: dockerIcon,
  "eslint.config.js": eslintIcon,
  "eslint.config.mjs": eslintIcon,
  "eslint.config.ts": eslintIcon,
  "favicon.ico": faviconIcon,
  "favicon.svg": faviconIcon,
  "jest.config.js": jestIcon,
  "jest.config.ts": jestIcon,
  "jsconfig.json": tsconfigIcon,
  license: licenseIcon,
  "license.md": licenseIcon,
  "npm-shrinkwrap.json": npmIcon,
  "package-lock.json": lockIcon,
  "package.json": npmIcon,
  "pnpm-lock.yaml": pnpmIcon,
  readme: readmeIcon,
  "readme.md": readmeIcon,
  "rollup.config.js": rollupIcon,
  "rollup.config.mjs": rollupIcon,
  "rollup.config.ts": rollupIcon,
  "storybook.config.js": storybookIcon,
  "storybook.config.ts": storybookIcon,
  "tailwind.config.cjs": tailwindIcon,
  "tailwind.config.js": tailwindIcon,
  "tailwind.config.mjs": tailwindIcon,
  "tailwind.config.ts": tailwindIcon,
  "tsconfig.json": tsconfigIcon,
  "vite.config.js": viteIcon,
  "vite.config.mjs": viteIcon,
  "vite.config.ts": viteIcon,
  "vitest.config.js": vitestIcon,
  "vitest.config.mjs": vitestIcon,
  "vitest.config.ts": vitestIcon,
  "vue.config.js": vueConfigIcon,
  "vue.config.ts": vueConfigIcon,
  "webpack.config.js": webpackIcon,
  "webpack.config.mjs": webpackIcon,
  "webpack.config.ts": webpackIcon,
  "yarn.lock": yarnIcon,
};

const fileExtensionIcons: Record<string, string> = {
  ".astro": astroIcon,
  ".avif": imageIcon,
  ".bmp": imageIcon,
  ".cjs": javascriptIcon,
  ".css": cssIcon,
  ".gif": imageIcon,
  ".gql": graphqlIcon,
  ".graphql": graphqlIcon,
  ".html": htmlIcon,
  ".jpeg": imageIcon,
  ".jpg": imageIcon,
  ".js": javascriptIcon,
  ".json": jsonIcon,
  ".jsx": reactIcon,
  ".less": lessIcon,
  ".md": markdownIcon,
  ".mdx": mdxIcon,
  ".mjs": javascriptIcon,
  ".png": imageIcon,
  ".scss": sassIcon,
  ".sass": sassIcon,
  ".svelte": svelteIcon,
  ".svg": svgIcon,
  ".tif": imageIcon,
  ".tiff": imageIcon,
  ".toml": tomlIcon,
  ".ts": typescriptIcon,
  ".tsx": reactIcon,
  ".ttf": fontIcon,
  ".webp": imageIcon,
  ".eot": fontIcon,
  ".otf": fontIcon,
  ".woff": fontIcon,
  ".woff2": fontIcon,
  ".vue": vueIcon,
  ".xml": xmlIcon,
  ".yaml": yamlIcon,
  ".yml": yamlIcon,
};

const testIcons: Record<string, string> = {
  ".js": testJsIcon,
  ".jsx": testJsxIcon,
  ".ts": testTsIcon,
  ".tsx": testJsxIcon,
};

function getBaseName(nameOrPath: string): string {
  const normalized = nameOrPath.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex <= 0 ? "" : fileName.slice(dotIndex).toLowerCase();
}

function isTestOrSpecFile(fileName: string): boolean {
  return /(?:^|[._-])(test|spec)(?:[._-]|$)/i.test(fileName);
}

function resolveConfigFileIcon(fileName: string): string | undefined {
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(fileName)) return tsconfigIcon;
  if (/^jsconfig(?:\.[^.]+)*\.json$/.test(fileName)) return tsconfigIcon;
  if (/^vite\.config\.[^.]+$/.test(fileName)) return viteIcon;
  if (/^vitest\.config\.[^.]+$/.test(fileName)) return vitestIcon;
  if (/^tailwind\.config\.[^.]+$/.test(fileName)) return tailwindIcon;
  if (/^eslint(?:\.config|rc)(?:\.[^.]+)*$/.test(fileName)) return eslintIcon;
  if (/^\.eslint(?:rc(?:\.[^.]+)*|ignore)$/.test(fileName)) return eslintIcon;
  if (/^prettier(?:\.config)?(?:\.[^.]+)*$/.test(fileName)) {
    return prettierIcon;
  }
  if (/^\.prettier(?:rc(?:\.[^.]+)*|ignore)$/.test(fileName)) {
    return prettierIcon;
  }
  if (/^webpack\.config\.[^.]+$/.test(fileName)) return webpackIcon;
  if (/^rollup\.config\.[^.]+$/.test(fileName)) return rollupIcon;
  if (/^babel\.config\.[^.]+$/.test(fileName)) return babelIcon;
  if (/^astro\.config\.[^.]+$/.test(fileName)) return astroConfigIcon;
  if (/^vue\.config\.[^.]+$/.test(fileName)) return vueConfigIcon;
  if (/^storybook\.config\.[^.]+$/.test(fileName)) return storybookIcon;
  if (/^readme(?:\.[^.]+)*$/.test(fileName)) return readmeIcon;
  if (/^license(?:\.[^.]+)*$/.test(fileName)) return licenseIcon;
  if (/^dockerfile(?:\.[^.]+)*$/.test(fileName)) return dockerIcon;
  return undefined;
}

function resolveFolderIcon(folderName: string, expanded: boolean): string {
  const iconName = folderNameToIcon[folderName] ?? "folder";
  const [closedIcon, openIcon] = folderIcons[iconName];
  return expanded ? openIcon : closedIcon;
}

function resolveFileIcon(fileName: string): string {
  const normalizedName = fileName.toLowerCase();
  const specialIcon =
    fileNameIcons[normalizedName] ?? resolveConfigFileIcon(normalizedName);
  if (specialIcon) return specialIcon;

  const extension = getFileExtension(normalizedName);
  if (isTestOrSpecFile(normalizedName)) {
    const testIcon = testIcons[extension];
    if (testIcon) return testIcon;
  }

  if (extension === ".lock") return lockIcon;
  return fileExtensionIcons[extension] ?? fileIcon;
}

export function resolveMaterialIcon(
  nameOrPath: string,
  kind: MaterialIconKind,
  expanded = false,
): string {
  const baseName = getBaseName(nameOrPath);
  if (kind === "folder")
    return resolveFolderIcon(baseName.toLowerCase(), expanded);
  return resolveFileIcon(baseName);
}

export interface MaterialIconProps extends Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "alt" | "src"
> {
  name: string;
  kind: MaterialIconKind;
  expanded?: boolean;
}

export function MaterialIcon({
  name,
  kind,
  expanded = false,
  className,
  ...props
}: MaterialIconProps) {
  return (
    <img
      {...props}
      src={resolveMaterialIcon(name, kind, expanded)}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className ?? "h-3.5 w-3.5 shrink-0"}
    />
  );
}
