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
import type { HostToolRun } from "../ai/host-tool-catalog";

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
  /** Reuse the Web Host's immutable run instead of reconstructing policy. */
  hostRun?: HostToolRun;
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

  const tools = options.hostRun?.modelTools ?? options.tools;
  for (const [name, definition] of Object.entries(tools).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (
      omittedNames.has(name) ||
      (options.hostRun
        ? !options.hostRun.authority.has(name)
        : !isAllowedTool(
            name,
            options.mode,
            options.platform,
            allowedMcpAliases,
          ))
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
    if (omittedNames.has(extra.name)) continue;
    if (entries.has(extra.name)) {
      throw new Error(
        `Local adapter name collision for "${extra.name}" in the immutable Host run.`,
      );
    }
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

  return Object.freeze({
    entries: entriesView,
    specs,
    names: namesView,
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
      if (options.hostRun?.authority.has(name)) {
        return options.hostRun.authority.validate(name, value);
      }
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
