import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ConfirmationDialogHost } from "./components/ConfirmationDialogHost";
import { TooltipProvider } from "./components/ui/tooltip";
import "./index.css";

async function bootstrap() {
  // Desktop loads and installs the proxy before React effects can make network
  // calls. Ordinary web builds avoid downloading native interception code.
  if ("__TAURI_INTERNALS__" in window) {
    const { installProxy } = await import("./lib/infra/proxy");
    installProxy();
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider>
        <ConfirmationDialogHost />
        <App />
      </TooltipProvider>
    </StrictMode>,
  );
}

void bootstrap();
