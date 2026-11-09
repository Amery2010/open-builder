# Open Builder CLI

Native frontend project tools and a local stdio MCP server. Node.js 24.x is required. Source code, model reasoning, dependency installation, and browser verification remain with your coding agent or terminal.

Build a local installable package from the Open Builder repository:

```bash
pnpm install
pnpm headless:pack
npm install -g ./artifacts/headless/open-builder-cli-0.1.0.tgz
open-builder --help
```

```bash
open-builder templates list --json
open-builder design list --json
open-builder init ./demo --template react-ts --design notion
# Install dependencies yourself in ./demo, using npm or pnpm.
open-builder check ./demo --json
open-builder verify ./demo --task build --json
```

Templates: `react-ts` (native React/TypeScript/Vite), `static` (HTML/CSS/JavaScript). Visual references: `linear`, `stripe`, `notion`; these are unofficial and do not include brand assets. New directories only; design application adds DESIGN.md and tokens.css without overwriting existing targets. Existing projects need their host to wire tokens.css into the active style entry.

Verification accepts `build`, `typecheck`, `lint`, and `test` only, each as an existing package script. npm and pnpm are supported; `--package-manager` selects one explicitly and conflicting metadata/lockfiles are rejected. `--timeout-ms` defaults to 300000. Execution timing stops when the verification process exits; cleanup has a separate deadline. Project scripts are trusted local code, not sandboxed by this tool.

Cancellation and timeout clean up the verification process group on POSIX and the verification Job Object on Windows. POSIX descendants that create a new session or process group (for example, detached processes) fall outside this cleanup boundary and require host-managed cleanup. Verification scripts must terminate without leaving detached background processes.

Verification uses the installed package manager; it does not download the version pinned in `packageManager`. Configure any required version before running the command.

Static checks report their scan omissions and checks not run. They do not prove compilation, browser behavior, accessibility conformance, visual quality, deployment, or production correctness. Source scanning skips secrets, binary files, symlinks, dependencies and common generated directories. JSON diagnostics are redacted; source files are not rewritten.

## MCP

```bash
open-builder mcp --stdio --root /absolute/workspace
open-builder mcp --stdio --root /absolute/workspace --allow-project-scripts
```

The workspace root is fixed at startup and tool project paths are relative. Verification is omitted by default. The explicit startup flag exposes it; tool arguments cannot enable it. stdout is reserved for MCP messages. Configure host tool timeouts above 300 seconds when using the default verification timeout.

Tools: `builder_list_templates`, `builder_list_design_systems`, `builder_init_project`, `builder_apply_design_system`, `builder_check_project`, and optionally `builder_verify_project`. No model, HTTP transport, general shell, installation, or deployment capability is included.

Exit codes: 0 passed; 1 findings/task failure; 2 invalid, unsupported or missing configuration; 124 timeout; 130 cancellation. Use `--json` for one-shot commands; MCP returns the same structured business results.

This package is GPL-3.0-only. Local tarball installation is supported; an npm registry release is a separate action. Detailed bilingual installation, Skills, host configuration, acceptance scenarios, and evidence are in the repository's headless documentation.
