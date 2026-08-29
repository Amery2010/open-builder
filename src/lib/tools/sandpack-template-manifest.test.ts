import { SANDBOX_TEMPLATES } from "@codesandbox/sandpack-react";
import { describe, expect, it } from "vitest";
import {
  applyOpenBuilderTemplateProfile,
  OPEN_BUILDER_TEMPLATE_MANIFEST,
  OPEN_BUILDER_TEMPLATE_NAMES,
  preserveTemplateRuntimeDependencies,
  type SandpackTemplateProfile,
} from "./sandpack-template-manifest";

describe("Open Builder Sandpack template manifest", () => {
  it("owns an explicit profile for every supported Sandpack template", () => {
    expect([...OPEN_BUILDER_TEMPLATE_NAMES].sort()).toEqual(
      Object.keys(SANDBOX_TEMPLATES).sort(),
    );
    expect(
      Object.values(OPEN_BUILDER_TEMPLATE_MANIFEST).every(
        (profile) => profile.status === "stable",
      ),
    ).toBe(true);
  });

  it.each(OPEN_BUILDER_TEMPLATE_NAMES)(
    "applies the complete dependency profile for %s",
    (template) => {
      const files = Object.fromEntries(
        Object.entries(SANDBOX_TEMPLATES[template].files).map(
          ([path, file]) => [
            path.startsWith("/") ? path.slice(1) : path,
            typeof file === "string" ? file : file.code,
          ],
        ),
      );

      const result = applyOpenBuilderTemplateProfile(template, files);
      const packageJson = JSON.parse(files["package.json"]);
      const profile: SandpackTemplateProfile =
        OPEN_BUILDER_TEMPLATE_MANIFEST[template];

      expect(result).toEqual({ ok: true, status: profile.status });
      expect(packageJson.dependencies).toEqual(profile.dependencies);
      expect(packageJson.devDependencies).toEqual(profile.devDependencies);
    },
  );

  it("keeps every React-based Sandpack template on React 18", () => {
    const reactProfiles = (
      Object.values(OPEN_BUILDER_TEMPLATE_MANIFEST) as SandpackTemplateProfile[]
    ).filter((profile) => "react" in profile.dependencies);

    expect(reactProfiles).toHaveLength(5);
    for (const profile of reactProfiles) {
      expect(profile.dependencies.react).toMatch(/^\^?18\./);
      expect(profile.dependencies["react-dom"]).toMatch(/^\^?18\./);
    }
  });

  it("applies refreshed dependencies and compatibility file overrides", () => {
    const files = {
      "package.json": JSON.stringify({
        dependencies: { react: "old", unexpected: "remove-me" },
        devDependencies: { typescript: "old" },
        main: "/index.tsx",
      }),
      "App.tsx": "export default function App(): JSX.Element {}",
      "index.tsx": "old",
    };

    const result = applyOpenBuilderTemplateProfile("react-ts", files);
    const packageJson = JSON.parse(files["package.json"]);

    expect(result).toEqual({ ok: true, status: "stable" });
    expect(packageJson).toMatchObject({
      main: "/index.tsx",
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1",
        "react-scripts": "^4.0.0",
      },
      devDependencies: {
        "@types/react": "^18.3.12",
        "@types/react-dom": "^18.3.1",
        typescript: "^4.9.5",
      },
    });
    expect(packageJson.dependencies.unexpected).toBeUndefined();
    expect(files["App.tsx"]).not.toContain("JSX.Element");
    expect(files["index.tsx"]).toContain("as HTMLElement");
  });
});

describe("template runtime dependency guard", () => {
  it.each(
    (
      Object.entries(OPEN_BUILDER_TEMPLATE_MANIFEST) as Array<
        [string, SandpackTemplateProfile]
      >
    ).filter(([, profile]) => profile.runtimeLock),
  )("preserves every declared runtime lock for %s", (_template, profile) => {
    if (!profile.runtimeLock) throw new Error("missing runtime lock");
    const currentPackageJson = {
      dependencies: { ...profile.dependencies },
      devDependencies: { ...profile.devDependencies },
    };
    const requestedPackageJson = structuredClone(currentPackageJson);
    const currentDependencies = {
      ...requestedPackageJson.dependencies,
      ...requestedPackageJson.devDependencies,
    };
    const requestedRuntimeDependencies = requestedPackageJson.dependencies as
      Record<string, string> | undefined;
    const requestedRuntimeDevDependencies =
      requestedPackageJson.devDependencies as
        Record<string, string> | undefined;
    for (const dependency of profile.runtimeLock.lockedDependencies) {
      if (dependency in (requestedRuntimeDependencies ?? {})) {
        requestedRuntimeDependencies![dependency] = "latest";
      } else if (dependency in (requestedRuntimeDevDependencies ?? {})) {
        requestedRuntimeDevDependencies![dependency] = "latest";
      }
    }

    const result = preserveTemplateRuntimeDependencies(
      JSON.stringify(currentPackageJson),
      JSON.stringify(requestedPackageJson),
    );
    const restored = JSON.parse(result.content);
    const restoredDependencies = {
      ...restored.dependencies,
      ...restored.devDependencies,
    };

    expect(currentDependencies).toEqual(
      expect.objectContaining(
        Object.fromEntries(
          profile.runtimeLock.lockedDependencies.map((name) => [
            name,
            expect.any(String),
          ]),
        ),
      ),
    );
    expect(result.preservedDependencies).toEqual(
      profile.runtimeLock.lockedDependencies,
    );
    for (const dependency of profile.runtimeLock.lockedDependencies) {
      expect(restoredDependencies[dependency]).toBe(
        currentDependencies[dependency],
      );
    }
  });

  it("preserves a specific Vite framework profile while allowing app dependencies", () => {
    const current = JSON.stringify({
      dependencies: { react: "^18.3.1" },
      devDependencies: {
        "@vitejs/plugin-react": "^4.3.4",
        typescript: "^5.9.3",
        vite: "4.2.0",
        "esbuild-wasm": "^0.17.12",
      },
    });
    const requested = JSON.stringify({
      dependencies: { react: "20.0.0" },
      devDependencies: {
        "@vitejs/plugin-react": "latest",
        typescript: "7.0.2",
        vite: "8.2.2",
      },
    });

    const result = preserveTemplateRuntimeDependencies(current, requested);
    const packageJson = JSON.parse(result.content);

    expect(result.preservedDependencies).toEqual([
      "@vitejs/plugin-react",
      "vite",
      "esbuild-wasm",
    ]);
    expect(packageJson.dependencies.react).toBe("20.0.0");
    expect(packageJson.devDependencies.typescript).toBe("7.0.2");
    expect(packageJson.devDependencies).toMatchObject({
      "@vitejs/plugin-react": "^4.3.4",
      vite: "4.2.0",
      "esbuild-wasm": "^0.17.12",
    });
  });

  it("keeps the complete Next.js and WASM compiler pairing", () => {
    const current = JSON.stringify({
      dependencies: {
        next: "12.1.6",
        react: "18.2.0",
        "react-dom": "18.2.0",
        "@next/swc-wasm-nodejs": "12.1.6",
      },
    });
    const requested = JSON.stringify({
      dependencies: {
        next: "15.0.0",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
    });

    const result = preserveTemplateRuntimeDependencies(current, requested);
    const packageJson = JSON.parse(result.content);

    expect(result.preservedDependencies).toEqual([
      "next",
      "@next/swc-wasm-nodejs",
      "react",
      "react-dom",
    ]);
    expect(packageJson.dependencies).toMatchObject({
      next: "12.1.6",
      react: "18.2.0",
      "react-dom": "18.2.0",
      "@next/swc-wasm-nodejs": "12.1.6",
    });
  });

  it("does not retain a runtime profile after the build tool is removed", () => {
    const requested = JSON.stringify({ dependencies: { express: "5.0.0" } });
    const result = preserveTemplateRuntimeDependencies(
      JSON.stringify({
        devDependencies: {
          vite: "4.2.0",
          "esbuild-wasm": "^0.17.12",
        },
      }),
      requested,
    );

    expect(result).toEqual({
      content: requested,
      preservedDependencies: [],
    });
  });
});
