import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tauriConfig = JSON.parse(
  readFileSync(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
);
const capabilities = JSON.parse(
  readFileSync(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
    "utf8",
  ),
);
const tauriLib = readFileSync(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
const skillImporter = readFileSync(
  new URL("../src/lib/skills/importer.ts", import.meta.url),
  "utf8",
);
const settingsSystem = readFileSync(
  new URL("../src/store/settings/system.ts", import.meta.url),
  "utf8",
);
const localAgent = readFileSync(
  new URL("../src-tauri/src/local_agent.rs", import.meta.url),
  "utf8",
);
const localAgentAdapter = readFileSync(
  new URL("../src-tauri/src/local_agent_adapter.rs", import.meta.url),
  "utf8",
);
const localAgentProtocol = readFileSync(
  new URL("../src-tauri/src/local_agent_protocol.rs", import.meta.url),
  "utf8",
);
const localAgentCodex = readFileSync(
  new URL("../src-tauri/src/local_agent_codex.rs", import.meta.url),
  "utf8",
);
const localAgentClaude = readFileSync(
  new URL("../src-tauri/src/local_agent_claude.rs", import.meta.url),
  "utf8",
);
const localAgentClaudeRuntime = localAgentClaude.split("#[cfg(test)]", 1)[0];
const localAgentAntigravity = readFileSync(
  new URL("../src-tauri/src/local_agent_antigravity.rs", import.meta.url),
  "utf8",
);
const design = readFileSync(
  new URL("../src-tauri/src/design.rs", import.meta.url),
  "utf8",
);
const mcpStdio = readFileSync(
  new URL("../src-tauri/src/mcp_stdio.rs", import.meta.url),
  "utf8",
);
const localAgentBridge = readFileSync(
  new URL("../src-tauri/src/local_agent_bridge.rs", import.meta.url),
  "utf8",
);
const failures = [];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function checkPiProbeExtensionConformance() {
  const nonce = "123e4567-e89b-12d3-a456-426614174000";
  const previousNonce = process.env.OPEN_BUILDER_PI_PROBE_NONCE;
  const registeredCommands = new Map();
  const notifications = [];
  let authSource = "stored";
  try {
    process.env.OPEN_BUILDER_PI_PROBE_NONCE = nonce;
    const extensionUrl = new URL(
      "../src-tauri/src/local_agent_pi_probe_extension.mjs",
      import.meta.url,
    );
    const imported = await import(
      `${extensionUrl.href}?security-conformance=${Date.now()}`
    );
    imported.default({
      registerCommand(name, command) {
        registeredCommands.set(name, command);
      },
    });
    if (process.env.OPEN_BUILDER_PI_PROBE_NONCE !== undefined) {
      throw new Error(
        "probe extension retained its nonce environment variable",
      );
    }
    const command = registeredCommands.get("open-builder-probe-auth");
    if (!command)
      throw new Error("probe extension did not register its command");
    const context = {
      mode: "rpc",
      model: { provider: "test-provider", id: "test-model" },
      modelRegistry: {
        getProviderAuthStatus() {
          return {
            configured: true,
            source: authSource,
            label: "must-not-leak",
            credential: "must-not-leak",
          };
        },
      },
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    };
    command.handler(nonce, context);
    const stored = JSON.parse(notifications.at(-1)?.message ?? "null");
    if (
      notifications.at(-1)?.type !== "info" ||
      stored.source !== "stored" ||
      stored.provider !== "test-provider" ||
      JSON.stringify(stored).includes("must-not-leak")
    ) {
      throw new Error("probe extension emitted an unsafe stored-auth payload");
    }

    authSource = "models_json_command";
    command.handler(nonce, context);
    const commandAuth = JSON.parse(notifications.at(-1)?.message ?? "null");
    if (commandAuth.source !== "models_json_command") {
      throw new Error("probe extension lost command-auth source metadata");
    }
  } finally {
    if (previousNonce === undefined) {
      delete process.env.OPEN_BUILDER_PI_PROBE_NONCE;
    } else {
      process.env.OPEN_BUILDER_PI_PROBE_NONCE = previousNonce;
    }
  }
}

async function checkPiAdapterConformance() {
  const token = "desktop-security-conformance-token";
  const tools = [
    {
      name: "open_builder_echo",
      description: "Echo a value through the isolated host broker.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      hostApproval: "session",
    },
  ];
  const canonicalTools = [...tools].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalTools))
    .digest("hex");
  let authenticatedCatalogRequests = 0;
  let authenticatedCallRequests = 0;
  let receivedCall;

  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "invalid_bearer", message: "denied" },
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/pi/tools") {
      authenticatedCatalogRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: 1, runId: "conformance", tools }));
      return;
    }
    if (request.method === "POST" && request.url === "/pi/call") {
      authenticatedCallRequests += 1;
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        receivedCall = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const value = receivedCall.arguments.value;
        const content =
          value === "resource-text"
            ? [
                {
                  type: "resource",
                  uri: "attachment://text",
                  mimeType: "text/plain",
                  text: "resource body",
                },
              ]
            : value === "pdf"
              ? [
                  {
                    type: "resource",
                    uri: "attachment://pdf",
                    mimeType: "application/pdf",
                    blob: "JVBERi0xLjQ=",
                  },
                ]
              : [{ type: "text", text: value }];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            version: 1,
            result: {
              text: value === "fail" ? "bounded host failure" : "echoed",
              isError: value === "fail",
              structuredContent: { echoed: value },
              content,
            },
          }),
        );
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: { code: "not_found", message: "missing" } }),
    );
  });

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "open-builder-pi-conformance-"),
  );
  const previousConfig = process.env.OPEN_BUILDER_PI_CONFIG;
  try {
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("mock broker did not expose a TCP address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const cwd = await realpath(temporaryDirectory);
    const extensionPath = await realpath(
      fileURLToPath(
        new URL(
          "../src-tauri/src/local_agent_pi_extension.mjs",
          import.meta.url,
        ),
      ),
    );
    const configPath = path.join(temporaryDirectory, "pi-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        toolsUrl: `${origin}/pi/tools`,
        callUrl: `${origin}/pi/call`,
        bearerToken: token,
        attestationNonce: "attestation-nonce",
        expectedCwd: cwd,
        expectedModel: { provider: "test-provider", id: "test-model" },
        systemPrompt: "exact isolated system prompt",
        systemPromptNonce: "system-prompt-nonce",
        expectedToolNames: ["open_builder_echo"],
        toolDigest: digest,
        extensionPath,
      }),
      { mode: 0o600 },
    );
    await chmod(configPath, 0o600);
    process.env.OPEN_BUILDER_PI_CONFIG = configPath;

    const handlers = new Map();
    const registeredTools = new Map();
    const registeredCommands = new Map();
    const notifications = [];
    let activeTools = [];
    let runtimeReady = false;
    const extensionSourceInfo = {
      path: extensionPath,
      source: "cli",
      scope: "temporary",
      origin: "top-level",
    };
    const pi = {
      on(event, handler) {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
      registerTool(tool) {
        registeredTools.set(tool.name, {
          ...tool,
          sourceInfo: extensionSourceInfo,
        });
      },
      registerCommand(name, command) {
        registeredCommands.set(name, {
          name,
          ...command,
          sourceInfo: extensionSourceInfo,
        });
      },
      getActiveTools() {
        return [...activeTools];
      },
      setActiveTools(names) {
        if (!runtimeReady) {
          throw new Error("setActiveTools ran during extension loading");
        }
        activeTools = [...names];
      },
      getAllTools() {
        return [
          {
            name: "read",
            description: "inactive builtin",
            parameters: { type: "object" },
            sourceInfo: {
              path: "<builtin:read>",
              source: "builtin",
              scope: "temporary",
              origin: "top-level",
            },
          },
          ...registeredTools.values(),
        ];
      },
      getCommands() {
        return [
          ...registeredCommands.values(),
          {
            name: "llama",
            sourceInfo: {
              path: "<inline:llama.cpp>",
              source: "inline",
              scope: "temporary",
              origin: "top-level",
            },
          },
        ];
      },
    };

    const imported = await import(
      `${pathToFileURL(extensionPath).href}?security-conformance=${Date.now()}`
    );
    await imported.default(pi);
    if (process.env.OPEN_BUILDER_PI_CONFIG !== undefined) {
      throw new Error(
        "extension retained the sensitive config-path environment variable",
      );
    }
    runtimeReady = true;
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, {});
    }
    if (JSON.stringify(activeTools) !== JSON.stringify(["open_builder_echo"])) {
      throw new Error(
        "extension did not replace active tools with broker tools",
      );
    }

    const inputHandler = (handlers.get("input") ?? [])[0];
    if (!inputHandler)
      throw new Error("extension did not register an input gate");
    const blocked = await inputHandler({
      type: "input",
      source: "rpc",
      text: "early",
    });
    if (blocked?.action !== "handled") {
      throw new Error("extension accepted input before attestation");
    }

    const command = registeredCommands.get("open-builder-attest");
    if (!command)
      throw new Error("extension did not register its attestation command");
    const attestationContext = (source) => ({
      mode: "rpc",
      cwd,
      model: { provider: "test-provider", id: "test-model" },
      modelRegistry: {
        getProviderAuthStatus(provider) {
          if (provider !== "test-provider") {
            throw new Error("extension queried the wrong provider auth status");
          }
          return {
            configured: true,
            source,
            label: "sensitive-auth-label",
            credential: "must-never-be-attested",
          };
        },
      },
      thinkingLevel: "medium",
      getSystemPromptOptions() {
        return { cwd, contextFiles: [], skills: [] };
      },
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    });
    const storedAuthContext = attestationContext("stored");
    await command.handler(
      "attestation-nonce system-prompt-nonce",
      storedAuthContext,
    );
    const notification = notifications.at(-1);
    if (!notification || notification.type !== "info") {
      throw new Error("extension did not emit an attestation notification");
    }
    const attestation = JSON.parse(notification.message);
    if (
      attestation.type !== "open_builder_pi_attestation" ||
      attestation.computedToolDigest !== digest ||
      attestation.extensionPath !== extensionPath ||
      attestation.providerAuth?.configured !== true ||
      attestation.providerAuth?.source !== "stored" ||
      Object.keys(attestation.providerAuth).sort().join(",") !==
        "configured,source" ||
      notification.message.includes("sensitive-auth-label") ||
      notification.message.includes("must-never-be-attested") ||
      attestation.violations.length !== 0 ||
      JSON.stringify(attestation.activeTools) !==
        JSON.stringify(["open_builder_echo"]) ||
      attestation.allTools.some(
        (tool) => tool.name === "read" && activeTools.includes(tool.name),
      )
    ) {
      throw new Error("extension emitted an invalid runtime attestation");
    }

    const accepted = await inputHandler(
      {
        type: "input",
        source: "rpc",
        text: "real prompt",
      },
      storedAuthContext,
    );
    if (accepted?.action !== "continue") {
      throw new Error("extension rejected the first attested prompt");
    }
    const beforeAgentStart = (handlers.get("before_agent_start") ?? [])[0];
    const injection = await beforeAgentStart(
      { type: "before_agent_start" },
      {},
    );
    if (injection?.systemPrompt !== "exact isolated system prompt") {
      throw new Error(
        "extension did not inject the exact one-shot system prompt",
      );
    }
    const replay = await inputHandler(
      {
        type: "input",
        source: "rpc",
        text: "replay",
      },
      storedAuthContext,
    );
    if (replay?.action !== "handled") {
      throw new Error("extension reused an attestation for a second prompt");
    }

    const tool = registeredTools.get("open_builder_echo");
    const result = await tool.execute("call", { value: "through-broker" });
    if (
      result.content?.[0]?.text !== "through-broker" ||
      result.details?.structuredContent?.echoed !== "through-broker" ||
      authenticatedCatalogRequests !== 1 ||
      authenticatedCallRequests !== 1 ||
      receivedCall?.name !== "open_builder_echo"
    ) {
      throw new Error(
        "extension tool adapter did not round-trip through the broker",
      );
    }
    await tool.execute("call", { value: "fail" }).then(
      () => {
        throw new Error(
          "extension treated a failed broker tool result as success",
        );
      },
      (error) => {
        if (
          !(error instanceof Error) ||
          error.message !== "bounded host failure"
        ) {
          throw new Error("extension did not throw the bounded broker failure");
        }
      },
    );
    if (authenticatedCallRequests !== 2) {
      throw new Error("extension failure conformance did not reach the broker");
    }

    const resourceResult = await tool.execute("call", {
      value: "resource-text",
    });
    if (resourceResult.content?.[0]?.text !== "resource body") {
      throw new Error("extension dropped a text-backed host resource");
    }
    await tool.execute("call", { value: "pdf" }).then(
      () => {
        throw new Error(
          "extension silently accepted an unsupported PDF result",
        );
      },
      (error) => {
        if (
          !(error instanceof Error) ||
          !error.message.includes("application/pdf")
        ) {
          throw new Error("extension did not explain unsupported PDF content");
        }
      },
    );
    if (authenticatedCallRequests !== 4) {
      throw new Error(
        "extension resource conformance did not reach the broker",
      );
    }

    const commandAuthContext = attestationContext("models_json_command");
    await command.handler(
      "attestation-nonce system-prompt-nonce",
      commandAuthContext,
    );
    const unsafeNotification = notifications.at(-1);
    const unsafeAttestation = JSON.parse(unsafeNotification.message);
    if (
      unsafeAttestation.providerAuth?.configured !== true ||
      unsafeAttestation.providerAuth?.source !== "models_json_command" ||
      !unsafeAttestation.violations.includes("providerAuth") ||
      unsafeNotification.message.includes("sensitive-auth-label") ||
      unsafeNotification.message.includes("must-never-be-attested")
    ) {
      throw new Error("extension did not reject unsafe Pi credential sourcing");
    }
    const unsafeInput = await inputHandler(
      { type: "input", source: "rpc", text: "must stay hidden" },
      commandAuthContext,
    );
    if (unsafeInput?.action !== "handled") {
      throw new Error("extension accepted input with models.json command auth");
    }
  } finally {
    if (previousConfig === undefined) {
      delete process.env.OPEN_BUILDER_PI_CONFIG;
    } else {
      process.env.OPEN_BUILDER_PI_CONFIG = previousConfig;
    }
    if (server.listening) await close(server);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (!tauriConfig.app?.security?.csp) {
  failures.push("Tauri CSP must not be null or empty.");
}

const permissions = JSON.stringify(capabilities.permissions ?? []);
if (permissions.includes("shell:allow-execute")) {
  failures.push("Desktop capabilities must not grant shell:allow-execute.");
}
if (permissions.includes('"$HOME/**"')) {
  failures.push("Desktop capabilities must not grant recursive $HOME access.");
}

const csp = tauriConfig.app?.security?.csp ?? "";
if (!csp.includes("proxy-http:") || !csp.includes("proxy-https:")) {
  failures.push(
    "Tauri CSP must use explicit proxy-http and proxy-https schemes.",
  );
}

const mobileHandler = tauriLib.match(
  /#\[cfg\(mobile\)\][\s\S]*?generate_handler!\[([\s\S]*?)\]\);/,
)?.[1];
if (!mobileHandler) {
  failures.push("A dedicated mobile invoke handler must be present.");
} else if (
  /skills::|mcp_stdio::|mcp_remote::|mcp_oauth::|local_agent::/.test(
    mobileHandler,
  )
) {
  failures.push(
    "Mobile invoke handler must not expose Skill scripts or desktop MCP commands.",
  );
}

if (
  !tauriLib.includes("local_agent::LocalAgentState::default()") ||
  !tauriLib.includes("local_agent::local_agent_start")
) {
  failures.push("Desktop local-agent state and commands must be registered.");
}

if (
  !localAgentProtocol.includes("command.env_clear()") ||
  !localAgentProtocol.includes("MAX_PROTOCOL_OUTPUT_BYTES") ||
  !localAgentProtocol.includes("MAX_PROTOCOL_EVENTS") ||
  !localAgentProtocol.includes("127.0.0.1,localhost,::1") ||
  !localAgentProtocol.includes("ProcessGroup::leader()") ||
  !localAgentProtocol.includes("JobObject")
) {
  failures.push(
    "Local-agent processes must use a minimal environment, disabled native execution, and process-tree containment.",
  );
}

if (
  !localAgentClaudeRuntime.includes("CLAUDE_PROVIDER_ENV_KEYS") ||
  !localAgentClaudeRuntime.includes("provider_environment_from_sources") ||
  !localAgentClaudeRuntime.includes(
    "provider_environment.apply(&mut command)",
  ) ||
  !localAgentClaudeRuntime.includes("MAX_CLAUDE_PROVIDER_ENV_BYTES") ||
  !localAgentClaudeRuntime.includes(
    "Claude gateway URL must use HTTPS or loopback HTTP",
  ) ||
  !localAgentClaudeRuntime.includes(
    "Claude gateway configuration requires an explicit credential",
  ) ||
  localAgentClaudeRuntime.includes('"--settings".to_string()') ||
  /"--setting-sources"[\s\S]{0,120}"(?:user|project|local)"/.test(
    localAgentClaudeRuntime,
  ) ||
  localAgentProtocol.includes("ANTHROPIC_")
) {
  failures.push(
    "The Claude adapter must import only an explicit, bounded provider allowlist without loading full user settings or widening the shared environment.",
  );
}

if (
  !localAgentCodex.includes('"exec".to_string()') ||
  !localAgentCodex.includes('"--json".to_string()') ||
  !localAgentCodex.includes('"--ignore-user-config".to_string()') ||
  !localAgentCodex.includes('"--ignore-rules".to_string()') ||
  !localAgentCodex.includes('"read-only".to_string()') ||
  !localAgentCodex.includes('"shell_tool"') ||
  !localAgentCodex.includes('"unified_exec"') ||
  !localAgentCodex.includes("shell_environment_policy.exclude") ||
  !localAgentCodex.includes("validate_item_kind") ||
  !localAgentCodex.includes("HANDSHAKE_TIMEOUT") ||
  !localAgentCodex.includes("provider_config_from_sources") ||
  !localAgentCodex.includes("provider_config.apply(&mut command)") ||
  !localAgentCodex.includes(
    "Codex static provider credentials are not allowed",
  ) ||
  !localAgentCodex.includes(
    "Codex command-backed provider authentication is not allowed",
  ) ||
  !localAgentCodex.includes(
    "Codex provider URL must use HTTPS or loopback HTTP",
  ) ||
  localAgentProtocol.includes("OPENAI_API_KEY")
) {
  failures.push(
    "The Codex adapter must use isolated JSON exec, import only sanitized provider configuration, disable native execution, and reject unauthorized runtime items.",
  );
}

if (
  !localAgentClaude.includes("run_isolation_preflight") ||
  localAgentClaude.includes('"--safe-mode".to_string()') ||
  !localAgentClaude.includes('"--restricted".to_string()') ||
  !localAgentClaude.includes('"--strict-mcp-config".to_string()') ||
  !localAgentClaude.includes('"--setting-sources".to_string()') ||
  !localAgentClaude.includes('"--system-prompt-file".to_string()') ||
  !localAgentClaude.includes('"stream-json".to_string()') ||
  !localAgentClaude.includes('"alwaysLoad": true') ||
  !localAgentClaude.includes('"--allowedTools".to_string()') ||
  !localAgentClaude.includes("validate_init_inventory") ||
  !/pub\(crate\) async fn probe[\s\S]*?run_isolation_preflight\(executable\)[\s\S]*?\["auth", "status", "--json"\]/.test(
    localAgentClaude,
  ) ||
  !/async fn run_claude_protocol[\s\S]*?send_user[\s\S]*?wait_for_init/.test(
    localAgentClaude,
  )
) {
  failures.push(
    "The Claude adapter must use restricted mode, empty setting sources, strict eager MCP loading, exact allowed tools, and init attestation; safe mode would disable the explicit run-scoped MCP bridge.",
  );
}

if (
  !localAgentAntigravity.includes('"--input-format".to_string()') ||
  !localAgentAntigravity.includes('"--output-format".to_string()') ||
  !localAgentAntigravity.includes('"--agent".to_string()') ||
  !localAgentAntigravity.includes('"--sandbox".to_string()') ||
  !localAgentAntigravity.includes("prepare_run_files") ||
  !localAgentAntigravity.includes("attest_init") ||
  !localAgentAntigravity.includes('"read_file(*)"') ||
  !localAgentAntigravity.includes('"write_file(*)"') ||
  !localAgentAntigravity.includes('"command(*)"') ||
  !localAgentAntigravity.includes('"serverUrl"') ||
  !localAgentAntigravity.includes("isolated_home") ||
  !localAgentAntigravity.includes("antigravity-scope-homes-v1") ||
  !localAgentAntigravity.includes("LocalAgentRunScopeKind::Conversation") ||
  !localAgentAntigravity.includes("LocalAgentRunScopeKind::Utility") ||
  !localAgentAntigravity.includes("reject_private_customizations") ||
  !localAgent.includes("is_conversation_scope_conflict") ||
  localAgentAntigravity.includes("RUNTIME_LOCK") ||
  !localAgentAntigravity.includes("provider_environment_from_sources") ||
  !localAgentAntigravity.includes("provider_environment.apply(&mut command)") ||
  !localAgentAntigravity.includes(
    "Antigravity Gemini endpoint must use HTTPS or loopback HTTP",
  ) ||
  !localAgentAntigravity.includes(
    "Antigravity Gemini API-key mode requires GEMINI_API_KEY",
  ) ||
  localAgentProtocol.includes("GEMINI_API_KEY") ||
  localAgentProtocol.includes("GOOGLE_GEMINI_BASE_URL") ||
  !/async fn run_protocol[\s\S]*?attest_init[\s\S]*?write_json/.test(
    localAgentAntigravity,
  )
) {
  failures.push(
    "The Antigravity adapter must remain structured-only and attest its private sandbox before writing user input.",
  );
}

if (
  !localAgent.includes("shutdown_gracefully") ||
  !localAgent.includes("local_agent_cancel_all") ||
  !localAgent.includes(
    "native search is not allowed in isolated execution modes",
  ) ||
  !localAgentProtocol.includes("SHUTDOWN_TIMEOUT")
) {
  failures.push(
    "Local-agent cancellation must reject pending tools and clean up process trees with a bounded grace period.",
  );
}

const startRequest = localAgent.match(
  /pub struct LocalAgentStartRequest \{([\s\S]*?)\n\}/,
)?.[1];
if (
  !startRequest ||
  /\b(command|args|cwd|executable|environment)\s*:/.test(startRequest)
) {
  failures.push(
    "The local-agent start request must not accept executable, argv, cwd, or environment input from the webview.",
  );
}

if (
  !localAgent.includes("valid_executable_name") ||
  !localAgentAdapter.includes('format!("{}.exe", self.command_name)') ||
  !localAgentAdapter.includes("accepts_executable_file_name")
) {
  failures.push(
    "Windows local-agent launchers must be restricted to provider-native .exe files.",
  );
}

const designExportSignature = design.match(
  /pub async fn design_export_project\(([\s\S]*?)\)\s*->/,
)?.[1];
if (
  !designExportSignature ||
  designExportSignature.includes("parent_path") ||
  !design.includes(".pick_folder(")
) {
  failures.push(
    "design_export_project must choose the export parent in a native Rust folder dialog instead of accepting a renderer-supplied path.",
  );
}

if (!/developerSkillScriptsEnabled:\s*false/.test(settingsSystem)) {
  failures.push("Desktop Skill scripts must default to disabled.");
}

const streamIndex = skillImporter.indexOf('internalStream("uint8array")');
const zipPreflightIndex = skillImporter.indexOf(
  "assertSkillZipCentralDirectory(buffer, subpath)",
);
const jsZipLoadIndex = skillImporter.indexOf("JSZip.loadAsync(buffer)");
const trackerIndex = skillImporter.indexOf("budget.createFileTracker(path)");
const trackChunkIndex = skillImporter.indexOf(
  "tracker.trackChunk(chunk.byteLength)",
);
const bufferChunkIndex = skillImporter.indexOf("chunks.push(chunk)");
const pauseIndex = skillImporter.indexOf("stream.pause()");
const resumeIndex = skillImporter.indexOf(".resume()", streamIndex);
if (
  zipPreflightIndex < 0 ||
  jsZipLoadIndex < zipPreflightIndex ||
  streamIndex < 0 ||
  trackerIndex < streamIndex ||
  trackChunkIndex < trackerIndex ||
  bufferChunkIndex < trackChunkIndex ||
  pauseIndex < streamIndex ||
  skillImporter.includes('entry.file.async("uint8array")') ||
  resumeIndex < bufferChunkIndex
) {
  failures.push(
    "Skill ZIP metadata must be preflighted before JSZip, and chunks budgeted before buffering.",
  );
}

if (!mcpStdio.includes("apply_minimal_environment(&mut command)")) {
  failures.push(
    "Stdio MCP servers must start from the minimal local-agent environment, not the desktop app environment.",
  );
}
if (!localAgentBridge.includes("Ipv4Addr::LOCALHOST, 0")) {
  failures.push("The local tool bridge must bind an ephemeral loopback port.");
}
if (
  !localAgentBridge.includes("fn require_loopback_host(") ||
  !localAgentBridge.includes("require_loopback_host(request.headers()")
) {
  failures.push(
    "The local tool bridge must reject requests whose Host is not its loopback authority.",
  );
}

try {
  await checkPiProbeExtensionConformance();
  await checkPiAdapterConformance();
} catch (error) {
  failures.push(
    `Pi local-agent adapter conformance failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`security: ${failure}`);
  process.exit(1);
}

console.log("Desktop security checks passed.");
