import { lstat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { redactSecrets } from "@open-builder/core";
import { readTextFile } from "./files.js";
import { isFsError, ProjectError, throwIfCancelled } from "./errors.js";

export interface VerifyOptions {
  task: string;
  packageManager?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface VerifyResult {
  task: string;
  packageManager: "npm" | "pnpm";
  status: "passed" | "failed" | "timed-out" | "cancelled";
  exitCode: number | null;
  durationMs: number;
  log: string;
  logTruncated: boolean;
}

async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (isFsError(error, "ENOENT")) return false;
    throw error;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function resolveTask(
  directory: string,
  options: VerifyOptions,
): Promise<"npm" | "pnpm"> {
  if (!["build", "typecheck", "lint", "test"].includes(options.task))
    throw new ProjectError(
      "UNSUPPORTED_TASK",
      "Task must be build, typecheck, lint, or test.",
    );
  const manifestPath = path.join(directory, "package.json");
  if (!(await exists(manifestPath)))
    throw new ProjectError(
      "TASK_NOT_APPLICABLE",
      "This project has no package.json; no project script was executed.",
    );
  let pkg: unknown;
  try {
    pkg = JSON.parse(await readTextFile(manifestPath));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ProjectError(
        "INVALID_PACKAGE",
        "package.json is not valid JSON.",
      );
    throw error;
  }
  if (!record(pkg))
    throw new ProjectError(
      "INVALID_PACKAGE",
      "package.json must contain an object.",
    );
  if (
    pkg.workspaces !== undefined ||
    (await exists(path.join(directory, "pnpm-workspace.yaml")))
  )
    throw new ProjectError(
      "WORKSPACE_ROOT",
      "Select a concrete application directory; workspace-root task scheduling is not supported.",
    );
  const script = record(pkg.scripts) ? pkg.scripts[options.task] : undefined;
  if (typeof script !== "string" || !script.trim())
    throw new ProjectError(
      "MISSING_SCRIPT",
      `package.json does not define a ${options.task} script.`,
    );
  if (
    /(?:^|\s)(?:--watch(?:=true)?|--watchAll(?:=true)?|-w)(?:\s|$)/.test(script)
  )
    throw new ProjectError(
      "WATCH_TASK",
      "Verification requires a terminating script; watch tasks are not supported.",
    );
  const explicit = options.packageManager;
  if (explicit !== undefined && explicit !== "npm" && explicit !== "pnpm")
    throw new ProjectError(
      "UNSUPPORTED_PACKAGE_MANAGER",
      "Only npm and pnpm are supported.",
    );
  let declared: "npm" | "pnpm" | undefined;
  if (pkg.packageManager !== undefined) {
    if (
      typeof pkg.packageManager !== "string" ||
      !/^(npm|pnpm)(?:@[^\s]+)?$/.test(pkg.packageManager)
    )
      throw new ProjectError(
        "UNSUPPORTED_PACKAGE_MANAGER",
        "packageManager must declare npm or pnpm.",
      );
    declared = pkg.packageManager.split("@")[0] as "npm" | "pnpm";
  }
  const locks: Array<[string, string]> = [
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ];
  const detected = new Set<string>();
  for (const [file, manager] of locks)
    if (await exists(path.join(directory, file))) detected.add(manager);
  if (detected.has("yarn") || detected.has("bun"))
    throw new ProjectError(
      "UNSUPPORTED_PACKAGE_MANAGER",
      "This project contains a lockfile for an unsupported package manager.",
    );
  if (detected.size > 1)
    throw new ProjectError(
      "PACKAGE_MANAGER_CONFLICT",
      "Multiple package-manager lockfiles are present.",
    );
  const locked = [...detected][0] as "npm" | "pnpm" | undefined;
  if (
    locked &&
    ((declared && declared !== locked) || (explicit && explicit !== locked))
  )
    throw new ProjectError(
      "PACKAGE_MANAGER_CONFLICT",
      "The requested or declared package manager conflicts with the project lockfile.",
    );
  return explicit ?? declared ?? locked ?? "npm";
}

/** Buffer complete lines before redaction so split output chunks cannot reveal a credential. */
class DiagnosticLog {
  text = "";
  truncated = false;
  private readonly limit = 65_536;

  constructor(private readonly onProgress?: (message: string) => void) {}

  stream(): { write(chunk: Buffer): void; end(): void } {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let discard = false;
    let privateKey = false;
    const line = (value: string) => {
      if (privateKey) {
        if (/-----END [^-\r\n]*PRIVATE KEY-----/.test(value))
          privateKey = false;
        return;
      }
      if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/.test(value)) {
        privateKey = !/-----END [^-\r\n]*PRIVATE KEY-----/.test(value);
        this.append("[REDACTED PRIVATE KEY]\n");
        return;
      }
      this.append(redactSecrets(value, { diagnosticForms: true }));
    };
    const accept = (value: string) => {
      pending += value;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const complete = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (!discard && complete.length <= this.limit) line(complete);
        else {
          this.truncated = true;
          this.append("[long diagnostic line omitted]\n");
        }
        discard = false;
        newline = pending.indexOf("\n");
      }
      if (pending.length > this.limit) {
        pending = "";
        discard = true;
        this.truncated = true;
      }
    };
    return {
      write: (chunk) => accept(decoder.write(chunk)),
      end: () => {
        accept(decoder.end());
        if (discard) this.append("[long diagnostic line omitted]\n");
        else if (pending) line(pending);
        pending = "";
      },
    };
  }

  private append(value: string): void {
    this.text += value;
    if (this.text.length > this.limit) {
      this.text = this.text.slice(-this.limit);
      this.truncated = true;
    }
    this.onProgress?.(value);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isFsError(error, "ESRCH")) throw error;
  }
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // This is the supervisor, not npm. Its non-inheritable job handle owns all
    // descendants and remains alive even when the original npm PID has exited.
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      !child.kill("SIGKILL")
    )
      throw new ProjectError(
        "PROCESS_CLEANUP_FAILED",
        "Could not stop the Windows verification supervisor.",
        1,
      );
    return;
  }
  signalGroup(child.pid, "SIGTERM");
  // Descendants may outlive the immediate package-manager process.
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  signalGroup(child.pid, "SIGKILL");
}

async function prepareVerification(
  directory: string,
  packageManager: "npm" | "pnpm",
  task: string,
): Promise<() => ChildProcess> {
  const env = {
    ...process.env,
    CI: "1",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_ENABLE_STRICT: "0",
    // Use the operator's installed pnpm, rather than downloading a manifest's
    // pinned version. pnpm 10 and 11+ use different configuration names.
    ...(packageManager === "pnpm"
      ? {
          npm_config_manage_package_manager_versions: "false",
          pnpm_config_pm_on_fail: "ignore",
        }
      : {}),
  };
  if (process.platform !== "win32")
    return () =>
      spawn(packageManager, ["run", task], {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

  const pathKey = Object.keys(process.env).find(
    (key) => key.toLowerCase() === "path",
  );
  const search = pathKey ? (process.env[pathKey] ?? "") : "";
  let managerFound = false;
  for (const entry of search.split(path.delimiter).filter(Boolean)) {
    const folder = entry.replace(/^"|"$/g, "");
    for (const extension of [".exe", ".cmd", ".bat", ".com", ""]) {
      const candidate = path.join(folder, `${packageManager}${extension}`);
      if ((await exists(candidate)) && (await lstat(candidate)).isFile())
        managerFound = true;
    }
  }
  if (!managerFound)
    throw new ProjectError(
      "PACKAGE_MANAGER_NOT_FOUND",
      `${packageManager} is not available on PATH. Install/configure it before verification.`,
    );
  const sourceHelper = fileURLToPath(
    new URL("./windows-job.ps1", import.meta.url),
  );
  const helper = (await exists(sourceHelper))
    ? sourceHelper
    : fileURLToPath(new URL("../assets/windows-job.ps1", import.meta.url));
  if (!(await exists(helper)))
    throw new ProjectError(
      "WINDOWS_HELPER_MISSING",
      "Reinstall Open Builder: its Windows process supervisor is missing.",
    );
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return () =>
    nativeSpawn(
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
        cwd: directory,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...env,
          OPEN_BUILDER_VERIFY_NODE: process.execPath,
          OPEN_BUILDER_VERIFY_PARENT: String(process.pid),
          OPEN_BUILDER_VERIFY_SPAWN: createRequire(import.meta.url).resolve(
            "cross-spawn",
          ),
          OPEN_BUILDER_VERIFY_MANAGER: packageManager,
          OPEN_BUILDER_VERIFY_TASK: task,
        },
      },
    );
}

export async function verifyProjectTask(
  directory: string,
  options: VerifyOptions,
): Promise<VerifyResult> {
  throwIfCancelled(options.signal);
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  )
    throw new ProjectError(
      "INVALID_TIMEOUT",
      "timeoutMs must be a positive timer duration in milliseconds.",
    );
  const packageManager = await resolveTask(directory, options);
  throwIfCancelled(options.signal);
  const started = Date.now();
  const log = new DiagnosticLog(options.onProgress);
  const stdout = log.stream();
  const stderr = log.stream();
  const launch = await prepareVerification(
    directory,
    packageManager,
    options.task,
  );
  throwIfCancelled(options.signal);
  const child = launch();
  let executionFinished = false;
  let stopReason: "timed-out" | "cancelled" | undefined;
  let cleanup: Promise<void> | undefined;
  let cleanupError: unknown;
  let observerError: unknown;
  let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
  let rejectSettlement!: (error: unknown) => void;
  const settlement = new Promise<number | null>((resolve, reject) => {
    rejectSettlement = reject;
    child.once("error", (error) =>
      reject(
        new ProjectError(
          isFsError(error, "ENOENT")
            ? "PACKAGE_MANAGER_NOT_FOUND"
            : "PROCESS_START_FAILED",
          `${packageManager} could not start. Install/configure the package manager and process supervisor before verification.`,
          2,
        ),
      ),
    );
    child.once("close", resolve);
  });
  const beginCleanup = () => {
    if (cleanup) return;
    // Never wait indefinitely for a pipe held by an escaped/unresponsive process.
    // Failure to observe closure is an explicit cleanup failure, not success.
    cleanupDeadline = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      rejectSettlement(
        new ProjectError(
          "PROCESS_CLEANUP_FAILED",
          "Verification did not close its process streams after termination.",
          1,
        ),
      );
    }, 5_000);
    cleanup = terminateTree(child).catch((error: unknown) => {
      cleanupError = error;
      rejectSettlement(error);
    });
  };
  const stop = (reason: "timed-out" | "cancelled") => {
    if (executionFinished || stopReason) return;
    stopReason = reason;
    beginCleanup();
  };
  const executionTimer = setTimeout(() => stop("timed-out"), timeoutMs);
  child.once("exit", () => {
    executionFinished = true;
    clearTimeout(executionTimer);
    // close can wait forever for a descendant that inherited stdout/stderr.
    // On Windows the job supervisor has already cleaned its remaining job.
    beginCleanup();
  });
  const collect = (
    stream: ReturnType<DiagnosticLog["stream"]>,
    chunk: Buffer,
  ) => {
    try {
      stream.write(chunk);
    } catch (error) {
      observerError = error;
      stop("cancelled");
    }
  };
  child.stdout!.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr!.on("data", (chunk: Buffer) => collect(stderr, chunk));
  const cancel = () => stop("cancelled");
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const exitCode = await settlement;
    await cleanup;
    if (cleanupError) throw cleanupError;
    if (observerError)
      throw new ProjectError(
        "PROGRESS_FAILED",
        "The progress listener failed; verification was stopped and cleaned up.",
        1,
      );
    // A terminating verification script must not leave a POSIX process group behind.
    if (!stopReason && process.platform !== "win32" && child.pid)
      signalGroup(child.pid, "SIGKILL");
    stdout.end();
    stderr.end();
    return {
      task: options.task,
      packageManager,
      status: stopReason ?? (exitCode === 0 ? "passed" : "failed"),
      exitCode,
      durationMs: Date.now() - started,
      log: log.text,
      logTruncated: log.truncated,
    };
  } finally {
    clearTimeout(executionTimer);
    clearTimeout(cleanupDeadline);
    options.signal?.removeEventListener("abort", cancel);
    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    await cleanup;
  }
}
