import { Channel, invoke } from "@tauri-apps/api/core";
import { getMcpPlatformCapabilities } from "../mcp/tauri-host";
import type {
  LocalAgentEvent,
  LocalAgentPreference,
  LocalAgentProbe,
  LocalAgentProvider,
  LocalAgentStartRequest,
  LocalToolResolution,
} from "./types";

let localAgentSupportPromise: Promise<boolean> | null = null;

export function isLocalAgentHost(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Returns the desktop backend's authoritative local-agent capability.
 * Web/mobile resolve to false; backend errors reject so callers can distinguish
 * an unavailable platform from a transient capability-query failure.
 */
export function queryLocalAgentSupport(): Promise<boolean> {
  if (!localAgentSupportPromise) {
    const request = getMcpPlatformCapabilities().then(
      (capabilities) => capabilities.localAgents === true,
    );
    localAgentSupportPromise = request;
    void request.catch(() => {
      if (localAgentSupportPromise === request) {
        localAgentSupportPromise = null;
      }
    });
  }
  return localAgentSupportPromise;
}

export async function supportsLocalAgents(): Promise<boolean> {
  try {
    return await queryLocalAgentSupport();
  } catch {
    return false;
  }
}

/** Clears the cached capability result for explicit retries and isolated tests. */
export function resetLocalAgentSupportCache(): void {
  localAgentSupportPromise = null;
}

export const resetLocalAgentSupportCacheForTests = resetLocalAgentSupportCache;

export async function probeLocalAgent(
  provider: LocalAgentProvider,
  preference: LocalAgentPreference,
  forceRefresh = false,
): Promise<LocalAgentProbe> {
  return invoke<LocalAgentProbe>("local_agent_probe", {
    provider,
    preference,
    forceRefresh,
  });
}

export async function chooseLocalAgentExecutable(
  provider: LocalAgentProvider,
  preference: LocalAgentPreference,
): Promise<LocalAgentProbe | null> {
  return invoke<LocalAgentProbe | null>("local_agent_choose_executable", {
    provider,
    preference,
  });
}

export async function clearLocalAgentExecutable(
  provider: LocalAgentProvider,
  preference: LocalAgentPreference,
): Promise<LocalAgentProbe> {
  return invoke<LocalAgentProbe>("local_agent_clear_executable", {
    provider,
    preference,
  });
}

export async function startLocalAgent(
  request: LocalAgentStartRequest,
  onEvent: (event: LocalAgentEvent) => void,
): Promise<string> {
  const channel = new Channel<LocalAgentEvent>(onEvent);
  return invoke<string>("local_agent_start", { request, onEvent: channel });
}

export async function resolveLocalAgentTool(
  runId: string,
  callId: string,
  result: LocalToolResolution,
): Promise<void> {
  await invoke("local_agent_resolve_tool", { runId, callId, result });
}

export async function cancelLocalAgent(runId: string): Promise<boolean> {
  return invoke<boolean>("local_agent_cancel", { runId });
}

export async function cancelAllLocalAgents(): Promise<number> {
  if (!(await supportsLocalAgents())) return 0;
  return invoke<number>("local_agent_cancel_all");
}
