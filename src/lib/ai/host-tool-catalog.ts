import { asSchema, type ToolSet } from "ai";

import type {
  ExecutionMode,
  RuntimePlatform,
  ToolApproval,
  ToolEffect,
  ToolProfile,
  ToolRunContext,
  ToolSource,
} from "./tools-schema";
import type {
  ProjectPermissionOperation,
  ProjectPermissionScope,
} from "../security/project-permission-broker";

export type ToolOutputRetention = "full" | "summary-only" | "run-only";

export interface HostToolProjectPermissionResolution {
  readonly scope: ProjectPermissionScope;
  readonly affectedPaths: readonly string[];
  readonly affectedCount: number;
}

export interface HostToolProjectPermission {
  readonly operation: ProjectPermissionOperation;
  readonly sessionEligible: boolean;
  /** Pure preflight over already schema-validated input and canonical
   * ProjectFiles. Undefined means the operation is empty or would already
   * fail, so the implementation returns its normal tool result without a
   * meaningless permission prompt. */
  readonly resolve: (
    input: unknown,
    files: Readonly<Record<string, string>>,
  ) =>
    | HostToolProjectPermissionResolution
    | undefined
    | Promise<HostToolProjectPermissionResolution | undefined>;
}

export interface HostToolPresentation {
  readonly name: Readonly<{ en: string; zh: string }>;
  readonly iconKey: string;
  readonly summarizeArguments: (args: unknown) => string;
}

export type HostToolImplementation =
  | Readonly<{
      kind: "host";
      key: string;
      /** Only named hybrid capabilities may be replaced by a trusted
       * provider-native implementation for a particular run. */
      providerAlternative?: boolean;
    }>
  | Readonly<{ kind: "provider" }>;

/**
 * One static declaration for a Host capability. Runtime-only adapters may add
 * records while a run is opened, but they can never replace a static record.
 */
export interface HostToolRecord {
  readonly name: string;
  readonly definition?: ToolSet[string];
  readonly source: ToolSource;
  readonly effects: readonly ToolEffect[];
  readonly modes: readonly ExecutionMode[];
  readonly profiles: readonly ToolProfile[];
  readonly platforms: readonly RuntimePlatform[];
  readonly approval: ToolApproval;
  readonly outputRetention: ToolOutputRetention;
  readonly presentation: HostToolPresentation;
  readonly implementation: HostToolImplementation;
  readonly projectPermission?: HostToolProjectPermission;
}

export interface HostToolDispatchCall {
  readonly name: string;
  readonly input: unknown;
  readonly callId?: string;
}

export type HostToolDispatchStage =
  "authority" | "schema" | "guard" | "approval" | "implementation" | "state";

export class HostToolDispatchError extends Error {
  constructor(
    readonly stage: HostToolDispatchStage,
    message: string,
  ) {
    super(message);
    this.name = "HostToolDispatchError";
  }
}

export interface HostToolRunAuthority {
  readonly records: ReadonlyMap<string, HostToolRecord>;
  readonly names: ReadonlySet<string>;
  has(name: string): boolean;
  get(name: string): HostToolRecord | undefined;
  validate(
    name: string,
    input: unknown,
  ): Promise<
    { success: true; value: unknown } | { success: false; error: Error }
  >;
}

export interface HostToolRun {
  readonly modelTools: ToolSet;
  readonly authority: HostToolRunAuthority;
  readonly providerOwnedNames: ReadonlySet<string>;
  dispatch(call: HostToolDispatchCall): Promise<unknown>;
}

export interface HostToolOpenRunOptions {
  readonly tools: ToolSet;
  readonly context: ToolRunContext;
  readonly profile?: ToolProfile;
  readonly allowedDynamicNames?: ReadonlySet<string>;
  readonly providerOwnedNames?: ReadonlySet<string>;
  readonly hostDispatcher?: (
    call: HostToolDispatchCall,
    record: HostToolRecord,
  ) => unknown | Promise<unknown>;
  readonly guard?: (
    call: HostToolDispatchCall,
    record: HostToolRecord,
  ) => string | void | Promise<string | void>;
  readonly requestApproval?: (
    call: HostToolDispatchCall,
    record: HostToolRecord,
  ) => string | void | Promise<string | void>;
  readonly validateState?: (
    result: unknown,
    call: HostToolDispatchCall,
    record: HostToolRecord,
  ) => string | void | Promise<string | void>;
  readonly retainOutput?: (
    result: unknown,
    retention: ToolOutputRetention,
    call: HostToolDispatchCall,
    record: HostToolRecord,
  ) => unknown | Promise<unknown>;
  readonly audit?: (call: HostToolDispatchCall, record: HostToolRecord) => void;
}

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

function freezeRecord(record: HostToolRecord): HostToolRecord {
  return Object.freeze({
    ...record,
    effects: Object.freeze([...record.effects]),
    modes: Object.freeze([...record.modes]),
    profiles: Object.freeze([...record.profiles]),
    platforms: Object.freeze([...record.platforms]),
    presentation: Object.freeze({
      ...record.presentation,
      name: Object.freeze({ ...record.presentation.name }),
    }),
    implementation: Object.freeze({ ...record.implementation }),
    projectPermission: record.projectPermission
      ? Object.freeze({ ...record.projectPermission })
      : undefined,
  });
}

function dynamicRecord(
  name: string,
  definition: ToolSet[string],
  providerOwned: boolean,
): HostToolRecord {
  return freezeRecord({
    name,
    definition,
    source: providerOwned ? "network" : "mcp",
    effects: providerOwned ? ["network"] : ["network", "write_runtime"],
    modes: ["chat", "plan"],
    profiles: ["default", "design"],
    platforms: ["web", "desktop", "mobile"],
    approval: providerOwned ? "none" : "session",
    outputRetention: "full",
    presentation: {
      name: { en: name, zh: name },
      iconKey: providerOwned ? "provider" : "mcp",
      summarizeArguments: () => name,
    },
    implementation: providerOwned
      ? { kind: "provider" }
      : { kind: "host", key: "dynamic-adapter" },
  });
}

/** Flat, immutable catalog. It is the only source from which a run authority
 * is compiled; the returned run owns model visibility, validation and Host
 * dispatch for its lifetime. */
export class HostToolCatalog {
  private readonly records: ReadonlyMap<string, HostToolRecord>;

  constructor(records: readonly HostToolRecord[]) {
    const byName = new Map<string, HostToolRecord>();
    for (const candidate of records) {
      if (byName.has(candidate.name)) {
        throw new Error(`Duplicate Host tool record "${candidate.name}".`);
      }
      byName.set(candidate.name, freezeRecord(candidate));
    }
    this.records = readonlyMap(byName);
    Object.freeze(this);
  }

  get(name: string): HostToolRecord | undefined {
    return this.records.get(name);
  }

  list(): readonly HostToolRecord[] {
    return Object.freeze([...this.records.values()]);
  }

  openRun(options: HostToolOpenRunOptions): HostToolRun {
    const profile = options.profile ?? "default";
    const allowedDynamicNames =
      options.allowedDynamicNames ?? options.context.allowedMcpAliases;
    const requestedProviderNames = options.providerOwnedNames ?? new Set();
    const selected = new Map<string, HostToolRecord>();
    const modelTools: ToolSet = {};

    for (const [name, definition] of Object.entries(options.tools)) {
      const staticRecord = this.records.get(name);
      let record = staticRecord;
      if (staticRecord) {
        const providerOwnedOverride = requestedProviderNames.has(name);
        const providerAlternativeAllowed =
          staticRecord.implementation.kind === "provider" ||
          (staticRecord.implementation.kind === "host" &&
            staticRecord.implementation.providerAlternative === true);
        if (providerOwnedOverride && !providerAlternativeAllowed) {
          throw new Error(
            `Host tool name collision for "${name}": provider ownership is not declared by the static record.`,
          );
        }
        if (
          staticRecord.definition &&
          staticRecord.definition !== definition &&
          !providerOwnedOverride
        ) {
          throw new Error(
            `Host tool name collision for "${name}": a dynamic adapter attempted to replace a static definition.`,
          );
        }
        if (
          !staticRecord.modes.includes(options.context.mode) ||
          !staticRecord.platforms.includes(options.context.platform) ||
          !staticRecord.profiles.includes(profile)
        ) {
          continue;
        }
        if (
          providerOwnedOverride &&
          staticRecord.implementation.kind !== "provider"
        ) {
          record = freezeRecord({
            ...staticRecord,
            definition,
            implementation: { kind: "provider" },
          });
        }
      } else {
        const providerOwned = requestedProviderNames.has(name);
        if (
          profile === "design_review" ||
          options.context.mode === "auto_qa" ||
          (!providerOwned && !allowedDynamicNames.has(name))
        ) {
          continue;
        }
        record = dynamicRecord(name, definition, providerOwned);
      }
      if (!record) continue;
      const selectedRecord: HostToolRecord = {
        name: record.name,
        definition,
        source: record.source,
        effects: record.effects,
        modes: record.modes,
        profiles: record.profiles,
        platforms: record.platforms,
        approval: record.approval,
        outputRetention: record.outputRetention,
        presentation: record.presentation,
        implementation: record.implementation,
        projectPermission: record.projectPermission,
      };
      selected.set(name, freezeRecord(selectedRecord));
      modelTools[name] = definition;
    }

    const recordsView = readonlyMap(selected);
    const names = new Set(selected.keys());
    const namesView = readonlySet(names);
    const providerOwned = readonlySet(
      new Set(
        [...selected.values()]
          .filter((record) => record.implementation.kind === "provider")
          .map((record) => record.name),
      ),
    );
    const authority: HostToolRunAuthority = Object.freeze({
      records: recordsView,
      names: namesView,
      has: (name: string) => names.has(name),
      get: (name: string) => selected.get(name),
      async validate(name: string, input: unknown) {
        const definition = selected.get(name)?.definition;
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
        return schema.validate(input);
      },
    });

    return Object.freeze({
      modelTools: Object.freeze({ ...modelTools }),
      authority,
      providerOwnedNames: providerOwned,
      async dispatch(call: HostToolDispatchCall): Promise<unknown> {
        const record = selected.get(call.name);
        if (!record) {
          throw new HostToolDispatchError(
            "authority",
            `Tool "${call.name}" is not authorized for this run.`,
          );
        }
        const checked = await authority.validate(call.name, call.input);
        if (!checked.success) {
          throw new HostToolDispatchError(
            "schema",
            `Invalid arguments for "${call.name}": ${checked.error.message}`,
          );
        }
        const normalizedCall = Object.freeze({
          ...call,
          input: checked.value,
        });
        const guardDenial = await options.guard?.(normalizedCall, record);
        if (guardDenial) {
          throw new HostToolDispatchError("guard", guardDenial);
        }
        const approvalDenial = await options.requestApproval?.(
          normalizedCall,
          record,
        );
        if (approvalDenial) {
          throw new HostToolDispatchError("approval", approvalDenial);
        }
        if (record.implementation.kind === "provider") {
          throw new HostToolDispatchError(
            "implementation",
            `Provider-owned tool "${call.name}" cannot be dispatched by the Host.`,
          );
        }
        if (!options.hostDispatcher) {
          throw new HostToolDispatchError(
            "implementation",
            `Host tool "${call.name}" has no runtime adapter.`,
          );
        }
        const result = await options.hostDispatcher(normalizedCall, record);
        const stateError = await options.validateState?.(
          result,
          normalizedCall,
          record,
        );
        if (stateError) {
          throw new HostToolDispatchError("state", stateError);
        }
        const retained = options.retainOutput
          ? await options.retainOutput(
              result,
              record.outputRetention,
              normalizedCall,
              record,
            )
          : result;
        options.audit?.(normalizedCall, record);
        return retained;
      },
    });
  }
}
