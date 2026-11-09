# Headless acceptance record

Implementation scope: portable workflow Skill, native project CLI, local stdio MCP. CLI artifact version: 0.1.0. Node 24.x is the supported runtime. Runtime acceptance records below must identify actual evidence; an unexecuted matrix entry remains pending.

## Repeatable scenarios

1. **New application:** invoke the installed Skill, create a static or React application, implement a working counter or task list, execute applicable checks, and report absent visual evidence.
2. **Existing application:** preserve USER_NOTES.md and an unrelated changed file, modify a requested interaction, correct an intentional JavaScript/package-script failure, and verify the original symptom with an appropriate command.
3. **MCP:** discover the configured server's tools, initialize and edit a project using host editing tools, call its check and enabled build tools, and retain the structured results. The server must be the installed tarball.
4. **Lifecycle:** cancel a script that creates a descendant process, close the MCP input while verification runs, and confirm the managed POSIX process group or Windows Job Object exits. Also cover an exited parent whose descendant retains stdio. POSIX descendants that detach into another session or process group require host-managed cleanup; verification scripts must not leave such background processes.

## Local evidence — 2026-11-08

The implementation and local-install artifacts are delivered. The full three-platform, two-host acceptance matrix is **not complete**. Unexecuted or blocked cases below are not passes.

| Area                              | Environment / artifact                                       | Result                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing Web behavior             | macOS 15.7.7 arm64, Node 24.21.0                             | 266 frontend suites / 2,140 tests passed, including mixed static/design/runtime issue ordering, counts and truncation, Skill loading, and design prompts.                                                                                                                                            |
| Shared core and Node package      | macOS, Node 24.21.0, pnpm 10.30.3                            | 47 tests passed; one Windows-only Job Object case skipped. Includes cancellation, timeout, inherited pipes, MCP request cancellation and client disconnect.                                                                                                                                          |
| Standalone installed artifact     | macOS, CLI 0.1.0 tarball installed outside repository        | Native React initialization, host edits, explicit test-host dependency installation, real typecheck/build, user-file preservation, and installed MCP discovery/init/check/build/parity passed.                                                                                                       |
| Linux runtime                     | Alpine Linux arm64 container, Node 24.18.0, pnpm 11.0.0      | Frozen workspace install, Web production build/artifact check, Node type checks, Node tests, Skill packaging, and installed-artifact smoke passed. This is Linux container evidence, not a native Windows/macOS substitute.                                                                          |
| Portable Skill                    | Generated workflow 0.1.0 ZIP                                 | Metadata validation, eight generated references, source-version/digest manifest and local reference validation passed. Codex discovered and used the project-level installation.                                                                                                                     |
| Real Codex, host tools only       | Codex CLI 0.163.0, macOS, installed `.agents/skills` content | Created a static counter and repaired an existing application's intentional syntax error; both `node --check` commands passed. Pre-existing notes and unrelated CSS were preserved. No browser or preview was used.                                                                                  |
| Real Codex, Skill + installed MCP | Codex CLI 0.163.0, macOS, CLI 0.1.0 tarball                  | Initialized a styled React application, edited source through host tools, called actual check/build tools, observed an existing project's build failure and repaired it, then built both applications successfully. Notes and unrelated CSS were preserved.                                          |
| Real Claude Code                  | Claude Code 2.1.260, macOS                                   | The project Skill was discovered and the installed MCP server connected. First host-only attempt timed out. Isolated retries returned HTTP 401: OAuth access token revoked. Model-driven Skill and MCP acceptance did not complete. Protocol-client tests do not replace this missing host evidence. |
| Windows                           | Three-platform GitHub Actions matrix added                   | Not run in this workspace. PowerShell Job Object supervision and the Windows-specific lifecycle test require an actual Windows runtime/CI result. Static review is not runtime proof.                                                                                                                |
| Existing native checks            | macOS, unchanged Rust modules                                | 346 Rust tests passed, six pre-existing manual/model tests ignored.                                                                                                                                                                                                                                  |

`pnpm typecheck`, `pnpm headless:typecheck`, `pnpm lint`, `pnpm workflow:check`, `pnpm version:check`, `pnpm build` and `pnpm build:check` passed. All changed files pass formatting checks. Full `pnpm format:check` remains nonzero because the untouched `e2e/preview-screenshot.spec.ts` already fails Prettier in `HEAD`; this task does not reformat that unrelated file.

The initial noninteractive Codex MCP attempt correctly denied script verification under its host approval policy. The successful retry used a session-only per-tool approval for `builder_verify_project` in the trusted disposable fixture, in addition to the server's `--allow-project-scripts` flag. No user global host configuration was changed. See the official [Codex MCP configuration](https://developers.openai.com/codex/mcp) for host approval settings.

Machine-readable local records live in the ignored `artifacts/headless/` directory: `smoke-darwin.json`, `smoke-linux.json`, `codex-host-only.json`, `codex-mcp.json` and `claude-mcp.json`. The smoke command regenerates its current-platform record. Host JSONL logs retain actual tool invocations and results. The Linux container, temporary Docker image, test workspaces, and task-owned processes are removed after verification.

The three-platform workflow is included but has not been submitted to remote CI. Re-run Windows CI and authenticated Claude Code acceptance before marking the full matrix complete. No browser, deployment, production, public npm release, git commit, or push is claimed.

## Review correction verification — 2026-11-08

Follow-up checks on macOS arm64 with Node 24.21.0 passed: 67 headless tests (one Windows-only case skipped), 110 focused Web regression tests, both project type checks, lint, changed-file formatting, and the workflow checks. The new regressions cover execution deadlines during cleanup, cancellation after task exit, cleanup failures, non-loading HTML references, CRLF Skill metadata and source hashes, and actual Git checkout conversion with `core.autocrlf=true`. Both packaging scripts pass in that checkout fixture.

The rebuilt CLI tarball was installed outside the repository; real React typecheck/build, source checks, user-file preservation, and installed MCP discovery/init/check/build/parity passed again. Skill packaging also passed. Execution timing now stops at process exit; POSIX cleanup is explicitly limited to the managed process group, with detached descendants requiring host cleanup. Temporary repositories, installed fixtures, and task-owned processes were cleaned up. This follow-up did not run native Windows/Linux, Rust, authenticated model hosts, browser or deployment verification; CRLF simulation is not Windows runtime evidence.

## 中文验收说明

代码与本地安装产物已交付；完整的“三平台、双宿主”验收尚未全部完成。

- macOS 与 Linux 容器的独立安装、真实 React 类型检查/构建、CLI/MCP 协议和进程清理已通过。
- Codex 0.163.0 已完成仅宿主工具的 Skill 案例，以及安装包 MCP 的初始化、修改、检查、失败后修复和构建闭环。
- Claude Code 2.1.260 当前返回 OAuth 令牌撤销的 401 错误，模型驱动验收待重新登录后执行。
- Windows 已实现进程树监管并纳入 CI，当前没有 Windows 实测结果；三平台远程 CI 尚未运行。
- 全量前端测试通过 2,140 项，Node 测试通过 47 项（Windows 专用一项跳过），Rust 通过 346 项（既有六项人工测试忽略）。
- 全仓格式检查存在一处已核实的基线问题：未修改的 `e2e/preview-screenshot.spec.ts`。本次修改文件的格式检查通过。
- 未进行视觉验证；未公开发布、提交或推送代码。
