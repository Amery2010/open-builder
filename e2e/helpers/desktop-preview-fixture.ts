import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { SandpackPreview, SandpackProvider } from "@codesandbox/sandpack-react";
import { PreviewCompilationStatus } from "../../src/components/code-viewer/PreviewCompilationStatus";

/** Exercise the desktop runtime configuration with a real vendor client. */
export function mountDesktopStaticPreview(): void {
  const files = Object.freeze({
    "index.html":
      "<!doctype html><html><head><title>Imported source</title></head><body><h1>Desktop static source</h1></body></html>",
  });
  createRoot(document.getElementById("root")!).render(
    createElement(
      SandpackProvider,
      { template: "static", customSetup: { environment: "parcel" }, files },
      createElement(PreviewCompilationStatus, {
        identity: "desktop-import-fixture",
        files,
        onRuntimeChange: () => {},
        onRetry: () => {},
      }),
      createElement(SandpackPreview, {
        showOpenInCodeSandbox: false,
        showRefreshButton: false,
      }),
    ),
  );
}
