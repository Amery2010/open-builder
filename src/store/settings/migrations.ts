import {
  DEFAULT_OPENAI_MODEL,
  type ApiType,
} from "../../lib/ai/provider-config";
import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "../../lib/local-agent/providers";
import {
  createEmptyLocalCliObservationCache,
  sanitizeLocalCliObservationCache,
} from "../../lib/local-agent/observations";
import {
  IMAGE_COMPRESSION_DEFAULT_QUALITY,
  IMAGE_COMPRESSION_MAX_QUALITY,
  IMAGE_COMPRESSION_MIN_QUALITY,
} from "./system";

export const SETTINGS_VERSION = 24;

interface PersistedLocalAgentPreferences {
  model: string;
  effort: string;
}

function migrateLocalAgentPreferences(
  localAgent: Record<string, any>,
): Record<LocalAgentProvider, PersistedLocalAgentPreferences> {
  const source =
    localAgent.preferences && typeof localAgent.preferences === "object"
      ? localAgent.preferences
      : localAgent;
  return Object.fromEntries(
    LOCAL_AGENT_PROVIDERS.map(({ id }) => {
      const preferences = source[id];
      return [
        id,
        {
          model:
            typeof preferences?.model === "string" ? preferences.model : "",
          effort:
            typeof preferences?.effort === "string" ? preferences.effort : "",
        },
      ];
    }),
  ) as Record<LocalAgentProvider, PersistedLocalAgentPreferences>;
}

export function migrateSettings(persisted: unknown, version: number): unknown {
  const state =
    persisted && typeof persisted === "object" && !Array.isArray(persisted)
      ? (persisted as Record<string, any>)
      : {};
  if (version === 0 && state.ai?.apiUrl) {
    let baseUrl: string = state.ai.apiUrl;
    baseUrl = baseUrl.replace(/\/chat\/completions$/, "");
    state.ai.apiBaseUrl = baseUrl.replace(/\/+$/, "");
    delete state.ai.apiUrl;
  }
  if (version < 2) {
    if (!state.webSearch) state.webSearch = {};
    state.webSearch.engine = state.webSearch.tavilyApiKey
      ? "tavily"
      : "disabled";
    state.webSearch.firecrawlApiKey = "";
  }
  if (version < 3) {
    if (!state.assetSearch) {
      state.assetSearch = {
        engine: "disabled",
        pixabayApiKey: "",
        unsplashApiKey: "",
      };
    }
  }
  if (version < 4) {
    if (!state.ai) state.ai = {};
    if (!state.ai.apiType) {
      state.ai.apiType = "openai-compatible";
    }
  }
  if (version < 5) {
    if (!state.system) state.system = {};
    if (state.system.reverseProxy === undefined) {
      state.system.reverseProxy = false;
    }
    if (state.system.reverseProxyAllowedHosts === undefined) {
      state.system.reverseProxyAllowedHosts = "";
    }
  }
  if (version < 8) {
    if (!state.system) state.system = {};
    if (state.system.planModeEnabled === undefined) {
      state.system.planModeEnabled = false;
    }
  }
  if (version < 10) {
    if (!state.system) state.system = {};
    if (state.system.reverseProxyAllowedHosts === undefined) {
      state.system.reverseProxyAllowedHosts = "";
    }
  }
  if (version < 11) {
    if (!state.system) state.system = {};
    if (state.system.autoQaEnabled === undefined) {
      state.system.autoQaEnabled = false;
    }
  }
  if (version < 12) {
    if (state.webSearch?.engine === "server") {
      state.webSearch.engine = "disabled";
    }
    if (state.webSearch) delete state.webSearch.backendProvider;

    if (state.assetSearch?.engine === "server") {
      state.assetSearch.engine = "disabled";
    }
    if (state.assetSearch) delete state.assetSearch.backendProvider;

    delete state.serverService;
    delete state.serverServiceCache;
    delete state.modelCache;
  }
  if (version < 14) {
    if (state.webSearch) {
      delete state.webSearch.tavilyApiUrl;
      delete state.webSearch.firecrawlApiUrl;
    }
    if (state.assetSearch) {
      delete state.assetSearch.pixabayApiUrl;
      delete state.assetSearch.unsplashApiUrl;
    }
  }
  if (version < 15) {
    if (!state.system) state.system = {};
    state.system.developerSkillScriptsEnabled = false;
  }
  if (version < 16) {
    if (!state.ai) state.ai = {};
    state.ai.runtime = state.ai.runtime === "localCli" ? "localCli" : "api";
    const localAgent = state.ai.localAgent ?? {};
    state.ai.localAgent = {
      provider: localAgent.provider === "claude" ? "claude" : "codex",
      preferences: migrateLocalAgentPreferences(localAgent),
    };
  }
  if (version < 17) {
    if (!state.ai) state.ai = {};
    const apiType = state.ai.apiType as ApiType | undefined;
    if (
      (apiType === "openai" || apiType === "openai-compatible") &&
      (typeof state.ai.model !== "string" || !state.ai.model.trim())
    ) {
      state.ai.model = DEFAULT_OPENAI_MODEL;
    }
  }
  if (version < 18) {
    if (!state.system) state.system = {};
    if (typeof state.system.customSystemPrompt !== "string") {
      state.system.customSystemPrompt = "";
    }
  }
  if (version < 19) {
    if (!state.webSearch) state.webSearch = {};
    if (typeof state.webSearch.exaApiKey !== "string") {
      state.webSearch.exaApiKey = "";
    }
  }
  if (version < 20) {
    if (!state.ai) state.ai = {};
    const localAgent = state.ai.localAgent ?? {};
    state.ai.localAgent = {
      provider: isLocalAgentProvider(localAgent.provider)
        ? localAgent.provider
        : "codex",
      preferences: migrateLocalAgentPreferences(localAgent),
    };
  }
  if (version < 21) {
    if (!state.ai) state.ai = {};
    const localAgent = state.ai.localAgent ?? {};
    state.ai.localAgent = {
      provider: isLocalAgentProvider(localAgent.provider)
        ? localAgent.provider
        : "codex",
      preferences: migrateLocalAgentPreferences(localAgent),
    };
  }
  if (version < 22) {
    state.localCliObservationCache = createEmptyLocalCliObservationCache();
  } else {
    state.localCliObservationCache = sanitizeLocalCliObservationCache(
      state.localCliObservationCache,
    );
  }
  if (version < 23) {
    if (!state.system) state.system = {};
    if (typeof state.system.permissionBrokerBypassEnabled !== "boolean") {
      state.system.permissionBrokerBypassEnabled = false;
    }
  }
  if (!state.system) state.system = {};
  if (typeof state.system.imageCompressionEnabled !== "boolean") {
    state.system.imageCompressionEnabled = true;
  }
  if (
    typeof state.system.imageCompressionQuality !== "number" ||
    !Number.isFinite(state.system.imageCompressionQuality) ||
    state.system.imageCompressionQuality < IMAGE_COMPRESSION_MIN_QUALITY ||
    state.system.imageCompressionQuality > IMAGE_COMPRESSION_MAX_QUALITY
  ) {
    state.system.imageCompressionQuality = IMAGE_COMPRESSION_DEFAULT_QUALITY;
  }
  return state;
}
