import { describe, expect, it } from "vitest";
import { assessProjectRuntime } from "./capabilities";
import { digestProjectSnapshot } from "./snapshot";

function project(dependencies: Record<string, string>) {
  return {
    "index.html": "<div id='app'></div>",
    "package.json": JSON.stringify({ dependencies, scripts: { dev: "vite" } }),
  };
}

describe("project runtime capabilities", () => {
  it("separates preview support from deployable static builds", () => {
    expect(
      assessProjectRuntime(project({ next: "12.1.6", react: "18.2.0" })),
    ).toMatchObject({
      template: "nextjs",
      preview: { supported: true },
      staticBuild: { supported: false },
    });
    expect(
      assessProjectRuntime(project({ vite: "4.2.0", react: "19.0.0" })),
    ).toMatchObject({
      template: "vite-react",
      preview: { supported: true },
      staticBuild: { supported: true },
    });
  });
  it("rejects known incompatible Vite versions without rewriting dependencies", () => {
    const files = project({ vite: "^6.0.0", vue: "3.5.0" });
    const before = { ...files };
    expect(assessProjectRuntime(files).preview.supported).toBe(false);
    expect(files).toEqual(before);
  });
  it("allows unresolved registry tags to be tested but does not promise a Vite4 build", () => {
    expect(assessProjectRuntime(project({ vite: "latest" }))).toMatchObject({
      preview: { supported: true },
      staticBuild: { supported: false },
    });
  });
  it("rejects invalid manifests, absent entries, and local dependencies", () => {
    expect(
      assessProjectRuntime({ "package.json": "{" }).preview.supported,
    ).toBe(false);
    expect(
      assessProjectRuntime({ "README.md": "hello" }).preview.supported,
    ).toBe(false);
    expect(
      assessProjectRuntime(project({ foo: "workspace:*" })).preview.supported,
    ).toBe(false);
  });
  it("accepts standalone static files", () => {
    expect(assessProjectRuntime({ "index.html": "Hello" })).toMatchObject({
      template: "static",
      preview: { supported: true },
      staticBuild: { supported: true },
    });
  });
  it("binds verification to the exact file and resource contents", async () => {
    const files = { "index.html": "Hello" };
    const asset = {
      path: "font.woff2",
      digest: "a",
      size: 4,
      mimeType: "font/woff2",
    };
    const first = await digestProjectSnapshot(files, [asset]);
    expect(await digestProjectSnapshot({ ...files }, [{ ...asset }])).toBe(
      first,
    );
    expect(
      await digestProjectSnapshot(files, [{ ...asset, digest: "b" }]),
    ).not.toBe(first);
    expect(
      await digestProjectSnapshot({ "index.html": "Changed" }, [asset]),
    ).not.toBe(first);
  });
});
