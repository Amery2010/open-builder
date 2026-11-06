import { Channel, invoke } from "@tauri-apps/api/core";
import { getMcpPlatformCapabilities } from "../mcp/tauri-host";
import type {
  LocalAgentEvent,
  LocalAgentPreference,
  LocalAgentProbe,
  LocalAgentProvider,
  LocalAgentStartRequest,
  LocalGeneratedImage,
  LocalImageGenerationRequest,
  LocalToolResolution,
  LocalRecoveryLease,
  LocalRecoverableRun,
  LocalRecoveryEnvelope,
  LocalRecoverySnapshot,
  LocalRecoveryContext,
  LocalToolClaim,
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
  const { recovery, ...nativeRequest } = request;
  return invoke<string>("local_agent_start", {
    request: nativeRequest,
    onEvent: channel,
    recovery,
    pageOwner: localAgentPageOwner,
  });
}

export async function resolveLocalAgentTool(
  runId: string,
  callId: string,
  result: LocalToolResolution,
  lease?: LocalRecoveryLease,
  recoveryContext?: LocalRecoveryContext,
): Promise<void> {
  await invoke("local_agent_resolve_tool", {
    runId,
    callId,
    result,
    lease,
    recoveryContext,
  });
}

export async function cancelLocalAgent(runId: string): Promise<boolean> {
  return invoke<boolean>("local_agent_cancel", { runId });
}

export async function cancelAllLocalAgents(): Promise<number> {
  if (!(await supportsLocalAgents())) return 0;
  return invoke<number>("local_agent_cancel_all");
}

export async function generateLocalAgentImage(
  request: LocalImageGenerationRequest,
): Promise<LocalGeneratedImage> {
  return invoke<LocalGeneratedImage>("local_agent_generate_image", { request });
}

export async function cancelLocalAgentImage(taskId: string): Promise<boolean> {
  return invoke<boolean>("local_agent_cancel_image", { taskId });
}

export const localAgentPageOwner =
  globalThis.crypto?.randomUUID?.() ?? `page-${Date.now()}-${Math.random()}`;
let recoveryDiscovery: Promise<void> | undefined;
export async function listRecoverableLocalAgents(): Promise<
  LocalRecoverableRun[]
> {
  // Scripts have their own native process registry. The previous page's abort
  // listeners no longer exist after reload, so retire them once per new page.
  recoveryDiscovery ??= invoke<void>("cancel_all_skill_scripts");
  await recoveryDiscovery;
  return invoke("local_agent_list_recoverable", { owner: localAgentPageOwner });
}
export function attachLocalAgent(
  runId: string,
  onEvent: (event: LocalRecoveryEnvelope) => void,
): Promise<LocalRecoverySnapshot> {
  const channel = new Channel<LocalRecoveryEnvelope>(onEvent);
  return invoke("local_agent_attach", {
    runId,
    owner: localAgentPageOwner,
    onEvent: channel,
  });
}
export function claimLocalAgentTool(
  runId: string,
  callId: string,
  lease: LocalRecoveryLease,
): Promise<LocalToolClaim> {
  return invoke("local_agent_claim_tool", { runId, callId, lease });
}
export function acknowledgeLocalAgentTerminal(
  runId: string,
  lease: LocalRecoveryLease,
): Promise<void> {
  return invoke("local_agent_acknowledge_terminal", { runId, lease });
}
