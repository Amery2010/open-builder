import type { ProjectFiles } from "../ai/generator-types";

type DependencySection = "dependencies" | "devDependencies";
type DependencyMap = Readonly<Record<string, string>>;
type PackageJsonRecord = Record<string, unknown> &
  Partial<Record<DependencySection, Record<string, unknown>>>;

export type TemplateProfileStatus = "stable" | "experimental";

interface TemplateRuntimeLock {
  matchDependencies: readonly string[];
  continuationDependency: string;
  lockedDependencies: readonly string[];
}

export interface SandpackTemplateProfile {
  status: TemplateProfileStatus;
  dependencies: DependencyMap;
  devDependencies?: DependencyMap;
  fileOverrides?: Readonly<Record<string, string>>;
  runtimeLock?: TemplateRuntimeLock;
}

export const OPEN_BUILDER_TEMPLATE_MANIFEST_VERSION = 2;

const REACT_VERSION = "^18.3.1";
const REACT_TYPES_VERSION = "^18.3.12";
const REACT_DOM_TYPES_VERSION = "^18.3.1";
const TYPESCRIPT_REFRESH_VERSION = "^5.9.3";
const PREACT_VERSION = "^10.29.8";
const VUE_VERSION = "^3.5.42";
const SOLID_VERSION = "1.9.15";

export const OPEN_BUILDER_TEMPLATE_MANIFEST = {
  static: {
    status: "stable",
    dependencies: {},
  },
  angular: {
    status: "stable",
    dependencies: {
      "@angular/core": "^11.2.0",
      "@angular/platform-browser": "^11.2.0",
      "@angular/platform-browser-dynamic": "^11.2.0",
      "@angular/common": "^11.2.0",
      "@angular/compiler": "^11.2.0",
      "zone.js": "0.11.3",
      "core-js": "3.8.3",
      rxjs: "6.6.3",
    },
    runtimeLock: {
      matchDependencies: ["@angular/core"],
      continuationDependency: "@angular/core",
      lockedDependencies: [
        "@angular/core",
        "@angular/platform-browser",
        "@angular/platform-browser-dynamic",
        "@angular/common",
        "@angular/compiler",
        "zone.js",
        "core-js",
        "rxjs",
      ],
    },
  },
  react: {
    status: "stable",
    dependencies: {
      react: REACT_VERSION,
      "react-dom": REACT_VERSION,
      "react-scripts": "^5.0.0",
    },
    runtimeLock: {
      matchDependencies: ["react-scripts"],
      continuationDependency: "react-scripts",
      lockedDependencies: ["react-scripts"],
    },
  },
  "react-ts": {
    status: "stable",
    dependencies: {
      react: REACT_VERSION,
      "react-dom": REACT_VERSION,
      "react-scripts": "^4.0.0",
    },
    devDependencies: {
      "@types/react": REACT_TYPES_VERSION,
      "@types/react-dom": REACT_DOM_TYPES_VERSION,
      typescript: "^4.9.5",
    },
    fileOverrides: {
      "App.tsx":
        "export default function App() {\n  return <h1>Hello world</h1>\n}\n",
      "index.tsx":
        'import React, { StrictMode } from "react";\n' +
        'import { createRoot } from "react-dom/client";\n' +
        'import "./styles.css";\n\n' +
        'import App from "./App";\n\n' +
        'const root = createRoot(document.getElementById("root") as HTMLElement);\n' +
        "root.render(\n" +
        "  <StrictMode>\n" +
        "    <App />\n" +
        "  </StrictMode>,\n" +
        ");\n",
    },
    runtimeLock: {
      matchDependencies: ["react-scripts", "typescript"],
      continuationDependency: "react-scripts",
      lockedDependencies: ["react-scripts"],
    },
  },
  solid: {
    status: "stable",
    dependencies: { "solid-js": SOLID_VERSION },
  },
  svelte: {
    status: "stable",
    dependencies: { svelte: "^3.0.0" },
    runtimeLock: {
      matchDependencies: ["svelte"],
      continuationDependency: "svelte",
      lockedDependencies: ["svelte"],
    },
  },
  "test-ts": {
    status: "stable",
    dependencies: {},
    devDependencies: { typescript: TYPESCRIPT_REFRESH_VERSION },
  },
  "vanilla-ts": {
    status: "stable",
    dependencies: {},
    devDependencies: { typescript: TYPESCRIPT_REFRESH_VERSION },
  },
  vanilla: {
    status: "stable",
    dependencies: {},
  },
  vue: {
    status: "stable",
    dependencies: {
      "core-js": "^3.50.0",
      vue: VUE_VERSION,
    },
    devDependencies: {
      "@vue/cli-plugin-babel": "^5.0.8",
      "@vue/cli-service": "^5.0.8",
    },
    runtimeLock: {
      matchDependencies: ["@vue/cli-service", "@vue/cli-plugin-babel"],
      continuationDependency: "@vue/cli-service",
      lockedDependencies: ["@vue/cli-plugin-babel", "@vue/cli-service"],
    },
  },
  "vue-ts": {
    status: "stable",
    dependencies: {
      "core-js": "^3.50.0",
      vue: VUE_VERSION,
    },
    devDependencies: {
      "@vue/cli-plugin-babel": "^5.0.8",
      "@vue/cli-plugin-typescript": "^5.0.8",
      "@vue/cli-service": "^5.0.8",
      typescript: "^4.9.5",
    },
    runtimeLock: {
      matchDependencies: [
        "@vue/cli-service",
        "@vue/cli-plugin-babel",
        "@vue/cli-plugin-typescript",
      ],
      continuationDependency: "@vue/cli-service",
      lockedDependencies: [
        "@vue/cli-plugin-babel",
        "@vue/cli-plugin-typescript",
        "@vue/cli-service",
      ],
    },
  },
  node: {
    status: "stable",
    dependencies: {},
  },
  nextjs: {
    status: "stable",
    dependencies: {
      next: "12.1.6",
      react: "18.2.0",
      "react-dom": "18.2.0",
      "@next/swc-wasm-nodejs": "12.1.6",
    },
    runtimeLock: {
      matchDependencies: ["next", "@next/swc-wasm-nodejs"],
      continuationDependency: "next",
      lockedDependencies: [
        "next",
        "@next/swc-wasm-nodejs",
        "react",
        "react-dom",
      ],
    },
  },
  vite: {
    status: "stable",
    dependencies: {},
    devDependencies: {
      vite: "4.1.4",
      "esbuild-wasm": "0.17.12",
    },
    runtimeLock: {
      matchDependencies: ["vite"],
      continuationDependency: "vite",
      lockedDependencies: ["vite", "esbuild-wasm"],
    },
  },
  "vite-react": {
    status: "stable",
    dependencies: {
      react: REACT_VERSION,
      "react-dom": REACT_VERSION,
    },
    devDependencies: {
      "@vitejs/plugin-react": "3.1.0",
      vite: "4.1.4",
      "esbuild-wasm": "0.17.12",
    },
    runtimeLock: {
      matchDependencies: ["vite", "@vitejs/plugin-react"],
      continuationDependency: "vite",
      lockedDependencies: ["@vitejs/plugin-react", "vite", "esbuild-wasm"],
    },
  },
  "vite-react-ts": {
    status: "stable",
    dependencies: {
      react: REACT_VERSION,
      "react-dom": REACT_VERSION,
    },
    devDependencies: {
      "@types/react": REACT_TYPES_VERSION,
      "@types/react-dom": REACT_DOM_TYPES_VERSION,
      "@vitejs/plugin-react": "^4.3.4",
      typescript: TYPESCRIPT_REFRESH_VERSION,
      vite: "4.2.0",
      "esbuild-wasm": "^0.17.12",
    },
    runtimeLock: {
      matchDependencies: ["vite", "@vitejs/plugin-react"],
      continuationDependency: "vite",
      lockedDependencies: ["@vitejs/plugin-react", "vite", "esbuild-wasm"],
    },
  },
  "vite-preact": {
    status: "stable",
    dependencies: { preact: PREACT_VERSION },
    devDependencies: {
      "@preact/preset-vite": "^2.5.0",
      vite: "4.1.4",
      "esbuild-wasm": "0.17.12",
    },
    runtimeLock: {
      matchDependencies: ["vite", "@preact/preset-vite"],
      continuationDependency: "vite",
      lockedDependencies: ["@preact/preset-vite", "vite", "esbuild-wasm"],
    },
  },
  "vite-preact-ts": {
    status: "stable",
    dependencies: { preact: PREACT_VERSION },
    devDependencies: {
      "@preact/preset-vite": "^2.5.0",
      typescript: TYPESCRIPT_REFRESH_VERSION,
      vite: "4.1.4",
      "esbuild-wasm": "^0.17.12",
    },
    runtimeLock: {
      matchDependencies: ["vite", "@preact/preset-vite"],
      continuationDependency: "vite",
      lockedDependencies: ["@preact/preset-vite", "vite", "esbuild-wasm"],
    },
  },
  "vite-vue": {
    status: "stable",
    dependencies: { vue: VUE_VERSION },
    devDependencies: {
      "@vitejs/plugin-vue": "3.2.0",
      vite: "4.1.4",
      "esbuild-wasm": "0.17.12",
    },
    runtimeLock: {
      matchDependencies: ["vite", "@vitejs/plugin-vue"],
      continuationDependency: "vite",
      lockedDependencies: ["@vitejs/plugin-vue", "vite", "esbuild-wasm"],
    },
  },
  "vite-vue-ts": {
    status: "stable",
    dependencies: { vue: VUE_VERSION },
    devDependencies: {
      "@vitejs/plugin-vue": "^4.0.0",
      vite: "4.1.4",
      "vue-tsc": "^1.2.0",
      typescript: "^4.9.5",
      "esbuild-wasm": "^0.17.12",
    },
    runtimeLock: {
      matchDependencies: ["vite", "@vitejs/plugin-vue"],
      continuationDependency: "vite",
      lockedDependencies: ["@vitejs/plugin-vue", "vite", "esbuild-wasm"],
    },
  },
  "vite-svelte": {
    status: "stable",
    dependencies: {},
    devDependencies: {
      "@sveltejs/vite-plugin-svelte": "^2.0.2",
      svelte: "^3.55.1",
      vite: "4.0.4",
      "esbuild-wasm": "^0.17.12",
    },
    runtimeLock: {
      matchDependencies: ["vite", "@sveltejs/vite-plugin-svelte"],
      continuationDependency: "vite",
      lockedDependencies: [
        "@sveltejs/vite-plugin-svelte",
        "svelte",
        "vite",
        "esbuild-wasm",
      ],
    },
  },
  "vite-svelte-ts": {
    status: "stable",
    dependencies: {},
    devDependencies: {
      "@sveltejs/vite-plugin-svelte": "^2.0.2",
      "@tsconfig/svelte": "^3.0.0",
      svelte: "^3.55.1",
      "svelte-check": "^2.10.3",
      tslib: "^2.5.0",
      vite: "4.1.4",
      "esbuild-wasm": "^0.17.12",
    },
    runtimeLock: {
      matchDependencies: ["vite", "@sveltejs/vite-plugin-svelte"],
      continuationDependency: "vite",
      lockedDependencies: [
        "@sveltejs/vite-plugin-svelte",
        "svelte",
        "vite",
        "esbuild-wasm",
      ],
    },
  },
  astro: {
    status: "stable",
    dependencies: {
      astro: "^1.6.12",
      "esbuild-wasm": "^0.15.16",
    },
    runtimeLock: {
      matchDependencies: ["astro", "esbuild-wasm"],
      continuationDependency: "astro",
      lockedDependencies: ["astro", "esbuild-wasm"],
    },
  },
} as const satisfies Record<string, SandpackTemplateProfile>;

export type OpenBuilderTemplateName =
  keyof typeof OPEN_BUILDER_TEMPLATE_MANIFEST;

export const OPEN_BUILDER_TEMPLATE_NAMES = Object.freeze(
  Object.keys(OPEN_BUILDER_TEMPLATE_MANIFEST) as OpenBuilderTemplateName[],
);

export function isOpenBuilderTemplateName(
  template: string,
): template is OpenBuilderTemplateName {
  return template in OPEN_BUILDER_TEMPLATE_MANIFEST;
}

export function applyOpenBuilderTemplateProfile(
  template: OpenBuilderTemplateName,
  files: ProjectFiles,
): { ok: true; status: TemplateProfileStatus } | { ok: false; error: string } {
  const packagePath = findPackageJsonPath(files);
  if (!packagePath) {
    return {
      ok: false,
      error: `template "${template}" does not contain package.json`,
    };
  }

  const packageJson = parsePackageJsonRecord(files[packagePath]);
  if (!packageJson) {
    return {
      ok: false,
      error: `template "${template}" contains invalid package.json`,
    };
  }

  const profile: SandpackTemplateProfile =
    OPEN_BUILDER_TEMPLATE_MANIFEST[template];
  packageJson.dependencies = { ...profile.dependencies };
  if (profile.devDependencies) {
    packageJson.devDependencies = { ...profile.devDependencies };
  } else {
    delete packageJson.devDependencies;
  }
  files[packagePath] = `${JSON.stringify(packageJson, null, 2)}\n`;

  if (profile.fileOverrides) {
    for (const [path, content] of Object.entries(profile.fileOverrides)) {
      files[path] = content;
    }
  }

  return { ok: true, status: profile.status };
}

export function preserveTemplateRuntimeDependencies(
  currentContent: string | undefined,
  requestedContent: string,
): { content: string; preservedDependencies: string[] } {
  if (!currentContent) {
    return { content: requestedContent, preservedDependencies: [] };
  }

  const current = parsePackageJsonRecord(currentContent);
  const requested = parsePackageJsonRecord(requestedContent);
  if (!current || !requested) {
    return { content: requestedContent, preservedDependencies: [] };
  }

  const profile = findRuntimeProfile(current);
  if (
    !profile?.runtimeLock ||
    !findDependency(requested, profile.runtimeLock.continuationDependency)
  ) {
    return { content: requestedContent, preservedDependencies: [] };
  }

  const preservedDependencies: string[] = [];
  for (const name of profile.runtimeLock.lockedDependencies) {
    const existing = findDependency(current, name);
    if (!existing) continue;
    const requestedDependency = findDependency(requested, name);
    if (
      requestedDependency?.section === existing.section &&
      requestedDependency.version === existing.version
    ) {
      continue;
    }
    setDependency(requested, name, existing);
    preservedDependencies.push(name);
  }

  return {
    content:
      preservedDependencies.length > 0
        ? `${JSON.stringify(requested, null, 2)}\n`
        : requestedContent,
    preservedDependencies,
  };
}

function findRuntimeProfile(
  packageJson: PackageJsonRecord,
): SandpackTemplateProfile | null {
  const profiles = (
    Object.values(OPEN_BUILDER_TEMPLATE_MANIFEST) as SandpackTemplateProfile[]
  )
    .filter((profile) => profile.runtimeLock)
    .sort(
      (left, right) =>
        (right.runtimeLock?.matchDependencies.length ?? 0) -
        (left.runtimeLock?.matchDependencies.length ?? 0),
    );

  return (
    profiles.find((profile) =>
      profile.runtimeLock?.matchDependencies.every((name) =>
        Boolean(findDependency(packageJson, name)),
      ),
    ) ?? null
  );
}

function findPackageJsonPath(files: ProjectFiles): string | undefined {
  return Object.keys(files).find(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
}

function parsePackageJsonRecord(content: string): PackageJsonRecord | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PackageJsonRecord)
      : null;
  } catch {
    return null;
  }
}

function findDependency(
  packageJson: PackageJsonRecord,
  name: string,
): { section: DependencySection; version: string } | null {
  for (const section of ["dependencies", "devDependencies"] as const) {
    const version = packageJson[section]?.[name];
    if (typeof version === "string") return { section, version };
  }
  return null;
}

function setDependency(
  packageJson: PackageJsonRecord,
  name: string,
  dependency: { section: DependencySection; version: string },
): void {
  for (const section of ["dependencies", "devDependencies"] as const) {
    if (packageJson[section]) delete packageJson[section]?.[name];
  }
  packageJson[dependency.section] = {
    ...(packageJson[dependency.section] ?? {}),
    [name]: dependency.version,
  };
}
