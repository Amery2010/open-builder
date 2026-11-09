import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectService } from "../src/project-service.js";
import { writeNewFiles } from "../src/node/files.js";

let root: string;
let service: ProjectService;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "builder-project-")),
  );
  service = new ProjectService({ root });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("native projects", () => {
  it.each(["static", "react-ts"])(
    "initializes and checks the %s template with a real packaged design",
    async (template) => {
      const result = await service.initialize("中文 project", {
        template,
        design: "notion",
      });
      expect(result.files).toContain("tokens.css");
      const checked = await service.check("中文 project");
      expect(checked.report.ok).toBe(true);
      expect(checked.design).toEqual({
        designFilePresent: true,
        tokensFilePresent: true,
        tokensValid: true,
        staticWiringDetected: true,
      });
      expect(checked.notRun).toContain("visual-review");
      expect(checked.notRun).toContain("environment-secret-values");
      await expect(
        service.initialize("中文 project", { template }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    },
  );

  it("keeps current disk contents authoritative and skips sensitive/generated/binary/symlink data", async () => {
    await service.initialize("app", { template: "static" });
    const app = path.join(root, "app");
    await mkdir(path.join(app, "node_modules"));
    await writeFile(path.join(app, "node_modules", "broken.ts"), "<img />");
    await writeFile(path.join(app, ".env"), "API_KEY=secret-test-value");
    await writeFile(path.join(app, ".env.example"), "API_KEY=");
    await writeFile(path.join(app, "binary.dat"), Buffer.from([0, 1, 2]));
    await symlink(
      app,
      path.join(app, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(path.join(app, "unrelated.txt"), "user change");
    const checked = await service.check("app");
    expect(checked.scope.skipped).toEqual(
      expect.arrayContaining([
        { path: ".env", reason: "sensitive-path" },
        { path: "node_modules", reason: "generated-or-dependency-directory" },
        { path: "binary.dat", reason: "binary-file" },
        { path: "linked", reason: "symbolic-link" },
      ]),
    );
    expect(JSON.stringify(checked)).not.toContain("secret-test-value");
    expect(
      checked.report.issues.some((issue) => issue.category === "environment"),
    ).toBe(false);
    await writeFile(path.join(app, "index.html"), "<img src='photo.png'>");
    expect((await service.check("app")).report.ok).toBe(false);
    expect(await readFile(path.join(app, "unrelated.txt"), "utf8")).toBe(
      "user change",
    );
  });

  it.each([
    "../escape",
    "/absolute",
    "C:\\escape",
    "C:escape",
    "..\\escape",
    "\\\\server\\share",
  ])("rejects an escaping MCP path %s", async (project) => {
    await expect(
      service.initialize(project, { template: "static" }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
  });

  it("rejects intermediate symlinks, including a nonexistent init leaf below a link", async () => {
    const outside = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "builder-outside-")),
    );
    try {
      await symlink(
        outside,
        path.join(root, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        service.initialize("linked/app", { template: "static" }),
      ).rejects.toMatchObject({ code: "SYMLINK_PATH" });
      await expect(service.check("linked")).rejects.toMatchObject({
        code: "SYMLINK_PATH",
      });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("never partially applies a design when either target already exists", async () => {
    await service.initialize("app", { template: "static" });
    await writeFile(path.join(root, "app", "Tokens.CSS"), "user tokens");
    await expect(service.applyDesign("app", "linear")).rejects.toMatchObject({
      code: "DESIGN_CONFLICT",
    });
    expect(await readdir(path.join(root, "app"))).not.toContain("DESIGN.md");
    expect(await readFile(path.join(root, "app", "Tokens.CSS"), "utf8")).toBe(
      "user tokens",
    );
  });

  it("treats directories and symlinks as design conflicts", async () => {
    await service.initialize("app", { template: "static" });
    await mkdir(path.join(root, "app", "DESIGN.md"));
    await expect(service.applyDesign("app", "stripe")).rejects.toMatchObject({
      code: "DESIGN_CONFLICT",
    });
    await rm(path.join(root, "app", "DESIGN.md"), { recursive: true });
    await symlink(
      root,
      path.join(root, "app", "tokens.css"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(service.applyDesign("app", "stripe")).rejects.toMatchObject({
      code: "DESIGN_CONFLICT",
    });
  });

  it("serializes two writes and leaves style entry changes to the host", async () => {
    await service.initialize("app", { template: "static" });
    const style = await readFile(path.join(root, "app", "styles.css"), "utf8");
    const attempts = await Promise.allSettled([
      service.applyDesign("app", "stripe"),
      service.applyDesign("app", "linear"),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await readFile(path.join(root, "app", "styles.css"), "utf8")).toBe(
      style,
    );
    expect((await service.check("app")).design.staticWiringDetected).toBe(
      false,
    );
    await writeFile(
      path.join(root, "app", "unused.css"),
      '@import "./tokens.css";',
    );
    expect((await service.check("app")).design.staticWiringDetected).toBe(
      false,
    );
    await writeFile(
      path.join(root, "app", "styles.css"),
      `@import "./tokens.css";\n${style}`,
    );
    expect((await service.check("app")).design.staticWiringDetected).toBe(true);
  });

  it.each([
    '<link rel="canonical" href="./tokens.css">',
    '<link rel="preload" as="style" href="./tokens.css">',
    '<link rel="modulepreload" href="./runtime.js">',
    '<link rel="icon" href="./tokens.css">',
    '<link rel="stylesheet" disabled href="./tokens.css">',
    '<link rel="stylesheet" data-href="./tokens.css">',
    '<script type="application/json" src="./runtime.js"></script>',
    '<script type="importmap" src="./runtime.js"></script>',
    '<script type="text/javascript; charset=utf-8" src="./runtime.js"></script>',
  ])(
    "does not count a non-loading reference as token wiring: %s",
    async (tag) => {
      await service.initialize("app", { template: "static" });
      await service.applyDesign("app", "notion");
      const app = path.join(root, "app");
      await writeFile(path.join(app, "runtime.js"), 'import "./tokens.css";');
      const html = await readFile(path.join(app, "index.html"), "utf8");
      await writeFile(
        path.join(app, "index.html"),
        html.replace("</head>", `${tag}</head>`),
      );
      const checked = await service.check("app");
      expect(checked.design.staticWiringDetected).toBe(false);
      expect(checked.report.ok).toBe(false);
      expect(checked.report.issues).toContainEqual(
        expect.objectContaining({
          category: "design_system",
          severity: "warning",
          path: "tokens.css",
        }),
      );
    },
  );

  it.each([
    '<link rel="stylesheet" href="./tokens.css">',
    "<LINK HREF='./tokens.css' REL='StyleSheet'>",
    "<link rel=stylesheet href=./tokens.css>",
    '<script type="module" src="./runtime.js"></script>',
  ])("follows a loading reference to the tokens: %s", async (tag) => {
    await service.initialize("app", { template: "static" });
    await service.applyDesign("app", "notion");
    const app = path.join(root, "app");
    await writeFile(path.join(app, "runtime.js"), 'import "./tokens.css";');
    const html = await readFile(path.join(app, "index.html"), "utf8");
    await writeFile(
      path.join(app, "index.html"),
      html.replace("</head>", `${tag}</head>`),
    );
    const checked = await service.check("app");
    expect(checked.design.staticWiringDetected).toBe(true);
    expect(checked.report.ok).toBe(true);
  });

  it("reports malformed tokens and rolls back only files created by a failed write", async () => {
    await service.initialize("app", { template: "static" });
    const app = path.join(root, "app");
    await writeFile(path.join(app, "tokens.css"), ":root { --bg: red; }");
    expect((await service.check("app")).design.tokensValid).toBe(false);
    await writeFile(path.join(app, "existing.txt"), "keep me");
    await expect(
      writeNewFiles(app, {
        "created.txt": "temporary",
        "existing.txt": "replace",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(app)).not.toContain("created.txt");
    expect(await readFile(path.join(app, "existing.txt"), "utf8")).toBe(
      "keep me",
    );
  });

  it("validates the configured workspace before accepting requests", async () => {
    await expect(
      new ProjectService({ root: path.join(root, "missing") }).ready(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
