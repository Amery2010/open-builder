export const LOCAL_AGENT_PROVIDER_CATALOG = {
  codex: {
    id: "codex",
    displayName: "Codex",
    cliName: "codex",
    modelName: "Codex",
    nativeSearch: true,
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    cliName: "claude",
    modelName: "Claude",
    nativeSearch: true,
  },
  pi: {
    id: "pi",
    displayName: "Pi",
    cliName: "pi",
    modelName: "Pi",
    nativeSearch: false,
  },
} as const;

export type LocalAgentProvider = keyof typeof LOCAL_AGENT_PROVIDER_CATALOG;

export const LOCAL_AGENT_PROVIDERS = Object.values(
  LOCAL_AGENT_PROVIDER_CATALOG,
);

export function isLocalAgentProvider(
  value: unknown,
): value is LocalAgentProvider {
  return (
    typeof value === "string" &&
    Object.hasOwn(LOCAL_AGENT_PROVIDER_CATALOG, value)
  );
}

export function localAgentSupportsNativeSearch(
  provider: LocalAgentProvider,
): boolean {
  return LOCAL_AGENT_PROVIDER_CATALOG[provider].nativeSearch;
}
