import { parseArgs } from "node:util";
import { listDesignSystems } from "./assets.js";
import { runMcp } from "./mcp.js";
import { ProjectError, ProjectService } from "./project-service.js";
import { executeOperation, type OperationOutcome } from "./results.js";
import { listTemplates } from "./templates.js";
import { VERSION } from "./version.js";

const HELP = `Open Builder ${VERSION} — native project tools

Usage:
  open-builder templates list [--json]
  open-builder design list [--json]
  open-builder init <dir> --template react-ts|static [--design linear|stripe|notion] [--json]
  open-builder design apply <dir> --id linear|stripe|notion [--json]
  open-builder check <dir> [--json]
  open-builder verify <dir> --task build|typecheck|lint|test [--package-manager npm|pnpm] [--timeout-ms 300000] [--json]
  open-builder mcp --stdio --root <workspace> [--allow-project-scripts]
  open-builder --help | --version

Dependencies are installed by the host. Verification runs trusted local scripts.
Static checks do not establish browser, visual, deployment, or production success.
`;

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export async function runCli(
  argv: string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  const json = argv.includes("--json");
  let isMcp = argv[0] === "mcp";
  let operation = isMcp ? "mcp" : "arguments";
  let outcome: OperationOutcome;
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
          version: { type: "boolean" },
          template: { type: "string" },
          design: { type: "string" },
          id: { type: "string" },
          task: { type: "string" },
          "package-manager": { type: "string" },
          "timeout-ms": { type: "string" },
          root: { type: "string" },
          stdio: { type: "boolean" },
          "allow-project-scripts": { type: "boolean" },
        },
      });
    } catch (error) {
      throw new ProjectError(
        "INVALID_ARGUMENTS",
        error instanceof Error ? error.message : "Invalid arguments.",
      );
    }
    const { values, positionals: args } = parsed;
    if (values.help || argv.length === 0) {
      io.out(
        json
          ? `${JSON.stringify({ operation: "help", ok: true, data: { help: HELP } })}\n`
          : HELP,
      );
      return 0;
    }
    if (values.version) {
      io.out(
        json
          ? `${JSON.stringify({ operation: "version", ok: true, data: { version: VERSION } })}\n`
          : `${VERSION}\n`,
      );
      return 0;
    }
    isMcp = args[0] === "mcp";
    const service = new ProjectService();
    const [command, subcommand] = args;
    let count: number;
    let allowed: string[];
    let action: () => unknown | Promise<unknown>;
    function required(name: "template" | "id" | "task" | "root"): string {
      const value = values[name];
      if (!value)
        throw new ProjectError("INVALID_ARGUMENTS", `--${name} is required.`);
      return value;
    }
    if (command === "templates" && subcommand === "list") {
      operation = "templates.list";
      count = 2;
      allowed = [];
      action = listTemplates;
    } else if (command === "design" && subcommand === "list") {
      operation = "design.list";
      count = 2;
      allowed = [];
      action = listDesignSystems;
    } else if (command === "init") {
      operation = "init";
      count = 2;
      allowed = ["template", "design"];
      action = () =>
        service.initialize(args[1], {
          template: required("template"),
          design: values.design,
        });
    } else if (command === "design" && subcommand === "apply") {
      operation = "design.apply";
      count = 3;
      allowed = ["id"];
      action = () => service.applyDesign(args[2], required("id"));
    } else if (command === "check") {
      operation = "check";
      count = 2;
      allowed = [];
      action = () => service.check(args[1]);
    } else if (command === "verify") {
      operation = "verify";
      count = 2;
      allowed = ["task", "package-manager", "timeout-ms"];
      action = () =>
        service.verify(args[1], {
          task: required("task"),
          packageManager: values["package-manager"],
          timeoutMs:
            values["timeout-ms"] === undefined
              ? undefined
              : Number(values["timeout-ms"]),
          signal,
          onProgress: io.err,
        });
    } else if (command === "mcp") {
      operation = "mcp";
      count = 1;
      allowed = ["root", "stdio", "allow-project-scripts"];
      if (!values.stdio || values.json)
        throw new ProjectError(
          "INVALID_ARGUMENTS",
          "MCP requires --stdio and does not accept --json.",
        );
      action = () =>
        runMcp({
          root: required("root"),
          allowProjectScripts: values["allow-project-scripts"],
          signal,
        });
    } else
      throw new ProjectError(
        "INVALID_ARGUMENTS",
        "Unknown command. Run open-builder --help.",
      );
    if (args.length !== count)
      throw new ProjectError(
        "INVALID_ARGUMENTS",
        "Unexpected or missing positional argument. Run open-builder --help.",
      );
    for (const name of Object.keys(values)) {
      if (name !== "json" && !allowed.includes(name))
        throw new ProjectError(
          "INVALID_ARGUMENTS",
          `--${name} is not supported by this command.`,
        );
    }
    outcome = await executeOperation(operation, action);
  } catch (error) {
    outcome = await executeOperation(operation, () => {
      throw error;
    });
  }
  if (isMcp && outcome.result.ok) return 0;
  const serialized = `${JSON.stringify(outcome.result, null, json ? undefined : 2)}\n`;
  if (isMcp || (!json && outcome.isError)) io.err(serialized);
  else io.out(serialized);
  return outcome.exitCode;
}
