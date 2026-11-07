import JSZip from "jszip";
import type { ProjectAssets, ProjectFiles } from "../../types";
import { readProjectAssetBytes } from "../project-assets/core";
import { isSensitiveProjectPath } from "../utils/project-file-policy";
import { assessProjectRuntime } from "../project-runtime/capabilities";
import {
  abortable,
  createRuntimeFrame,
  digestProjectSnapshot,
} from "../project-runtime/snapshot";
import {
  BUILD_OUTPUT_PATH,
  BUILD_SCRIPT_PATH,
  BUILD_STATUS_PATH,
  COMPATIBILITY_BUILD_SCRIPT,
} from "./build-script";

export interface BuildStaticDeploymentInput {
  files: ProjectFiles;
  assets?: ProjectAssets;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface StaticDeployment {
  blob: Blob;
  digest: string;
  files: string[];
  mode: "static" | "vite4-compatibility";
}

function safeArtifactPath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === ".." || !part) &&
    !/[\u0000-\u001f]/.test(path)
  );
}

function isPreviewFile(path: string): boolean {
  return /(?:^|\/)__open_builder_/.test(path);
}

export function validateDeploymentFiles(
  files: Readonly<Record<string, Uint8Array>>,
): void {
  if (!files["index.html"]?.length)
    throw new Error(
      "The build did not produce a root index.html deployment entry.",
    );
  for (const path of Object.keys(files)) {
    if (!safeArtifactPath(path) || isPreviewFile(path))
      throw new Error(`Invalid deployment output path: ${path}`);
    if (path.endsWith("."))
      throw new Error(
        `The build produced an asset without a usable extension: ${path}`,
      );
  }
}

export async function buildStaticDeployment(
  input: BuildStaticDeploymentInput,
): Promise<StaticDeployment> {
  const files = { ...input.files };
  const assets = { ...input.assets };
  const capabilities = assessProjectRuntime(files);
  if (!capabilities.staticBuild.supported)
    throw new Error(capabilities.staticBuild.reason);
  input.signal.throwIfAborted();
  const digest = await digestProjectSnapshot(files, Object.values(assets));
  const binary = Object.fromEntries(
    await Promise.all(
      Object.entries(assets).map(
        async ([path, asset]) =>
          [path, await readProjectAssetBytes(asset)] as const,
      ),
    ),
  );
  input.signal.throwIfAborted();
  const mode =
    capabilities.template === "static" ? "static" : "vite4-compatibility";
  let output: Record<string, Uint8Array>;
  if (mode === "static") {
    output = {};
    for (const [path, content] of Object.entries(files)) {
      if (
        !isPreviewFile(path) &&
        !isSensitiveProjectPath(path) &&
        !/(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|design-project\.json)$/.test(
          path,
        )
      )
        output[path] = new TextEncoder().encode(content);
    }
    Object.assign(output, binary);
    // Managed public resources use root-relative URLs in both preview adapters.
    for (const [path, bytes] of Object.entries(output)) {
      if (!path.startsWith("public/")) continue;
      const publicPath = path.slice(7);
      if (output[publicPath])
        throw new Error(
          `Public resource conflicts with deployment file: ${publicPath}`,
        );
      output[publicPath] = bytes;
    }
  } else {
    output = await buildWithNodebox(files, binary, input);
  }
  validateDeploymentFiles(output);
  input.signal.throwIfAborted();
  input.onProgress?.("Packaging deployment files…");
  const zip = new JSZip();
  for (const [path, bytes] of Object.entries(output)) zip.file(path, bytes);
  const blob = await abortable(
    zip.generateAsync({ type: "blob" }),
    input.signal,
  );
  input.signal.throwIfAborted();
  return { blob, digest, files: Object.keys(output).sort(), mode };
}

async function buildWithNodebox(
  files: ProjectFiles,
  binary: Record<string, Uint8Array>,
  input: BuildStaticDeploymentInput,
): Promise<Record<string, Uint8Array>> {
  const controller = new AbortController();
  const relay = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", relay, { once: true });
  if (input.signal.aborted) relay();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          "The browser build timed out. Retry after checking the network and project dependencies.",
        ),
      ),
    120_000,
  );
  const frame = createRuntimeFrame("Static deployment build");
  let shell: import("@codesandbox/nodebox").ShellProcess | undefined;
  try {
    if (
      [BUILD_SCRIPT_PATH, BUILD_STATUS_PATH, BUILD_OUTPUT_PATH].some(
        (reserved) =>
          Object.keys(files).some(
            (path) => path === reserved || path.startsWith(`${reserved}/`),
          ),
      )
    )
      throw new Error("The project uses a reserved Open Builder build path.");
    input.onProgress?.("Starting browser compatibility build…");
    const { Nodebox } = await import("@codesandbox/nodebox");
    controller.signal.throwIfAborted();
    const runtime = new Nodebox({ iframe: frame });
    await abortable(runtime.connect(), controller.signal);
    const buildFiles = Object.fromEntries(
      Object.entries(files).filter(([path]) => !isPreviewFile(path)),
    );
    await abortable(
      runtime.fs.init({
        ...buildFiles,
        ...binary,
        [BUILD_SCRIPT_PATH]: COMPATIBILITY_BUILD_SCRIPT,
      }),
      controller.signal,
    );
    shell = runtime.shell.create();
    let tail = "";
    const log = (message: string) => {
      tail = `${tail}${message}`.slice(-12_000);
      input.onProgress?.(message);
    };
    shell.stdout.on("data", log);
    shell.stderr.on("data", log);
    // Shell exit listeners require a running process ID in Nodebox.
    await abortable(
      shell.runCommand("node", [BUILD_SCRIPT_PATH]),
      controller.signal,
    );
    const exitCode = await abortable(
      new Promise<number>((resolve, reject) => {
        void shell!.on("exit", resolve).catch(reject);
      }),
      controller.signal,
    );
    const marker = JSON.parse(
      await abortable(
        runtime.fs.readFile(BUILD_STATUS_PATH, "utf-8"),
        controller.signal,
      ),
    ) as { ok?: boolean; error?: string };
    if (exitCode !== 0 || marker.ok !== true)
      throw new Error(
        marker.error || tail || `Build failed with exit code ${exitCode}.`,
      );
    const output: Record<string, Uint8Array> = {};
    async function readDirectory(path: string): Promise<void> {
      const names = await abortable(
        runtime.fs.readdir(path),
        controller.signal,
      );
      for (const name of names) {
        if (
          !name ||
          name === "." ||
          name === ".." ||
          name.includes("/") ||
          name.includes("\\")
        )
          throw new Error("Invalid build artifact path.");
        const child = `${path}/${name}`;
        const stat = await abortable(runtime.fs.stat(child), controller.signal);
        if (stat.type === "dir") await readDirectory(child);
        else if (stat.type === "file")
          output[child.slice(BUILD_OUTPUT_PATH.length + 1)] = await abortable(
            runtime.fs.readFile(child),
            controller.signal,
          );
        else
          throw new Error(
            "Symbolic links cannot be included in a static deployment.",
          );
      }
    }
    await readDirectory(BUILD_OUTPUT_PATH);
    return output;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", relay);
    if (shell) {
      shell.stdout.removeAllListeners();
      shell.stderr.removeAllListeners();
      void shell.kill().catch(() => undefined);
    }
    frame.remove();
  }
}
