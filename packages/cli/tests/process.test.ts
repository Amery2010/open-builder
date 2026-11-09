import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ProjectService } from "../src/project-service.js";
import { resolveTask } from "../src/node/process.js";

let root: string;
let service: ProjectService;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "builder task 中文 ")),
  );
  service = new ProjectService();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function fixture(
  script: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "task-fixture",
      private: true,
      scripts: Object.fromEntries(
        ["build", "typecheck", "lint", "test"].map((task) => [
          task,
          `node task.cjs ${task}`,
        ]),
      ),
      ...extra,
    }),
  );
  await writeFile(path.join(root, "task.cjs"), script);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("explicit project verification", () => {
  it("reports an unavailable package manager instead of attempting installation", async () => {
    await fixture("process.exit(99)");
    vi.stubEnv("PATH", "");
    await expect(service.verify(root, { task: "build" })).rejects.toMatchObject(
      { code: "PACKAGE_MANAGER_NOT_FOUND", exitCode: 2 },
    );
  });

  it("rejects watch scripts and invalid timeouts before execution", async () => {
    await fixture("process.exit(99)", { scripts: { test: "vitest --watch" } });
    await expect(service.verify(root, { task: "test" })).rejects.toMatchObject({
      code: "WATCH_TASK",
    });
    await expect(
      service.verify(root, { task: "test", timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
  });
  it.each(["build", "typecheck", "lint", "test"])(
    "runs the %s script with CI enabled without installing dependencies",
    async (task) => {
      await fixture("console.log(process.argv[2] + ':' + process.env.CI)");
      const result = await service.verify(root, { task });
      expect(result.status).toBe("passed");
      expect(result.log).toContain(`${task}:1`);
      expect(result.packageManager).toBe("npm");
    },
  );

  it.each(["pnpm@0.0.0", "npm@0.0.0"])(
    "uses explicitly selected installed pnpm without downloading %s",
    async (packageManager) => {
      await fixture("console.log('pnpm task')", { packageManager });
      const result = await service.verify(root, {
        task: "build",
        packageManager: "pnpm",
      });
      expect(result.status, result.log).toBe("passed");
      expect(result.packageManager).toBe("pnpm");
    },
  );

  it("returns nonzero script results and redacts split credentials before emitting progress", async () => {
    await fixture(
      "process.stdout.write('API_KEY=super'); setTimeout(() => { process.stdout.write('secretvalue\\n'); process.stderr.write('Authorization: Bearer abcdefgh\\n'); process.exitCode = 7; }, 20)",
    );
    const progress: string[] = [];
    const result = await service.verify(root, {
      task: "build",
      onProgress: (text) => progress.push(text),
    });
    expect(result.status).toBe("failed");
    expect(result.exitCode).not.toBe(0);
    expect(result.log + progress.join("")).not.toMatch(
      /supersecretvalue|abcdefgh/,
    );
    expect(result.log).toContain("[REDACTED]");
  });

  it("redacts multiline private keys across output chunks", async () => {
    await fixture(
      "console.log('-----BEGIN PRIVATE KEY-----'); setTimeout(() => { console.log('sensitivekeymaterial'); console.log('-----END PRIVATE KEY-----'); }, 10)",
    );
    const result = await service.verify(root, { task: "build" });
    expect(result.log).not.toContain("sensitivekeymaterial");
    expect(result.log).toContain("[REDACTED PRIVATE KEY]");
  });

  it("reports task applicability, missing scripts and workspace roots without running", async () => {
    await expect(service.verify(root, { task: "build" })).rejects.toMatchObject(
      { code: "TASK_NOT_APPLICABLE" },
    );
    await fixture("process.exit(99)", { scripts: {} });
    await expect(service.verify(root, { task: "build" })).rejects.toMatchObject(
      { code: "MISSING_SCRIPT" },
    );
    await fixture("process.exit(99)", { workspaces: ["packages/*"] });
    await expect(service.verify(root, { task: "build" })).rejects.toMatchObject(
      { code: "WORKSPACE_ROOT" },
    );
    await expect(service.verify(root, { task: "dev" })).rejects.toMatchObject({
      code: "UNSUPPORTED_TASK",
    });
  });

  it("uses package-manager precedence and refuses conflicting or unsupported lockfiles", async () => {
    await fixture("", { packageManager: "pnpm@10.30.3" });
    expect(await resolveTask(root, { task: "build" })).toBe("pnpm");
    expect(
      await resolveTask(root, { task: "build", packageManager: "npm" }),
    ).toBe("npm");
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await expect(resolveTask(root, { task: "build" })).rejects.toMatchObject({
      code: "PACKAGE_MANAGER_CONFLICT",
    });
    await rm(path.join(root, "package-lock.json"));
    await writeFile(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'",
    );
    expect(await resolveTask(root, { task: "build" })).toBe("pnpm");
    await expect(
      resolveTask(root, { task: "build", packageManager: "npm" }),
    ).rejects.toMatchObject({ code: "PACKAGE_MANAGER_CONFLICT" });
    await writeFile(path.join(root, "yarn.lock"), "");
    await expect(resolveTask(root, { task: "build" })).rejects.toMatchObject({
      code: "UNSUPPORTED_PACKAGE_MANAGER",
    });
  });

  it("times out and cancels descendants in the managed process group or job", async () => {
    await fixture(
      "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync('child.pid',String(child.pid)); console.log('child-ready'); setInterval(()=>{},1000)",
    );
    const controller = new AbortController();
    const result = await service.verify(root, {
      task: "build",
      signal: controller.signal,
      onProgress: (message) => {
        if (message.includes("child-ready")) controller.abort();
      },
    });
    expect(result.status).toBe("cancelled");
    const childPid = Number(
      await readFile(path.join(root, "child.pid"), "utf8"),
    );
    await expect.poll(() => alive(childPid), { timeout: 5_000 }).toBe(false);
    const timed = await service.verify(root, {
      task: "build",
      timeoutMs: process.platform === "win32" ? 8_000 : 1_000,
    });
    expect(timed.status).toBe("timed-out");
    const timedPid = Number(
      await readFile(path.join(root, "child.pid"), "utf8"),
    );
    await expect.poll(() => alive(timedPid), { timeout: 5_000 }).toBe(false);
  });

  it("settles and cleans up when the package-manager parent exits before a descendant closes inherited stdio", async () => {
    await fixture(
      "const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync('orphan.pid',String(child.pid));child.unref();process.exit(0)",
    );
    const started = Date.now();
    const timeoutMs = process.platform === "win32" ? 8_000 : 1_000;
    const result = await service.verify(root, { task: "build", timeoutMs });
    expect(result.status).toBe("passed");
    expect(Date.now() - started).toBeLessThan(timeoutMs + 5_000);
    const orphanPid = Number(
      await readFile(path.join(root, "orphan.pid"), "utf8"),
    );
    await expect.poll(() => alive(orphanPid), { timeout: 5_000 }).toBe(false);
  });

  it("cleans up when a progress observer throws", async () => {
    await fixture("console.log('observer-ready');setInterval(()=>{},1000)");
    await expect(
      service.verify(root, {
        task: "build",
        onProgress: (message) => {
          if (message.includes("observer-ready"))
            throw new Error("Observer failed");
        },
      }),
    ).rejects.toMatchObject({ code: "PROGRESS_FAILED" });
  });

  it.runIf(process.platform === "win32")(
    "the Windows job kills its entire live subtree when its supervisor is forcibly terminated",
    async () => {
      await fixture(
        "const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync('job-orphan.pid',String(child.pid));console.log('job-orphan-ready');setInterval(()=>{},1000)",
      );
      const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const helper = fileURLToPath(
        new URL("../src/node/windows-job.ps1", import.meta.url),
      );
      const supervisor = spawn(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helper,
        ],
        {
          cwd: root,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            OPEN_BUILDER_VERIFY_NODE: process.execPath,
            OPEN_BUILDER_VERIFY_PARENT: String(process.pid),
            OPEN_BUILDER_VERIFY_SPAWN: createRequire(import.meta.url).resolve(
              "cross-spawn",
            ),
            OPEN_BUILDER_VERIFY_MANAGER: "npm",
            OPEN_BUILDER_VERIFY_TASK: "build",
          },
        },
      );
      const closed = new Promise<void>((resolve, reject) => {
        supervisor.once("close", () => resolve());
        supervisor.once("error", reject);
      });
      try {
        await expect
          .poll(
            async () => {
              try {
                return Number(
                  await readFile(path.join(root, "job-orphan.pid"), "utf8"),
                );
              } catch {
                return 0;
              }
            },
            { timeout: 12_000 },
          )
          .toBeGreaterThan(0);
        const orphanPid = Number(
          await readFile(path.join(root, "job-orphan.pid"), "utf8"),
        );
        expect(alive(orphanPid)).toBe(true);
        expect(supervisor.exitCode).toBeNull();
        supervisor.kill("SIGKILL");
        await closed;
        await expect
          .poll(() => alive(orphanPid), { timeout: 5_000 })
          .toBe(false);
      } finally {
        if (supervisor.exitCode === null && supervisor.signalCode === null)
          supervisor.kill("SIGKILL");
        await closed;
      }
    },
  );

  it("cancels a queued operation without executing its script", async () => {
    await fixture(
      "require('node:fs').appendFileSync('runs','x'); console.log('running'); setInterval(()=>{},1000)",
    );
    const running = new AbortController();
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const first = service.verify(root, {
      task: "build",
      signal: running.signal,
      onProgress: (line) => {
        if (line.includes("running")) resolveReady();
      },
    });
    await ready;
    const queued = new AbortController();
    const second = service.verify(root, {
      task: "test",
      signal: queued.signal,
    });
    const rejected = expect(second).rejects.toMatchObject({
      code: "CANCELLED",
    });
    queued.abort();
    await rejected;
    running.abort();
    await first;
    expect(await readFile(path.join(root, "runs"), "utf8")).toBe("x");
  });
});
