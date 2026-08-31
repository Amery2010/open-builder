const NONCE_ENV = "OPEN_BUILDER_PI_PROBE_NONCE";
const COMMAND = "open-builder-probe-auth";
const AUTH_SOURCES = new Set([
  "stored",
  "runtime",
  "environment",
  "fallback",
  "models_json_key",
  "models_json_command",
]);

function providerAuthStatus(ctx) {
  try {
    if (!ctx.model || !ctx.modelRegistry) {
      return { configured: false, source: null };
    }
    const status = ctx.modelRegistry.getProviderAuthStatus(ctx.model.provider);
    return {
      configured: status?.configured === true,
      source:
        typeof status?.source === "string" && AUTH_SOURCES.has(status.source)
          ? status.source
          : null,
    };
  } catch {
    return { configured: false, source: null };
  }
}

export default function openBuilderPiProbeExtension(pi) {
  const nonce = process.env[NONCE_ENV];
  delete process.env[NONCE_ENV];
  if (typeof nonce !== "string" || !/^[0-9a-f-]{36}$/.test(nonce)) {
    throw new Error("Open Builder Pi probe nonce is invalid");
  }

  pi.registerCommand(COMMAND, {
    description: "Open Builder authentication-source probe",
    handler(args, ctx) {
      if (args !== nonce || ctx.mode !== "rpc" || !ctx.model) {
        ctx.ui.notify("Open Builder authentication probe rejected.", "error");
        return;
      }
      const status = providerAuthStatus(ctx);
      ctx.ui.notify(
        JSON.stringify({
          type: "open_builder_pi_auth_probe",
          version: 1,
          nonce,
          provider: ctx.model.provider,
          configured: status.configured,
          source: status.source,
        }),
        "info",
      );
    },
  });
}
