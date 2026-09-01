import { asSchema, type ToolSet } from "ai";
import {
  getToolCapability,
  isToolAllowedInMode,
  type ExecutionMode,
  type RuntimePlatform,
} from "../ai/tools-schema";
import type {
  LocalToolAnnotations,
  LocalToolHostApproval,
  LocalToolSpec,
} from "./types";

const OMITTED_LOCAL_TOOL_NAMES = new Set(["screenshot_to_code"]);

function readonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  return Object.freeze({
    get: source.get.bind(source),
    has: source.has.bind(source),
    entries: source.entries.bind(source),
    keys: source.keys.bind(source),
    values: source.values.bind(source),
    forEach: source.forEach.bind(source),
    get size() {
      return source.size;
    },
    [Symbol.iterator]: source[Symbol.iterator].bind(source),
  }) as ReadonlyMap<K, V>;
}

function readonlySet<T>(source: Set<T>): ReadonlySet<T> {
  return Object.freeze({
    has: source.has.bind(source),
    entries: source.entries.bind(source),
    keys: source.keys.bind(source),
    values: source.values.bind(source),
    forEach: source.forEach.bind(source),
    get size() {
      return source.size;
    },
    [Symbol.iterator]: source[Symbol.iterator].bind(source),
  }) as ReadonlySet<T>;
}

export interface LocalToolAuthorityEntry {
  readonly name: string;
  readonly spec: LocalToolSpec;
  readonly definition?: ToolSet[string];
  readonly annotations: LocalToolAnnotations;
  readonly hostApproval: LocalToolHostApproval;
  readonly readOnly: boolean;
}

export interface LocalToolAuthoritySnapshot {
  readonly entries: ReadonlyMap<string, LocalToolAuthorityEntry>;
  readonly specs: readonly LocalToolSpec[];
  readonly names: ReadonlySet<string>;
  readonly digest: string;

  has(name: string): boolean;
  get(name: string): LocalToolAuthorityEntry | undefined;
  isReadOnly(name: string): boolean;
  validate(
    name: string,
    value: unknown,
  ): Promise<
    { success: true; value: unknown } | { success: false; error: Error }
  >;
}

export interface LocalToolAuthorityOptions {
  tools: ToolSet;
  mode: ExecutionMode;
  platform: RuntimePlatform;
  allowedMcpAliases?: ReadonlySet<string>;
  annotations?: ReadonlyMap<string, LocalToolAnnotations>;
  extraSpecs?: readonly LocalToolSpec[];
  omittedNames?: ReadonlySet<string>;
}

function isReadOnlyCapability(name: string): boolean {
  if (name === "read_attachment") return true;
  const capability = getToolCapability(name);
  return Boolean(
    capability &&
    capability.effects.every(
      (effect) =>
        effect === "read_project" ||
        effect === "read_runtime" ||
        effect === "network",
    ),
  );
}

function defaultAnnotations(
  name: string,
  dynamic: LocalToolAnnotations | undefined,
): LocalToolAnnotations {
  if (dynamic) {
    return Object.freeze({ ...dynamic });
  }
  const readOnly = isReadOnlyCapability(name);
  return Object.freeze({
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    idempotentHint: readOnly,
    openWorldHint: !readOnly,
  });
}

function defaultHostApproval(
  name: string,
  readOnly: boolean,
): LocalToolHostApproval {
  if (readOnly) return "none";
  const approval = getToolCapability(name)?.approval;
  if (approval === "per_call") return "perCall";
  return "session";
}

function isAllowedTool(
  name: string,
  mode: ExecutionMode,
  platform: RuntimePlatform,
  allowedMcpAliases: ReadonlySet<string>,
): boolean {
  const capability = getToolCapability(name);
  if (capability) return isToolAllowedInMode(name, mode, platform);
  return mode !== "auto_qa" && allowedMcpAliases.has(name);
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return "null";
}

async function digestText(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to fingerprint local CLI tools.");
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function serializeDefinition(
  name: string,
  definition: ToolSet[string],
  annotations: LocalToolAnnotations,
  hostApproval: LocalToolHostApproval,
): Promise<LocalToolSpec> {
  return Object.freeze({
    name,
    description:
      typeof definition.description === "string"
        ? definition.description
        : "Open Builder host tool",
    inputSchema: (await asSchema(definition.inputSchema).jsonSchema) as Record<
      string,
      unknown
    >,
    annotations,
    hostApproval,
  });
}

/**
 * Creates the one immutable tool snapshot used for local model visibility,
 * argument validation and Host execution. Provider adapters receive only its
 * serialized specs; they never reconstruct an independent allowlist.
 */
export async function createLocalToolAuthoritySnapshot(
  options: LocalToolAuthorityOptions,
): Promise<LocalToolAuthoritySnapshot> {
  const allowedMcpAliases = options.allowedMcpAliases ?? new Set<string>();
  const omittedNames = new Set([
    ...OMITTED_LOCAL_TOOL_NAMES,
    ...(options.omittedNames ?? []),
  ]);
  const entries = new Map<string, LocalToolAuthorityEntry>();

  for (const [name, definition] of Object.entries(options.tools).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (
      omittedNames.has(name) ||
      !isAllowedTool(name, options.mode, options.platform, allowedMcpAliases)
    ) {
      continue;
    }
    const annotations = defaultAnnotations(
      name,
      options.annotations?.get(name),
    );
    // MCP annotations are model-facing capability hints, not Host authority.
    // Only Open Builder's static capability registry may remove approval or
    // clear the conservative side-effect marker used by session recovery.
    const readOnly = isReadOnlyCapability(name);
    const hostApproval = defaultHostApproval(name, readOnly);
    const spec = await serializeDefinition(
      name,
      definition,
      annotations,
      hostApproval,
    );
    entries.set(
      name,
      Object.freeze({
        name,
        spec,
        definition,
        annotations,
        hostApproval,
        readOnly,
      }),
    );
  }

  for (const extra of options.extraSpecs ?? []) {
    if (omittedNames.has(extra.name) || entries.has(extra.name)) continue;
    const annotations = defaultAnnotations(extra.name, extra.annotations);
    const readOnly = isReadOnlyCapability(extra.name);
    const hostApproval =
      extra.hostApproval ?? defaultHostApproval(extra.name, readOnly);
    const spec = Object.freeze({
      ...extra,
      annotations,
      hostApproval,
    });
    entries.set(
      extra.name,
      Object.freeze({
        name: extra.name,
        spec,
        annotations,
        hostApproval,
        readOnly,
      }),
    );
  }

  const specs = Object.freeze(
    [...entries.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => entry.spec),
  );
  const names = new Set(specs.map((spec) => spec.name));
  const entriesView = readonlyMap(entries);
  const namesView = readonlySet(names);
  const digest = await digestText(
    canonicalValue({
      mode: options.mode,
      platform: options.platform,
      specs,
    }),
  );

  return Object.freeze({
    entries: entriesView,
    specs,
    names: namesView,
    digest,
    has(name: string): boolean {
      return names.has(name);
    },
    get(name: string): LocalToolAuthorityEntry | undefined {
      return entries.get(name);
    },
    isReadOnly(name: string): boolean {
      return entries.get(name)?.readOnly === true;
    },
    async validate(name: string, value: unknown) {
      const definition = entries.get(name)?.definition;
      if (!definition) {
        return {
          success: false as const,
          error: new Error(`Tool "${name}" is not authorized for this run.`),
        };
      }
      const schema = asSchema(definition.inputSchema);
      if (!schema.validate) {
        return {
          success: false as const,
          error: new Error(
            `Tool "${name}" has no enforceable input validator.`,
          ),
        };
      }
      return schema.validate(value);
    },
  });
}
