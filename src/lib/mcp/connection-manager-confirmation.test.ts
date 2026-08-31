// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServerEntry } from "./validation";
import { captureMcpLifecycleEpoch } from "./revocation";

interface CapturedRemoteOptions {
  confirmCrossOriginIssuer?: (
    issuer: URL,
    server: URL,
  ) => boolean | Promise<boolean>;
}

const confirmation = vi.hoisted(() => ({ request: vi.fn() }));
const remote = vi.hoisted(() => ({
  options: null as CapturedRemoteOptions | null,
}));

vi.mock("../confirmation", () => ({
  requestConfirmation: confirmation.request,
}));

vi.mock("./remote-client", () => ({
  McpNeedsAuthError: class McpNeedsAuthError extends Error {},
  RemoteMcpClient: class RemoteMcpClient {
    constructor(_entry: unknown, options: CapturedRemoteOptions) {
      remote.options = options;
    }
  },
}));

vi.mock("./tauri-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tauri-host")>();
  return {
    ...actual,
    getMcpPlatformCapabilities: vi.fn(async () => ({
      remoteStreaming: false,
      stdio: false,
      oauthLoopback: false,
      skillScripts: false,
      localAgents: false,
    })),
    isTauriMcpHost: vi.fn(() => false),
  };
});

import { McpConnectionManager } from "./connection-manager";

describe("MCP cross-origin issuer confirmation", () => {
  beforeEach(() => {
    confirmation.request.mockReset();
    remote.options = null;
  });

  it("awaits and honors an asynchronous denial", async () => {
    confirmation.request.mockResolvedValue(false);
    const entry = createMcpServerEntry(
      {
        name: "OAuth MCP",
        enabled: true,
        transport: "streamable-http",
        url: "https://mcp.example.com/rpc",
      },
      { id: "oauth-mcp", now: 1 },
    );
    const manager = new McpConnectionManager();

    await (
      manager as unknown as {
        createRemote: (value: typeof entry, epoch: number) => Promise<unknown>;
      }
    ).createRemote(entry, captureMcpLifecycleEpoch());

    const approve = remote.options?.confirmCrossOriginIssuer;
    expect(approve).toBeTypeOf("function");
    await expect(
      approve!(
        new URL("https://login.example.net"),
        new URL("https://mcp.example.com"),
      ),
    ).resolves.toBe(false);
    expect(confirmation.request).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("https://login.example.net"),
      }),
    );
  });
});
