import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { SandpackPreview, SandpackProvider } from "@codesandbox/sandpack-react";
import {
  CodeOnlyPreviewNotice,
  PreviewCompilationStatus,
} from "../../src/components/code-viewer/PreviewCompilationStatus";
import { Toaster } from "../../src/components/ui/sonner";
import "../../src/index.css";

/** Mobile chat does not mount a code-only editor; observe the notice separately. */
export function mountCodeOnlyPreviewNotice(): void {
  const host = document.body.appendChild(document.createElement("div"));
  createRoot(host).render(createElement(CodeOnlyPreviewNotice));
}

/** Exercise the desktop runtime configuration with a real vendor client. */
export function mountDesktopStaticPreview(): void {
  const files = Object.freeze({
    "index.html":
      "<!doctype html><html><head><title>Imported source</title></head><body><h1>Desktop static source</h1></body></html>",
  });
  createRoot(document.getElementById("root")!).render(
    createElement(
      Fragment,
      null,
      createElement(Toaster),
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
    ),
  );
}
