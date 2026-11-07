import type {
  SandpackClient,
  SandboxSetup,
} from "@codesandbox/sandpack-client";
import { SANDBOX_TEMPLATES } from "@codesandbox/sandpack-react";
import type { ProjectFiles } from "../../types";
import {
  addProjectAssetModules,
  createProjectAssetRecord,
  projectFilesForSandpack,
  type StagedProjectAsset,
} from "../project-assets/core";
import { projectSandpackRuntime } from "../../components/code-viewer/sandpack-runtime-preview";
import { projectReactPreview } from "../../components/code-viewer/sandpack-react-preview";
import { projectStaticPreview } from "../../components/code-viewer/sandpack-static-preview";
import {
  assessProjectRuntime,
  type ProjectRuntimeCapabilities,
} from "./capabilities";
import {
  abortable,
  createRuntimeFrame,
  digestProjectSnapshot,
} from "./snapshot";

export type ProjectRuntimeErrorKind =
  "unsupported" | "compilation" | "unavailable";
export class ProjectRuntimeValidationError extends Error {
  constructor(
    readonly kind: ProjectRuntimeErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectRuntimeValidation {
  digest: string;
  template: string;
  previewMode: "sandpack";
  capabilities: ProjectRuntimeCapabilities;
}

export interface ValidateProjectRuntimeInput {
  files: ProjectFiles;
  assets?: readonly StagedProjectAsset[];
  template?: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

/** Staged assets are projected without granting them durable Conversation ownership. */
export async function validateProjectRuntime(
  input: ValidateProjectRuntimeInput,
): Promise<ProjectRuntimeValidation> {
  input.signal.throwIfAborted();
  const files = { ...input.files };
  const staged = [...(input.assets ?? [])];
  const capabilities = assessProjectRuntime(files);
  if (!capabilities.preview.supported)
    throw new ProjectRuntimeValidationError(
      "unsupported",
      capabilities.preview.reason ?? "Unsupported project.",
    );
  const template = capabilities.template;
  const records = Object.fromEntries(
    staged.map((asset) => [
      asset.path,
      createProjectAssetRecord(asset, `sha256:${asset.digest}`),
    ]),
  );
  const stagedByPath = new Map(staged.map((asset) => [asset.path, asset]));
  const projected = await projectFilesForSandpack(
    addProjectAssetModules(files, records),
    records,
    async (asset) => {
      const source = stagedByPath.get(asset.path);
      if (!source) throw new Error(`Missing staged resource: ${asset.path}`);
      return new Uint8Array(await source.blob.arrayBuffer());
    },
  );
  const runtime = projectSandpackRuntime(projected, true, template);
  const desktopStatic =
    template === "static" && "__TAURI_INTERNALS__" in window;
  const staticProjection = projectStaticPreview(runtime.files, desktopStatic);
  const react = projectReactPreview(
    projected,
    staticProjection.files,
    template,
    true,
  );
  const base = SANDBOX_TEMPLATES[template as keyof typeof SANDBOX_TEMPLATES];
  const environment =
    react.customSetup?.environment ??
    (desktopStatic ? "parcel" : base?.environment);
  const setup: SandboxSetup = {
    files: Object.fromEntries(
      Object.entries(react.files).map(([path, code]) => [`/${path}`, { code }]),
    ),
    template: environment as SandboxSetup["template"],
    ...(react.customSetup?.entry ? { entry: react.customSetup.entry } : {}),
  };
  const controller = new AbortController();
  const relay = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", relay, { once: true });
  if (input.signal.aborted) relay();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new ProjectRuntimeValidationError(
          "unavailable",
          "Sandpack verification timed out. Check the network and retry; this does not prove the project version is unsupported.",
        ),
      ),
    90_000,
  );
  const frame = createRuntimeFrame("Project import verification");
  const probeId = crypto.randomUUID();
  let removeProbe = () => {};
  let documentReady = Promise.resolve();
  if (template === "static" && setup.files["/index.html"]) {
    documentReady = new Promise<void>((resolve, reject) => {
      const receive = (event: MessageEvent) => {
        if (
          event.source !== frame.contentWindow ||
          event.data?.type !== "open-builder:import-probe" ||
          event.data?.id !== probeId
        )
          return;
        if (event.data.error)
          reject(
            new ProjectRuntimeValidationError(
              "compilation",
              String(event.data.error),
            ),
          );
        else resolve();
      };
      window.addEventListener("message", receive);
      removeProbe = () => window.removeEventListener("message", receive);
    });
    // The static client announces done before native module scripts execute.
    void documentReady.catch(() => undefined);
    const document = new DOMParser().parseFromString(
      setup.files["/index.html"].code,
      "text/html",
    );
    const probe = document.createElement("script");
    probe.textContent = `(function(){var failed=false;function report(error){window.parent.postMessage({type:'open-builder:import-probe',id:${JSON.stringify(probeId)},error:error},'*');}window.addEventListener('error',function(e){failed=true;report(e.message || 'A project script or resource failed to load.');},true);window.addEventListener('unhandledrejection',function(e){failed=true;report(String(e.reason));});window.addEventListener('load',function(){setTimeout(function(){if(!failed)report(null);},250);});})();`;
    document.head.prepend(probe);
    setup.files["/index.html"] = {
      code: `<!doctype html>${document.documentElement.outerHTML}`,
    };
  }
  let client: SandpackClient | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    input.onProgress?.("Starting isolated Sandpack compilation…");
    const { loadSandpackClient } = await import("@codesandbox/sandpack-client");
    controller.signal.throwIfAborted();
    const loading = loadSandpackClient(frame, setup, {
      showOpenInCodeSandbox: false,
      showErrorScreen: false,
      showLoadingScreen: false,
    });
    // A cancelled vendor initialization can settle late. Dispose it too.
    void loading.then(
      (created) => {
        if (controller.signal.aborted) created.destroy();
      },
      () => undefined,
    );
    client = await abortable(loading, controller.signal);
    await abortable(
      new Promise<void>((resolve, reject) => {
        unsubscribe = client!.listen((message) => {
          if (message.type === "done") {
            if (message.compilatonError)
              reject(
                new ProjectRuntimeValidationError(
                  "compilation",
                  "The project failed Sandpack compilation. Fix its source or dependencies and retry.",
                ),
              );
            else resolve();
          } else if (
            message.type === "action" &&
            message.action === "show-error"
          ) {
            reject(
              new ProjectRuntimeValidationError(
                "compilation",
                message.message || "Sandpack could not compile the project.",
              ),
            );
          } else if (
            message.type === "action" &&
            message.action === "notification" &&
            message.notificationType === "error"
          ) {
            reject(
              new ProjectRuntimeValidationError("compilation", message.title),
            );
          }
        });
        // Attach the listener before asking the initialized client to compile.
        client!.updateSandbox(setup);
      }),
      controller.signal,
    );
    await abortable(documentReady, controller.signal);
    input.signal.throwIfAborted();
    const digest = await digestProjectSnapshot(files, staged);
    input.signal.throwIfAborted();
    return { digest, template, previewMode: "sandpack", capabilities };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof ProjectRuntimeValidationError) throw error;
    throw new ProjectRuntimeValidationError(
      "unavailable",
      `Sandpack verification could not complete: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", relay);
    unsubscribe?.();
    removeProbe();
    client?.destroy();
    frame.remove();
  }
}
