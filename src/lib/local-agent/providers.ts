export const LOCAL_AGENT_PROVIDER_CATALOG = {
  codex: {
    id: "codex",
    displayName: "Codex",
    cliName: "codex",
    modelName: "Codex",
    nativeSearch: true,
    imageGeneration: true,
    imageEditing: true,
    mediaCapabilitiesVerified: true,
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    cliName: "claude",
    modelName: "Claude",
    nativeSearch: true,
    imageGeneration: false,
    imageEditing: false,
    mediaCapabilitiesVerified: true,
  },
  pi: {
    id: "pi",
    displayName: "Pi",
    cliName: "pi",
    modelName: "Pi",
    nativeSearch: false,
    imageGeneration: false,
    imageEditing: false,
    mediaCapabilitiesVerified: true,
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    cliName: "agy",
    modelName: "Antigravity",
    nativeSearch: true,
    imageGeneration: true,
    imageEditing: false,
    mediaCapabilitiesVerified: false,
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

export function localAgentImageCapabilities(provider: LocalAgentProvider): {
  imageGeneration: boolean;
  imageEditing: boolean;
  mediaCapabilitiesVerified: boolean;
} {
  const { imageGeneration, imageEditing, mediaCapabilitiesVerified } =
    LOCAL_AGENT_PROVIDER_CATALOG[provider];
  return { imageGeneration, imageEditing, mediaCapabilitiesVerified };
}
