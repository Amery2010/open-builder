import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_ENV = "OPEN_BUILDER_PI_CONFIG";
const CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const ATTEST_COMMAND = "open-builder-attest";
const AUTH_SOURCES = new Set([
  "stored",
  "runtime",
  "environment",
  "fallback",
  "models_json_key",
  "models_json_command",
]);
const CONFIG_FIELDS = [
  "version",
  "toolsUrl",
  "callUrl",
  "bearerToken",
  "attestationNonce",
  "expectedCwd",
  "expectedModel",
  "systemPrompt",
  "systemPromptNonce",
  "expectedToolNames",
  "toolDigest",
  "extensionPath",
].sort();

function fail(message) {
  throw new Error(`Open Builder Pi isolation: ${message}`);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(`invalid ${field}`);
  }
  return value;
}

function equalStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sortedUniqueStrings(value, field) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item)
  ) {
    fail(`invalid ${field}`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    fail(`duplicate ${field}`);
  }
  return sorted;
}

function assertLoopbackEndpoint(raw, expectedPath) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`invalid ${expectedPath} URL`);
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== expectedPath ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(`unsafe ${expectedPath} URL`);
  }
  return url;
}

async function canonicalPath(value, field) {
  requireString(value, field);
  if (!path.isAbsolute(value)) fail(`${field} must be absolute`);
  try {
    return await realpath(value);
  } catch {
    fail(`cannot resolve ${field}`);
  }
}

async function loadConfig() {
  const configPath = process.env[CONFIG_ENV];
  delete process.env[CONFIG_ENV];
  if (!configPath || !path.isAbsolute(configPath)) {
    fail(`${CONFIG_ENV} must name an absolute file`);
  }

  await canonicalPath(configPath, CONFIG_ENV);
  const pathStat = await lstat(configPath);
  if (pathStat.isSymbolicLink()) {
    fail("config path must not be a symlink");
  }

  const handle = await open(configPath, "r");
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
      fail("config must be a bounded regular file");
    }
    if (process.platform !== "win32") {
      if (
        typeof process.getuid !== "function" ||
        stat.uid !== process.getuid()
      ) {
        fail("config must be owned by the current user");
      }
      if ((stat.mode & 0o077) !== 0) {
        fail("config permissions must be owner-only");
      }
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }

  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("config is not valid JSON");
  }
  if (!isPlainObject(config)) fail("config must be an object");
  if (!equalStrings(Object.keys(config).sort(), CONFIG_FIELDS)) {
    fail("config fields do not match the supported schema");
  }
  if (config.version !== CONFIG_VERSION) fail("unsupported config version");

  const toolsUrl = assertLoopbackEndpoint(
    requireString(config.toolsUrl, "toolsUrl"),
    "/pi/tools",
  );
  const callUrl = assertLoopbackEndpoint(
    requireString(config.callUrl, "callUrl"),
    "/pi/call",
  );
  if (toolsUrl.origin !== callUrl.origin)
    fail("broker endpoints must share an origin");

  requireString(config.bearerToken, "bearerToken");
  requireString(config.attestationNonce, "attestationNonce");
  requireString(config.systemPromptNonce, "systemPromptNonce");
  requireString(config.systemPrompt, "systemPrompt", { allowEmpty: true });
  if (!/^[0-9a-f]{64}$/.test(config.toolDigest)) fail("invalid toolDigest");

  if (
    config.expectedModel !== null &&
    (!isPlainObject(config.expectedModel) ||
      typeof config.expectedModel.provider !== "string" ||
      !config.expectedModel.provider ||
      typeof config.expectedModel.id !== "string" ||
      !config.expectedModel.id ||
      Object.keys(config.expectedModel).sort().join(",") !== "id,provider")
  ) {
    fail("invalid expectedModel");
  }

  config.expectedToolNames = sortedUniqueStrings(
    config.expectedToolNames,
    "expectedToolNames",
  );
  config.expectedCwd = await canonicalPath(config.expectedCwd, "expectedCwd");
  config.extensionPath = await canonicalPath(
    config.extensionPath,
    "extensionPath",
  );
  const actualExtensionPath = await realpath(fileURLToPath(import.meta.url));
  if (config.extensionPath !== actualExtensionPath) {
    fail("extension path does not match the loaded module");
  }
  return config;
}

function canonicalTools(tools) {
  return tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.annotations.readOnlyHint ?? null,
        destructiveHint: tool.annotations.destructiveHint ?? null,
        idempotentHint: tool.annotations.idempotentHint ?? null,
        openWorldHint: tool.annotations.openWorldHint ?? null,
      },
      hostApproval: tool.hostApproval,
    }))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
}

function toolDigest(tools) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalTools(tools)))
    .digest("hex");
}

async function fetchJson(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    cache: "no-store",
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    fail(`broker returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const message = body?.error?.message;
    fail(
      typeof message === "string" ? message : `broker HTTP ${response.status}`,
    );
  }
  return body;
}

function validateCatalog(body, config) {
  if (
    !isPlainObject(body) ||
    body.version !== CONFIG_VERSION ||
    typeof body.runId !== "string" ||
    !body.runId ||
    !Array.isArray(body.tools)
  ) {
    fail("invalid broker tool catalog");
  }
  const names = new Set();
  for (const tool of body.tools) {
    if (
      !isPlainObject(tool) ||
      typeof tool.name !== "string" ||
      !tool.name ||
      typeof tool.description !== "string" ||
      !isPlainObject(tool.inputSchema) ||
      !isPlainObject(tool.annotations) ||
      !["none", "session", "perCall"].includes(tool.hostApproval) ||
      [
        tool.annotations.readOnlyHint,
        tool.annotations.destructiveHint,
        tool.annotations.idempotentHint,
        tool.annotations.openWorldHint,
      ].some((value) => value !== null && typeof value !== "boolean") ||
      names.has(tool.name)
    ) {
      fail("invalid broker tool definition");
    }
    names.add(tool.name);
  }
  const actualNames = [...names].sort();
  if (!equalStrings(actualNames, config.expectedToolNames)) {
    fail("broker tool names do not match the run configuration");
  }
  const computedToolDigest = toolDigest(body.tools);
  if (computedToolDigest !== config.toolDigest) {
    fail("broker tool digest does not match the run configuration");
  }
  return { tools: body.tools, computedToolDigest };
}

function sourceInfo(value) {
  const info = value?.sourceInfo;
  return {
    path: typeof info?.path === "string" ? info.path : "",
    source: typeof info?.source === "string" ? info.source : "",
    scope: typeof info?.scope === "string" ? info.scope : "",
    origin: typeof info?.origin === "string" ? info.origin : "",
  };
}

function mappedContent(result) {
  const mapped = [];
  const unsupported = [];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (item?.type === "text" && typeof item.text === "string") {
      mapped.push({ type: "text", text: item.text });
    } else if (
      item?.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      mapped.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else if (item?.type === "resource" && typeof item.text === "string") {
      mapped.push({ type: "text", text: item.text });
    } else if (
      item?.type === "resource" &&
      typeof item.blob === "string" &&
      typeof item.mimeType === "string" &&
      item.mimeType.startsWith("image/")
    ) {
      mapped.push({
        type: "image",
        data: item.blob,
        mimeType: item.mimeType,
      });
    } else if (
      item?.type === "resource_link" &&
      typeof item.uri === "string" &&
      typeof item.name === "string"
    ) {
      const details = [
        `Resource link: ${item.name}`,
        `URI: ${item.uri}`,
        typeof item.description === "string" && item.description
          ? `Description: ${item.description}`
          : "",
      ].filter(Boolean);
      mapped.push({ type: "text", text: details.join("\n") });
    } else if (item?.type === "audio") {
      unsupported.push("audio");
    } else if (item?.type === "resource") {
      unsupported.push(
        typeof item.mimeType === "string" ? item.mimeType : "binary resource",
      );
    } else {
      unsupported.push("unknown content");
    }
  }
  if (unsupported.length > 0) {
    throw new Error(
      `Pi cannot consume this host tool content: ${[...new Set(unsupported)].join(", ")}.`,
    );
  }
  if (mapped.length === 0) {
    mapped.push({
      type: "text",
      text: typeof result.text === "string" ? result.text : "",
    });
  }
  return mapped;
}

function toolErrorMessage(result) {
  const text =
    typeof result.text === "string" && result.text
      ? result.text
      : (Array.isArray(result.content)
          ? result.content.find(
              (item) => item?.type === "text" && typeof item.text === "string",
            )?.text
          : undefined) || "Open Builder host tool failed.";
  return text.slice(0, 8 * 1024);
}

function asPathList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) =>
    typeof item === "string"
      ? item
      : typeof item?.path === "string"
        ? item.path
        : typeof item?.sourceInfo?.path === "string"
          ? item.sourceInfo.path
          : "",
  );
}

function dedupeSources(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const info = sourceInfo(value);
    const key = JSON.stringify(info);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(info);
    }
  }
  return result;
}

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

function hasStoredProviderAuth(ctx) {
  const status = providerAuthStatus(ctx);
  return status.configured && status.source === "stored";
}

export default async function openBuilderPiExtension(pi) {
  const config = await loadConfig();
  const catalog = validateCatalog(
    await fetchJson(config.toolsUrl, config.bearerToken),
    config,
  );
  let attestationArmed = false;
  let injectSystemPromptForTurn = false;

  for (const tool of catalog.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params, signal) {
        const body = await fetchJson(config.callUrl, config.bearerToken, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: tool.name, arguments: params }),
        });
        if (
          !isPlainObject(body) ||
          body.version !== CONFIG_VERSION ||
          !isPlainObject(body.result)
        ) {
          fail("invalid broker tool result");
        }
        if (body.result.isError === true) {
          throw new Error(toolErrorMessage(body.result));
        }
        return {
          content: mappedContent(body.result),
          details: { structuredContent: body.result.structuredContent ?? null },
        };
      },
    });
  }

  pi.on("session_start", () => {
    attestationArmed = false;
    injectSystemPromptForTurn = false;
    pi.setActiveTools(config.expectedToolNames);
  });

  pi.registerCommand(ATTEST_COMMAND, {
    description: "Open Builder isolated run attestation",
    handler: async (args, ctx) => {
      if (
        args !== `${config.attestationNonce} ${config.systemPromptNonce}` ||
        ctx.mode !== "rpc"
      ) {
        ctx.ui.notify("Open Builder attestation rejected.", "error");
        return;
      }

      pi.setActiveTools(config.expectedToolNames);
      const options = ctx.getSystemPromptOptions();
      const activeTools = [...pi.getActiveTools()].sort();
      const allTools = pi.getAllTools().map((tool) => ({
        name: tool.name,
        sourceInfo: sourceInfo(tool),
      }));
      const commands = pi.getCommands().map((command) => ({
        name: command.name,
        sourceInfo: sourceInfo(command),
      }));
      const contextFiles = asPathList(options.contextFiles);
      const skills = asPathList(options.skills);
      const promptTemplates = commands
        .filter((command) => command.sourceInfo.source === "prompt")
        .map((command) => command.name)
        .sort();
      const extensions = dedupeSources([
        ...allTools.filter(
          (tool) =>
            tool.sourceInfo.source !== "builtin" &&
            tool.sourceInfo.source !== "inline",
        ),
        ...commands.filter(
          (command) =>
            command.sourceInfo.source !== "builtin" &&
            command.sourceInfo.source !== "inline",
        ),
      ]);
      let cwd = ctx.cwd;
      try {
        cwd = await realpath(ctx.cwd);
      } catch {
        // The mismatch is recorded below and rejected by the adapter.
      }

      const violations = [];
      const providerAuth = providerAuthStatus(ctx);
      if (cwd !== config.expectedCwd) violations.push("cwd");
      if (!equalStrings(activeTools, config.expectedToolNames)) {
        violations.push("activeTools");
      }
      if (contextFiles.length !== 0) violations.push("contextFiles");
      if (skills.length !== 0) violations.push("skills");
      if (promptTemplates.length !== 0) violations.push("promptTemplates");
      if (options.customPrompt || options.appendSystemPrompt) {
        violations.push("promptCustomization");
      }
      if (
        config.expectedModel &&
        (ctx.model?.provider !== config.expectedModel.provider ||
          ctx.model?.id !== config.expectedModel.id)
      ) {
        violations.push("model");
      }
      if (!providerAuth.configured || providerAuth.source !== "stored") {
        violations.push("providerAuth");
      }

      const externalTools = allTools.filter(
        (tool) => tool.sourceInfo.source !== "builtin",
      );
      if (
        externalTools.length !== config.expectedToolNames.length ||
        externalTools.some(
          (tool) =>
            !config.expectedToolNames.includes(tool.name) ||
            tool.sourceInfo.source !== "cli" ||
            tool.sourceInfo.path !== config.extensionPath,
        )
      ) {
        violations.push("allTools");
      }

      const unexpectedCommands = commands.filter((command) => {
        if (
          command.name === ATTEST_COMMAND &&
          command.sourceInfo.source === "cli" &&
          command.sourceInfo.path === config.extensionPath
        ) {
          return false;
        }
        return !(
          command.name === "llama" &&
          command.sourceInfo.source === "inline" &&
          command.sourceInfo.path === "<inline:llama.cpp>"
        );
      });
      if (unexpectedCommands.length !== 0) violations.push("commands");
      if (
        extensions.length !== 1 ||
        extensions[0].source !== "cli" ||
        extensions[0].path !== config.extensionPath
      ) {
        violations.push("extensions");
      }

      const attestation = {
        type: "open_builder_pi_attestation",
        version: CONFIG_VERSION,
        attestationNonce: config.attestationNonce,
        systemPromptNonce: config.systemPromptNonce,
        extensionPath: config.extensionPath,
        cwd,
        model: ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : null,
        providerAuth,
        thinkingLevel:
          typeof ctx.thinkingLevel === "string" ? ctx.thinkingLevel : null,
        activeTools,
        allTools,
        extensions,
        contextFiles,
        skills,
        promptTemplates,
        commands,
        computedToolDigest: catalog.computedToolDigest,
        violations,
      };
      attestationArmed = violations.length === 0;
      ctx.ui.notify(JSON.stringify(attestation), "info");
    },
  });

  pi.on("input", (event, ctx) => {
    if (
      event.source !== "rpc" ||
      !attestationArmed ||
      !hasStoredProviderAuth(ctx)
    ) {
      attestationArmed = false;
      return { action: "handled" };
    }
    pi.setActiveTools(config.expectedToolNames);
    if (
      !equalStrings([...pi.getActiveTools()].sort(), config.expectedToolNames)
    ) {
      attestationArmed = false;
      return { action: "handled" };
    }
    attestationArmed = false;
    injectSystemPromptForTurn = true;
    return { action: "continue" };
  });

  pi.on("before_agent_start", () => {
    if (!injectSystemPromptForTurn) return;
    injectSystemPromptForTurn = false;
    return { systemPrompt: config.systemPrompt };
  });
}
