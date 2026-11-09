<div align="center">

# Open Builder

**Build web apps through conversation.**

[![License](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=white)](https://tauri.app)

[Try online](https://builder.u14.app) · [Downloads](https://github.com/Amery2010/open-builder/releases) · [Documentation](#documentation) · [Changelog](CHANGELOG.md)

English | [简体中文](README.zh-CN.md)

</div>

Open Builder is an open-source workspace for generating, editing, and previewing web apps with AI. Bring your own model provider, work in the browser or desktop app, and export your project when it is ready.

![Open Builder workspace](public/images/screenshot.png)

## Features

- **Code, Plan, and Design** — Build directly, approve a plan first, or create a multi-page product prototype.
- **Live preview** — Edit projects with 20+ framework templates, a code editor, console, and responsive device previews.
- **Visual editing** — Arrange pages on a design canvas, choose from 36 design systems, select elements in 19 preview templates, and annotate screenshots.
- **Project history** — Keep snapshots and branches, reuse project starters, and download source or supported static deployment ZIPs.
- **Your choice of models** — Use OpenAI, Anthropic, Google, or compatible APIs; desktop also supports Codex, Claude, Pi, and Antigravity CLIs.
- **Tools and collaboration** — Connect MCP servers, load Skills, search the web, and delegate scoped work to subagents.

## Quick Start

Use [the Web app](https://builder.u14.app) or run it locally with Node.js 24 and pnpm 11:

```bash
git clone https://github.com/Amery2010/open-builder.git
cd open-builder
pnpm install
pnpm dev
```

Open [localhost:5173](http://localhost:5173), configure your API type, endpoint, model, and credentials in **Settings**, then describe what you want to build.

For desktop development, install [Rust](https://www.rust-lang.org/tools/install) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/), then run:

```bash
pnpm tauri:dev
```

See the [user guide](docs/user-guide.md) for model configuration, Local CLI setup, and project workflows.

## Platforms

| Capability                           | Web | Desktop                     | Mobile (experimental) |
| ------------------------------------ | --- | --------------------------- | --------------------- |
| API models, project editing, preview | Yes | Yes                         | Yes                   |
| Remote HTTPS MCP                     | Yes | Yes                         | Yes                   |
| Local CLI, stdio MCP, Skill scripts  | No  | Yes, subject to permissions | No                    |
| Project export                       | ZIP | ZIP or a new directory      | ZIP                   |

No Open Builder backend is required. History and settings are stored locally; model requests and tool calls use the services you configure, and previews use Sandpack. Web endpoints must allow browser CORS. Local CLI mode still uses the CLI's configured model service.

## Documentation

| Guide                                                  | Contents                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [User guide](docs/user-guide.md)                       | Models, Design canvas, template support, screenshots, history, MCP, Skills, and data storage |
| [Contributing](CONTRIBUTING.md)                        | Development setup, checks, project structure, and pull requests                              |
| [Domain context](CONTEXT.md)                           | Project, preview, Design, and runtime terminology                                            |
| [Local CLI diagnostics](docs/local-cli-diagnostics.md) | Runtime and preview troubleshooting notes (Chinese)                                          |
| [Local CLI streaming](docs/local-cli-streaming.md)     | Streaming, thinking summaries, and reload recovery (Chinese)                                 |
| [Changelog](CHANGELOG.md)                              | Changes by version                                                                           |

## Deployment

Build the Web app and serve `dist/` with a static host:

```bash
pnpm build
```

Or use the container image:

```bash
docker run --rm -p 8080:8080 ghcr.io/amery2010/open-builder:latest
```

Open [localhost:8080](http://localhost:8080). The container serves the Web app; native desktop capabilities require the Tauri app.

For Vercel, Cloudflare, or Netlify, use `pnpm build` and output directory `dist`. Repository automation is defined in the [Pages](.github/workflows/deploy.yml) and [release](.github/workflows/release.yml) workflows.

For portable Skills, the standalone CLI and local MCP setup, see the [headless guide](docs/headless.md).

## Development

The application uses React 19, TypeScript 6, Vite 8, Tailwind CSS 4, Zustand, Sandpack, and Tauri 2.

`pnpm test` runs frontend and Rust tests, so it requires Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Use `pnpm test:frontend` for Web-only changes or `pnpm test:rust` for native tests. These tests do not exercise installer downloads, signing, or notarization; release packaging has separate retries, tool caches, and macOS signing preflight.

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete validation and release workflow. The [user guide](docs/user-guide.md#native-builds) also covers native build commands.

## Contributing

[Bug reports](https://github.com/Amery2010/open-builder/issues), feature proposals, and pull requests are welcome. Read the [contributing guide](CONTRIBUTING.md) before opening a pull request.

## License

[GPLv3](LICENSE) © 2026 Open Builder Contributors
