# Skills, CLI and local MCP

[简体中文](headless.zh-CN.md)

Open Builder's headless tools use the target project's real directory. Your coding agent owns planning, code editing, dependency installation, and optional browser verification. The CLI and MCP share the same project implementation; they do not run a model themselves.

## Build and install

Use Node.js 24.x and the repository's pnpm version:

```bash
pnpm install
pnpm skills:pack
pnpm headless:pack
npm install -g ./artifacts/headless/open-builder-cli-0.1.0.tgz
open-builder --help
```

The local tarball includes its runtime, license and three design resources. No npm publication is required. To launch without a global installation, install the tarball in a separate directory and run `node node_modules/@open-builder/cli/dist/main.js` there.

The supported native templates are `react-ts` and `static`. They are independent of the application's Sandpack templates. A static project without a package script reports build verification as not applicable. CLI initialization requires a new directory whose parent already exists.

```bash
open-builder init ./demo --template react-ts --design notion
# In ./demo, install dependencies with npm or pnpm using your host.
open-builder check ./demo --json
open-builder verify ./demo --task typecheck --json
open-builder verify ./demo --task build --json
```

`linear`, `stripe` and `notion` are unofficial visual references, not brand assets. `design apply ./existing --id linear` creates only DESIGN.md and tokens.css. If either target exists, nothing is overwritten. Ask the host to connect tokens.css to an existing application's actual style entry. Initialization wires it automatically in known templates.

## Install the Skill

Unzip `artifacts/skills/open-builder-workflow-0.1.0.zip`. Copy its `open-builder-workflow` directory into the target project's `.agents/skills/` for Codex or `.claude/skills/` for Claude Code. The same content supports both hosts. Start a new host session and explicitly invoke `$open-builder-workflow` in Codex or `/open-builder-workflow` in Claude Code.

The Skill works with host tools alone, a discovered CLI, or discovered MCP tools. Its references are generated from the eight maintained application Skills; `sources.json` records versions and source hashes. Edit the source Skills and repack instead of editing generated references. Packaging validates metadata and relative links.

## Configure local MCP

Use an installed artifact, not a source checkout. A cross-platform launch uses `node` and the absolute path to the installed `dist/main.js`.

Codex project configuration (`.codex/config.toml`, in a trusted project):

```toml
[mcp_servers.open_builder]
command = "node"
args = ["/absolute/install/node_modules/@open-builder/cli/dist/main.js", "mcp", "--stdio", "--root", "/absolute/workspace"]
tool_timeout_sec = 360
```

Claude Code project configuration (`.mcp.json`):

```json
{
  "mcpServers": {
    "open_builder": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/install/node_modules/@open-builder/cli/dist/main.js",
        "mcp",
        "--stdio",
        "--root",
        "/absolute/workspace"
      ]
    }
  }
}
```

Replace the example paths. On Windows, use native absolute paths and escape backslashes in JSON/TOML strings, or use forward slashes. Add `--allow-project-scripts` to the server args to expose `builder_verify_project`. No tool argument can enable it. Configure the host's tool timeout above the execution timeout (300 seconds by default). Installation does not edit global host settings.

Exposing verification does not grant host approval. The host may still prompt or deny the call. For unattended use, the operator must configure the host's policy for the trusted project; see [Codex MCP settings](https://developers.openai.com/codex/mcp) and [Claude Code MCP permissions](https://code.claude.com/docs/en/mcp). The server does not change that policy.

The default tools list templates and design systems, create projects, add design files and check projects. All project paths are relative to the fixed workspace. The optional verification tool runs only existing build/typecheck/lint/test scripts. It does not install dependencies. Shell access, deployment, remote HTTP and model orchestration are outside this package.

## Evidence and task behavior

`packageManager` selects npm or pnpm; verification uses the installed executable and does not download a pinned package-manager version. The host must install/configure any version the project requires before calling verification.

Static health checks are heuristics. Reports name scan omissions and checks not run; Token validity and static wiring are separate from browser loading or visual conformance. Environment secret values are not inspected. Verification runs trusted local project scripts with `CI=1`; scripts are not sandboxed by these tools. npm/pnpm metadata and lockfile conflicts are rejected, workspace-root scheduling is unsupported, and the caller selects a concrete application directory.

Execution timing stops when the verification process exits; cleanup has a separate deadline. Cancellation and timeout clean up the verification process group on POSIX and the verification Job Object on Windows. POSIX descendants that create a new session or process group (for example, detached processes) fall outside this cleanup boundary and require host-managed cleanup. Verification scripts must terminate without leaving detached background processes.

One-shot commands accept `--json`; stdout is then a single result and diagnostics use stderr. MCP reserves stdout for protocol messages and returns the same structured business data. Exit codes are 0 success, 1 findings/task failure, 2 invalid/unsupported configuration, 124 timeout, and 130 cancellation. A failed check is normal tool data; invalid parameters, permissions and operational errors are tool errors.

## Development and acceptance

```bash
pnpm headless:build
pnpm headless:typecheck
pnpm headless:test
pnpm headless:smoke
pnpm skills:pack
```

The smoke test installs the tarball outside the repository, creates and modifies a React app, installs its dependencies explicitly, runs real type/build checks, preserves a user file, and calls the installed MCP server. Evidence is written to `artifacts/headless/smoke-<platform>.json`. The three-platform workflow runs the Node, lifecycle, CLI/MCP, and installed-artifact scenarios. A local macOS run is not Linux or Windows proof.

Real host acceptance is separate: each host must discover the installed Skill, create a new application, modify an existing one while preserving USER_NOTES.md, use real MCP tools when configured, repair an intentional script failure, and report which checks ran. Without browser evidence it must state that visual verification was not performed. Record host version, OS, artifact version and outcome; a simulated client does not establish model-driven host behavior. Current execution evidence is in [the acceptance record](headless-acceptance.md).
