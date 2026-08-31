import { describe, expect, it } from "vitest";
import {
  isLocalAgentProvider,
  localAgentSupportsNativeSearch,
  LOCAL_AGENT_PROVIDER_CATALOG,
  LOCAL_AGENT_PROVIDERS,
} from "./providers";

describe("local-agent provider catalog", () => {
  it("is the complete unique provider registry", () => {
    expect(LOCAL_AGENT_PROVIDERS.map(({ id }) => id)).toEqual([
      "codex",
      "claude",
      "pi",
    ]);
    expect(new Set(LOCAL_AGENT_PROVIDERS.map(({ id }) => id)).size).toBe(
      LOCAL_AGENT_PROVIDERS.length,
    );
    expect(LOCAL_AGENT_PROVIDER_CATALOG.pi).toMatchObject({
      displayName: "Pi",
      cliName: "pi",
      nativeSearch: false,
    });
  });

  it("validates persisted and native provider ids", () => {
    expect(isLocalAgentProvider("codex")).toBe(true);
    expect(isLocalAgentProvider("claude")).toBe(true);
    expect(isLocalAgentProvider("pi")).toBe(true);
    expect(isLocalAgentProvider("deepseek")).toBe(false);
    expect(isLocalAgentProvider("toString")).toBe(false);
    expect(isLocalAgentProvider(null)).toBe(false);
  });

  it("exposes native-search support through the provider catalog", () => {
    expect(localAgentSupportsNativeSearch("codex")).toBe(true);
    expect(localAgentSupportsNativeSearch("claude")).toBe(true);
    expect(localAgentSupportsNativeSearch("pi")).toBe(false);
  });
});
