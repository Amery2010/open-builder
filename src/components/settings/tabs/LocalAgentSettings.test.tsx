// @vitest-environment jsdom

import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAgentAvailability,
  LocalAgentModel,
  LocalAgentProvider,
  PreferenceDecision,
} from "../../../lib/local-agent/types";
import { useSettingsStore } from "../../../store/settings";
import { aiDefaults } from "../../../store/settings/ai";
import type { AISettings } from "../../../store/settings/ai";
import { systemDefaults } from "../../../store/settings/system";
import { LocalAgentSettings } from "./LocalAgentSettings";

const localAgentMocks = vi.hoisted(() => ({
  probe: vi.fn(),
  choose: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("../../../lib/local-agent/tauri", () => ({
  supportsLocalAgents: vi.fn(async () => true),
  probeLocalAgent: localAgentMocks.probe,
  chooseLocalAgentExecutable: localAgentMocks.choose,
  clearLocalAgentExecutable: localAgentMocks.clear,
}));

function probe(
  availability: LocalAgentAvailability,
  provider: LocalAgentProvider = "codex",
  models: LocalAgentModel[] = [],
  preferenceDecision: PreferenceDecision = {
    kind: "keep",
    unverified: false,
  },
) {
  return {
    provider,
    availability,
    path:
      availability === "notFound" ? undefined : `/usr/local/bin/${provider}`,
    pathSource: "path" as const,
    version: `${provider} 1.0.0`,
    setupCommand: provider === "pi" ? "pi" : `${provider} login`,
    models,
    efforts: [],
    preferenceDecision,
    capabilities: {
      sessions: true,
      reasoning: true,
      tools: true,
      nativeSearch: provider !== "pi",
    },
    message:
      availability === "unsupported"
        ? "Protocol isolation unavailable"
        : undefined,
  };
}

function Harness({
  supported = true,
  runtimeChangeLocked = false,
  initialSettings,
}: {
  supported?: boolean;
  runtimeChangeLocked?: boolean;
  initialSettings?: AISettings;
}) {
  const [formData, setFormData] = useState<AISettings>(
    initialSettings ?? {
      ...aiDefaults,
      runtime: "localCli" as const,
    },
  );
  return (
    <>
      <LocalAgentSettings
        value={formData.localAgent}
        onChange={(localAgent) => setFormData({ ...formData, localAgent })}
        supported={supported}
        runtimeChangeLocked={runtimeChangeLocked}
      />
      <output data-testid="local-agent-state" hidden>
        {JSON.stringify(formData.localAgent)}
      </output>
    </>
  );
}

describe("LocalAgentSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    useSettingsStore.setState({
      system: { ...systemDefaults, language: "en" },
    });
  });

  it("blocks local CLI on unsupported platforms without probing", async () => {
    const { container } = render(<Harness supported={false} />);

    expect(screen.getByText("Local CLI is desktop-only")).toBeInTheDocument();
    expect(localAgentMocks.probe).not.toHaveBeenCalled();
    expect((await axe(container)).violations).toEqual([]);
  });

  it.each([
    ["ready", "Installed and ready"],
    ["needsSetup", "Installed, setup required"],
    ["notFound", "CLI not found"],
    ["unsupported", "CLI unavailable"],
    ["error", "CLI unavailable"],
  ] as const)("renders the %s probe state", async (availability, label) => {
    localAgentMocks.probe.mockResolvedValue(probe(availability));

    render(<Harness />);

    expect(await screen.findByText(label)).toBeInTheDocument();
    if (availability === "needsSetup") {
      expect(
        screen.getByRole("button", { name: "Copy setup command" }),
      ).toBeInTheDocument();
    }
  });

  it("localizes provider probe diagnostics instead of rendering backend prose", async () => {
    localAgentMocks.probe.mockResolvedValue(probe("unsupported"));

    render(<Harness />);

    expect(
      await screen.findByText(
        "Check the installation or choose the executable, then rescan.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Protocol isolation unavailable"),
    ).not.toBeInTheDocument();
  });

  it("renders verification-required readiness as sendable but not ready", async () => {
    localAgentMocks.probe.mockResolvedValue({
      ...probe("ready"),
      status: "verificationRequired",
    });

    render(<Harness />);

    expect(
      await screen.findByText(
        "Ready to send; verification required on first run",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Installed and ready")).not.toBeInTheDocument();
    expect(screen.getByLabelText("CLI model (Codex)")).toBeEnabled();
  });

  it("announces scanning, supports keyboard rescan, and passes axe when ready", async () => {
    const user = userEvent.setup();
    let resolveProbe: ((value: ReturnType<typeof probe>) => void) | undefined;
    localAgentMocks.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const { container } = render(<Harness />);

    expect(await screen.findByText("Detecting local CLI…")).toBeInTheDocument();
    resolveProbe?.(probe("ready"));
    expect(await screen.findByText("Installed and ready")).toBeInTheDocument();

    localAgentMocks.probe.mockResolvedValue(probe("ready"));
    const rescan = screen.getByRole("button", { name: "Rescan" });
    rescan.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(localAgentMocks.probe).toHaveBeenCalledTimes(2));
    expect(localAgentMocks.probe).toHaveBeenLastCalledWith(
      "codex",
      { model: "", effort: "" },
      true,
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it("renders the four-provider catalog in a locked two-column chooser", async () => {
    localAgentMocks.probe.mockResolvedValue(probe("ready"));

    render(<Harness runtimeChangeLocked />);

    const chooser = screen.getByRole("group", { name: "CLI provider" });
    expect(chooser).toHaveClass("grid-cols-2");
    for (const name of ["Codex", "Claude", "Pi", "Antigravity"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(await screen.findByText("Installed and ready")).toBeInTheDocument();
  });

  it("probes Antigravity when selected", async () => {
    const user = userEvent.setup();
    localAgentMocks.probe.mockImplementation(async (provider) =>
      probe("ready", provider),
    );

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Antigravity" }));

    await waitFor(() =>
      expect(localAgentMocks.probe).toHaveBeenCalledWith(
        "antigravity",
        { model: "", effort: "" },
        false,
      ),
    );
    expect(
      await screen.findByText("/usr/local/bin/antigravity"),
    ).toBeInTheDocument();
  });

  it("ignores a late probe result after switching providers", async () => {
    const user = userEvent.setup();
    let resolveCodex: ((value: ReturnType<typeof probe>) => void) | undefined;
    let resolveClaude: ((value: ReturnType<typeof probe>) => void) | undefined;
    localAgentMocks.probe.mockImplementation(
      (provider: LocalAgentProvider) =>
        new Promise((resolve) => {
          if (provider === "codex") resolveCodex = resolve;
          else resolveClaude = resolve;
        }),
    );

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Claude" }));
    await waitFor(() =>
      expect(localAgentMocks.probe).toHaveBeenCalledWith(
        "claude",
        { model: "", effort: "" },
        false,
      ),
    );

    resolveClaude?.(probe("ready", "claude"));
    expect(
      await screen.findByText("/usr/local/bin/claude"),
    ).toBeInTheDocument();

    await act(async () => {
      resolveCodex?.(
        probe("ready", "codex", [
          {
            id: "codex-only",
            displayName: "Codex only",
            isDefault: true,
            efforts: ["high"],
          },
        ]),
      );
      await Promise.resolve();
    });

    expect(screen.getByText("/usr/local/bin/claude")).toBeInTheDocument();
    expect(screen.queryByText("Codex only")).not.toBeInTheDocument();
  });

  it("uses the CLI default model's supported efforts", async () => {
    localAgentMocks.probe.mockResolvedValue(
      probe("ready", "codex", [
        {
          id: "default-model",
          displayName: "Default model",
          isDefault: true,
          efforts: ["medium", "high"],
        },
      ]),
    );

    render(<Harness />);

    expect(
      await screen.findByLabelText("Reasoning effort"),
    ).toBeInTheDocument();
  });

  it("keeps a model id that matches the former CLI-default sentinel selectable", async () => {
    const user = userEvent.setup();
    localAgentMocks.probe.mockResolvedValue(
      probe("ready", "codex", [
        {
          id: "__cli_default__",
          displayName: "Literal default id",
          isDefault: false,
          efforts: [],
        },
      ]),
    );

    render(<Harness />);
    await screen.findByText("Installed and ready");
    screen.getByLabelText("CLI model (Codex)").focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");

    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("local-agent-state").textContent ?? "{}")
          .preferences.codex.model,
      ).toBe("__cli_default__"),
    );
  });

  it("offers Pi models and explains its in-CLI setup flow", async () => {
    const user = userEvent.setup();
    localAgentMocks.probe.mockImplementation(
      async (provider: LocalAgentProvider) =>
        provider === "pi"
          ? probe("needsSetup", "pi", [
              {
                id: "anthropic/claude-sonnet-4",
                displayName: "Claude Sonnet 4",
                isDefault: true,
                efforts: ["low", "high"],
              },
            ])
          : probe("ready", provider),
    );

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Pi" }));

    expect(
      await screen.findByText(
        "Start pi, then run /login to configure a provider.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("CLI model (Pi)")).toBeInTheDocument();
    expect(screen.getByLabelText("CLI model (Pi)")).toBeEnabled();
    expect(localAgentMocks.probe).toHaveBeenCalledWith(
      "pi",
      { model: "", effort: "" },
      false,
    );
    expect(screen.getByLabelText("Reasoning effort")).toBeInTheDocument();
  });

  it("chooses an executable override and restores auto-detection", async () => {
    const user = userEvent.setup();
    localAgentMocks.probe.mockResolvedValue(probe("notFound"));
    localAgentMocks.choose.mockResolvedValue({
      ...probe("ready"),
      path: "/Applications/Codex CLI/codex",
      pathSource: "override",
    });
    localAgentMocks.clear.mockResolvedValue(probe("ready"));

    render(<Harness />);
    expect(await screen.findByText("CLI not found")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Choose program" }));
    expect(localAgentMocks.choose).toHaveBeenCalledWith("codex", {
      model: "",
      effort: "",
    });
    expect(
      await screen.findByText("/Applications/Codex CLI/codex"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Use auto-detection" }),
    );
    expect(localAgentMocks.clear).toHaveBeenCalledWith("codex", {
      model: "",
      effort: "",
    });
    expect(await screen.findByText("/usr/local/bin/codex")).toBeInTheDocument();
  });

  it("reports setup-command copy success and failure inline", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    localAgentMocks.probe.mockResolvedValue(probe("needsSetup"));

    render(<Harness />);
    const copy = await screen.findByRole("button", {
      name: "Copy setup command",
    });
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith("codex login");
    expect(await screen.findByText("Setup command copied")).toBeInTheDocument();

    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await user.click(copy);
    expect(
      await screen.findByText(
        "Could not copy the setup command. Copy it manually and retry.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps probe failures inside the status panel", async () => {
    localAgentMocks.probe.mockRejectedValue(new Error("Probe failed"));

    render(<Harness />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The local CLI capability check failed.");
    expect(alert.closest("section")).toHaveAttribute(
      "aria-labelledby",
      "local-cli-status-heading",
    );
  });

  it("preserves Pi preferences when setup is required and models are unavailable", async () => {
    localAgentMocks.probe.mockResolvedValue(probe("needsSetup", "pi"));
    const onChange = vi.fn();
    const formData: AISettings = {
      ...aiDefaults,
      runtime: "localCli",
      localAgent: {
        provider: "pi",
        preferences: {
          ...aiDefaults.localAgent.preferences,
          pi: {
            model: "anthropic/claude-sonnet-4",
            effort: "high",
          },
        },
      },
    };

    render(
      <LocalAgentSettings
        value={formData.localAgent}
        onChange={onChange}
        supported
      />,
    );

    expect(
      await screen.findByText(
        "Start pi, then run /login to configure a provider.",
      ),
    ).toBeInTheDocument();
    expect(formData.localAgent.preferences.pi).toEqual({
      model: "anthropic/claude-sonnet-4",
      effort: "high",
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies a backend replacement atomically", async () => {
    localAgentMocks.probe.mockResolvedValue(
      probe("ready", "codex", [], {
        kind: "replace",
        preference: { model: "gpt-5.6-sol", effort: "max" },
      }),
    );
    render(
      <Harness
        initialSettings={{
          ...aiDefaults,
          runtime: "localCli",
          localAgent: {
            ...aiDefaults.localAgent,
            preferences: {
              ...aiDefaults.localAgent.preferences,
              codex: { model: "removed-model", effort: "ultra" },
            },
          },
        }}
      />,
    );

    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("local-agent-state").textContent ?? "{}")
          .preferences.codex,
      ).toEqual({ model: "gpt-5.6-sol", effort: "max" }),
    );
  });

  it("keeps an unverified model and hides unknown effort controls", async () => {
    localAgentMocks.probe.mockResolvedValue(
      probe(
        "ready",
        "codex",
        [
          {
            id: "current-model",
            displayName: "Current model",
            isDefault: true,
            efforts: ["medium", "high"],
          },
        ],
        {
          kind: "keep",
          unverified: true,
        },
      ),
    );
    render(
      <Harness
        initialSettings={{
          ...aiDefaults,
          runtime: "localCli",
          localAgent: {
            ...aiDefaults.localAgent,
            preferences: {
              ...aiDefaults.localAgent.preferences,
              codex: { model: "removed-model", effort: "ultra" },
            },
          },
        }}
      />,
    );

    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("local-agent-state").textContent ?? "{}")
          .preferences.codex,
      ).toEqual({ model: "removed-model", effort: "ultra" }),
    );

    expect(
      await screen.findByText("removed-model (Unverified)"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Reasoning effort")).not.toBeInTheDocument();
  });

  it("keeps a gateway model effort unverified when the catalog omits capabilities", async () => {
    localAgentMocks.probe.mockResolvedValue(
      probe(
        "ready",
        "claude",
        [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT 5.6 Sol",
            isDefault: true,
            efforts: [],
          },
        ],
        { kind: "keep", unverified: true },
      ),
    );
    render(
      <Harness
        initialSettings={{
          ...aiDefaults,
          runtime: "localCli",
          localAgent: {
            ...aiDefaults.localAgent,
            provider: "claude",
            preferences: {
              ...aiDefaults.localAgent.preferences,
              claude: { model: "gpt-5.6-sol", effort: "max" },
            },
          },
        }}
      />,
    );

    expect(await screen.findByText("GPT 5.6 Sol")).toBeInTheDocument();
    expect(screen.queryByLabelText("Reasoning effort")).not.toBeInTheDocument();
    expect(
      JSON.parse(screen.getByTestId("local-agent-state").textContent ?? "{}")
        .preferences.claude,
    ).toEqual({ model: "gpt-5.6-sol", effort: "max" });
  });

  it("passes the selected provider's preference to each probe operation", async () => {
    const user = userEvent.setup();
    localAgentMocks.probe.mockResolvedValue(probe("ready"));
    render(
      <Harness
        initialSettings={{
          ...aiDefaults,
          runtime: "localCli",
          localAgent: {
            ...aiDefaults.localAgent,
            preferences: {
              ...aiDefaults.localAgent.preferences,
              codex: { model: "codex-model", effort: "high" },
              claude: { model: "claude-model", effort: "medium" },
            },
          },
        }}
      />,
    );

    await waitFor(() =>
      expect(localAgentMocks.probe).toHaveBeenCalledWith(
        "codex",
        { model: "codex-model", effort: "high" },
        false,
      ),
    );

    await user.click(screen.getByRole("button", { name: "Claude" }));
    await waitFor(() =>
      expect(localAgentMocks.probe).toHaveBeenLastCalledWith(
        "claude",
        { model: "claude-model", effort: "medium" },
        false,
      ),
    );
  });
});
