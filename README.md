<div align="center">

# Open Builder

**AI-Powered Web App Generator — Describe in natural language, instantly generate runnable projects**

[![License](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.x-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=white)](https://tauri.app)

[Deployment](#deployment) · [Quick Start](#quick-start) · [Features](#features) · [Architecture](#architecture) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

English | [简体中文](README.zh-CN.md)

</div>

---

## Introduction

Open Builder is a desktop-first AI web app generator with a browser-compatible interface. Simply describe the application you want to build in natural language, and the AI will create, modify, and delete files in an in-memory file system through a Tool Call loop, with live preview powered by [Sandpack](https://sandpack.codesandbox.io/).

Open Builder does not require a hosted application backend. The Web app connects directly to the providers and approved remote tools you configure; provider settings, including API keys, are stored in browser local storage and are sent only when required by those configured services.

The Tauri desktop build (macOS / Windows / Linux) provides local runtime capabilities such as stdio MCP. Web and experimental mobile builds intentionally omit local process and Skill script execution.

> Native adapters are included for OpenAI Responses, Anthropic, and Google, plus OpenAI-compatible endpoints such as Ollama and other compatible gateways.

---

## Demo

![screenshot](public/images/screenshot.jpg)

[Live Demo](https://builder.u14.app)

---

## Features

### Version 2.0 at a Glance

Since 1.9.0, Open Builder adds Design workspaces and multi-page prototypes, isolated desktop CLI runtimes, reusable project starters, conversation branches, and version-specific project ZIP downloads. See the [2.0.0 changelog](CHANGELOG.md#v200) for the full list.

### Core

- **Natural Language to Code** — Describe your idea, AI plans and generates the complete project structure
- **Live Preview** — Browser-based sandbox powered by Sandpack, instant rendering on code changes
- **Multi-Framework Support** — 20+ templates including React, Vue, Svelte, Angular, SolidJS, and Astro, with Open Builder-managed dependency profiles and verified Sandpack/Nodebox runtime locks
- **Smart File Operations** — AI uses `patch_file` for precise modifications, avoiding unnecessary full rewrites
- **Dependency Management** — AI can modify `package.json` and trigger dependency reinstallation
- **Build Accelerators** — Install shadcn components, translate screenshots into components, apply design specifications, and manage typed environment schemas through dedicated tools
- **Project Guidance** — Root-level `AGENTS.md`, `CLAUDE.md`, and `DESIGN.md` files can guide generation while remaining untrusted project data that cannot override tool or safety policy
- **Project Snapshots & Branches** — Browse and name snapshots, inspect diffs, export patches or version-specific ZIPs, and return to historical versions; continuing from a checkout creates a branch while preserving the original conversation and project
- **Project Health Check** — Run `/health` to inspect structure, dependencies, runtime logs, accessibility, and responsive risks; isolated Automatic QA performs a restricted project check without MCP or preview-console access
- **Context Compression** — Use `/compact` or the command palette to summarize long conversations and reduce token usage
- **Plan Mode** — Explore the code and submit an implementation plan for approval before writing files; `ask_user_question` supports both independent clarification batches and one-question-at-a-time stress-test interviews
- **Design Mode** — Generate runnable marketing sites and complete multi-page product prototypes with real navigation, shared mock data, page and scenario controls, curated or custom design systems, and explicit design self-checks
- **Subagent Collaboration** — Built-in read-only subagents for code exploration, review, dependency advice, bug investigation, and UI critique, with streamed output, public thinking summaries, nested tool activity, retries, and completion status
- **Built-in Search** — Supports enabling the model's built-in search service
- **Desktop API Proxy** — Tauri can forward approved HTTP/HTTPS provider requests that would otherwise be blocked by browser CORS; static Web deployments still depend on provider CORS support
- **Desktop Local CLI Runtime** — Explicitly run the complete generation workflow through an isolated, signed-in Codex, Claude, Pi, or Antigravity CLI while keeping API mode as the default; Codex can generate or edit images, Antigravity can generate images without reference-image editing, and unsupported providers do not receive the media tool
- **Managed Project Images** — Keep images imported with a project and generated images explicitly added to it in content-addressed local storage while preserving each project path for source imports, CSS URLs, public URLs, preview, ZIP export, snapshots, and Starter copies; removed owners retain deduplicated Blob bytes conservatively until **Clear All Data** so another tab cannot lose an in-flight image

### User Experience

- **Multi-Session Management** — Sidebar with create, switch, delete sessions; history persisted locally
- **Session Organization** — Search, pin, archive, fork, and smart-rename conversations
- **Project Starter Library** — Search, edit, update, and reuse safely prepared local project copies with deterministic stack metadata and managed project images; sensitive paths are excluded and high-confidence plaintext credentials are redacted before an explicit save confirmation
- **Project Permissions** — Review file deletion, moves, and full project replacement before execution; allow once or grant eligible operations for the current session, and inspect permission activity
- **Smart Session Naming** — Auto-generates session titles based on conversation content
- **Slash Commands** — Input box supports `/new`, `/fork`, `/clear`, `/reset`, `/compact`, `/health`, `/review`, `/continue`, and `/retry`
- **Command Palette & Shortcuts** — Open commands with `Cmd/Ctrl+K`, create sessions, open settings, focus input, or stop generation from the keyboard
- **Image & File Input** — Upload screenshots, text files, or PDFs; new local images are compressed once at the configurable default quality of `0.85`, and PDF-capable models receive PDFs as native file input without local text extraction
- **Skills System** — Enabled Skills expose metadata for automatic discovery; full instructions load only after `read_skill` or when a Skill is selected for the next message, which also applies to subagents and clears after sending. Skill loads in one Agent turn appear as one expandable list. The eight built-ins are `debug-web-app`, `build-tailwind-ui`, `build-accessible-ui`, `write-safe-typescript`, `art-direct-web`, `design-product-ui`, `review-code`, and `simplify-code`; legacy built-in IDs migrate automatically, while imported Skills start with discovery disabled
- **Custom Instructions** — Advanced settings can safely append up to 32,000 characters to Chat, Plan, retry, and subagent requests without granting tools or changing mode restrictions; utility calls such as Automatic QA, titles, and compression exclude them
- **Local Settings** — Provider configuration, API keys, and custom instructions persist in browser local storage
- **Storage Governance** — Inspect local data usage, including project ZIP archives, imported Design systems, and retained project-image Blobs, and safely clean archived sessions, empty sessions, old snapshots, or every local storage domain
- **Streaming Output** — Display generated text, tool activity, and readable thinking summaries as the provider emits them; thinking availability depends on the runtime, provider, and model
- **Extended Thinking** — Supports Extended Thinking / Reasoning mode (DeepSeek-R1, Claude 4.6, etc.)
- **Project Downloads** — Export the current project as ZIP, or download a snapshot's matching source and managed images from its message or snapshot history; failed archive preparation can be retried
- **Workspace Tools** — Switch between code and preview, browse files with Material Icon Theme artwork, search and manage files, inspect the Sandpack console, and preview desktop/tablet/phone widths with zoom controls
- **Interactive Design Editing** — Point-select stable `data-ob-id` elements in supported Sandpack previews, pass a sanitized selection to the next request, and tune canonical semantic tokens with snapshot-backed saves
- **Design Review & Desktop Export** — Upload up to three screenshots for an opt-in read-only review on Web or desktop, or export canonical project files from desktop to a new non-overwriting directory
- **Adaptive Layout** — Desktop uses a horizontal resizable split, tablets use a vertical resizable workspace-over-chat split, and phones use a chat-first layout with inline preview
- **Languages & Themes** — English and Simplified Chinese interfaces with system, light, and dark themes

### Commands and Shortcuts

| Command     | Behavior                                                  |
| ----------- | --------------------------------------------------------- |
| `/new`      | Start a new session                                       |
| `/fork`     | Fork the current session and project                      |
| `/clear`    | Clear chat context while keeping current project files    |
| `/reset`    | Reset the current conversation and project after approval |
| `/compact`  | Compress the current conversation context                 |
| `/health`   | Run the project health check                              |
| `/review`   | Ask the AI to review the current project                  |
| `/continue` | Continue an interrupted or incomplete task                |
| `/retry`    | Retry the latest generation                               |

| Shortcut     | Action                                             |
| ------------ | -------------------------------------------------- |
| `Cmd/Ctrl+K` | Toggle the command palette                         |
| `Cmd/Ctrl+N` | Start a new session                                |
| `Cmd/Ctrl+,` | Open settings                                      |
| `Cmd/Ctrl+/` | Focus the chat input                               |
| `Esc`        | Close the palette first, otherwise stop generation |

### Project History and Downloads

Checking out a snapshot restores its project files and available assets, along with conversation context and Design state when those records were saved. Legacy snapshots or snapshots whose message links are missing may have incomplete context or Design history. Sending a new request or editing the checked-out project starts a new branch. Use branch history beside the relevant message to return to a saved continuation; `/fork` still creates a separate session.

New snapshots queue version-specific ZIP preparation, while older versions are packaged on demand. Download the corresponding source from message actions or snapshot history without switching the current project. Local archive storage requires OPFS and Web Locks; an unavailable storage API or packaging failure is reported and can be retried. Storage Governance includes archive usage and cleanup alongside snapshots and other local data.

### Design Mode

Design mode keeps its output in the current conversation's normal project file tree and Sandpack preview; it does not create a separate artifact store. The Code label retains the existing internal `"auto"` value for compatibility. The mode and its automatic decision, selected system, and applied system are remembered per project. Entering Plan from Design returns to Design after approval.

- New visual projects default to `vite-react-ts`; a new complete product prototype uses the dedicated `vite-react-ts-prototype` starter with React Router `HashRouter`, shared resettable mock data, and a static-export-friendly runtime. Existing and imported projects keep the current Design workflow.
- Complete prototypes store their validated product outline in the root `design-project.json`. This file owns stable page, layout, shared UI, flow, scenario, and build-progress IDs; `DESIGN.md` and `tokens.css` continue to own the visual contract.
- The preview workspace adds a collapsible page tree plus page and scenario selectors. Page navigation preserves shared mock-data edits, while changing a scenario or using **Reset data** restores the prototype's initial data.
- Design generation binds each batch to the current blueprint revision and selected page/shared-file scope. Completed pages and flows are checkpointed in the blueprint so `/continue` can resume without rebuilding recorded work.
- The built-in catalog contains 12 curated, unofficial visual references with separate full-frame 640×480 WebP previews: Linear, Stripe, Claude, GitHub, IBM, Figma, Notion, Shopify, Apple, Spotify, The Verge, and WeChat. Choosing a different system for an initialized project immediately starts its AI application workflow; an empty project keeps the choice as the reference for its next Design request.
- When the selector remains **Auto**, one isolated no-tool model decision runs before the next Design generation. It can choose a bundled, imported, or custom system, or explicitly choose **None**. A validated result remains with that project until it is manually replaced or re-evaluated; an invalid result is retried on the next request.
- Custom systems require a name plus three visible rule groups. The current API or Local CLI model compiles them without project files or tools; strict JSON, CSS, semantic-token, and complete-package validation must pass before the system is saved and selected. Custom and imported systems share the generic full-frame WebP preview.
- Imported systems use the minimal `manifest.json + DESIGN.md + tokens.css` contract. ZIP and directory imports are previewed before confirmation, validated as bounded text-only packages, and never silently overwrite an existing ID.
- Point selection is available for `static`, `vite`, `vite-react`, and `vite-react-ts`. Unsupported or code-only projects can still use Design prompts and file tools, but the UI explains why selection or live token preview is unavailable.
- Legacy root-only `DESIGN.md` files remain read-only visual references until the user explicitly upgrades them to a token-bearing system.

| Capability                              | Web                                                | Desktop                                                              |
| --------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| Generation, live preview, point editing | Full core flow                                     | Full core flow                                                       |
| Design-system import                    | ZIP or browser directory picker                    | ZIP or local directory                                               |
| Project export                          | ZIP                                                | ZIP or a new, uniquely named directory; no two-way sync              |
| Model runtime                           | API or remote endpoint that permits browser CORS   | API, Tauri proxy, or supported local CLI runtime                     |
| Visual review                           | Uploaded screenshots or captured prototype targets | Uploaded screenshots or captured prototype targets                   |
| Local processes / stdio / Skill scripts | Unavailable in a static Web deployment             | Subject to the existing desktop capability and approval restrictions |

Design Review is deliberately separate from Automatic QA. Its restricted run can only list, read, and search project files and submit up to eight structured findings; it cannot write files, use MCP or network tools, load Skills, or run scripts. Complete-prototype reviews bind evidence to the project generation, blueprint revision, page, scenario, and viewport. They capture declared targets serially in a temporary preview iframe, mark uncaptured targets as unreviewed, and mark prior evidence stale after the project changes. A manual review never starts a fix until the user selects findings and clicks **Apply selected fixes**. After an eligible Design generation, the automatic review may run one bounded repair for deterministic issues, P0/P1 visual findings, and non-P3 system-consistency findings, followed by one verification pass. It repairs only while the evidence and conversation remain current; deferred, failed, unavailable, or superseded work is reported explicitly and is never presented as a clean review.

### MCP and Platform Capabilities (Optional)

- Configure remote HTTPS MCP servers with Streamable HTTP or SSE, static headers, OAuth authorization code, or OAuth client credentials; desktop builds also support stdio servers.
- Import server definitions from JSON, enable servers and tools independently, and review tool-definition drift before changed capabilities can run.
- Plan Mode and subagents receive only MCP tools explicitly approved as read-only for those modes.
- The managed **Agnes AI** entry uses its fixed official endpoint on Web, desktop, and experimental mobile. Add a local API key and approve `generate_image`, `create_video`, or `get_video_status` independently; Web requests remain subject to browser CORS.
- Agnes image generation supports text, one current-message image, or up to five combined current-message/public HTTPS references. Text-to-video results update one in-conversation placeholder while its source conversation is active; generated media stays at its remote HTTPS URL and is not written into project files. Automatic polling is session-only and does not resume after an app restart; `get_video_status` remains available for a manual refresh.
- Agnes tools are available in Chat and Design, not Plan, Automatic QA, or Design Review. Only `generate_image` can be separately enabled for subagents; video creation and status polling remain unavailable to them.

| Runtime             | Remote HTTPS MCP | stdio MCP | Skill scripts                        |
| ------------------- | ---------------- | --------- | ------------------------------------ |
| Web                 | Yes              | No        | No                                   |
| Desktop             | Yes              | Yes       | Developer switch + per-call approval |
| Experimental mobile | Yes              | No        | No                                   |

### Web Search

- [Firecrawl](https://www.firecrawl.dev) is the default for new or reset settings and supports keyless search and page reading under IP-based limits; an optional API key raises those limits
- [Tavily](https://tavily.com) and [Exa](https://exa.ai) are available with provider credentials; supported model providers can also use built-in search
- Web content reading automatically falls back to [Jina Reader](https://jina.ai/reader/) when a configured reader cannot return a page

---

## Quick Start

### Prerequisites

- Node.js 24 LTS
- pnpm 11
- A supported provider endpoint and an API key when that provider requires one

### Installation

```bash
# Clone the repository
git clone https://github.com/Amery2010/open-builder.git
cd open-builder

# Install dependencies
pnpm install

# Start the development server
pnpm dev
```

Open `http://localhost:5173` in your browser, click the settings icon in the top-right corner to configure your API Key.

### Desktop / Mobile App (Tauri)

Requires [Rust](https://www.rust-lang.org/tools/install) and Tauri [platform dependencies](https://tauri.app/start/prerequisites/).

```bash
# Desktop development
pnpm tauri:dev

# Desktop build
pnpm tauri:build

# iOS development / build
pnpm tauri ios init # first setup only
pnpm tauri:ios:dev
pnpm tauri:ios:build

# Android development / build
pnpm tauri android init # first setup only
pnpm tauri:android:dev
pnpm tauri:android:build
```

### Local CLI Runtime (Desktop)

The desktop app can use installed Codex, Claude, Pi, and Antigravity CLIs as complete agent runtimes. API mode remains the default. Open Builder automatically discovers each installed CLI version via `--version`, without a hardcoded version range or prerelease restriction. Every provider must pass its required executable, structured-protocol, selection, and isolation checks before receiving user content. Authentication is reported separately: a CLI-auth status can be verified during inspection, while custom gateway credentials or model routes that can be confirmed only by inference stay sendable and are marked **Ready. The first message verifies login and may use quota.** Model selection is capability-driven: a complete catalog can reject an explicitly unsupported choice, while a partial or stale catalog retains the current choice as unverified and warns instead of silently replacing it. Open Builder never silently falls back between runtimes or providers.

Install and configure one supported CLI:

- **Codex:** install the official Codex CLI, then run `codex login`. Open Builder prefers the app-server delta protocol; only a verified capability limitation and successful isolation checks permit the [`codex exec --json`](https://learn.chatgpt.com/docs/developer-commands?surface=cli) compatibility path before a task starts. The app-server path uses a private configuration with effective-isolation checks; the exec path uses `--ignore-user-config` and `--ignore-rules`. Both import only the selected, validated machine-level [`model_provider`](https://developers.openai.com/codex/config-advanced/) definition and its referenced environment credentials. Reasoning effort is checked against the selected model's reported capabilities, so values such as `max` and `ultra` work when the CLI advertises them; custom-provider capabilities that cannot be verified remain explicitly unverified. Custom providers must also declare a top-level `model`; `env_http_headers` entries remain optional and are applied only when their referenced environment variable exists. Project rules, hooks, plugins, unrelated MCP servers, static provider secrets, and credential-helper commands remain excluded. See the official [latest-model guidance](https://developers.openai.com/api/docs/guides/latest-model).
- **Claude:** install the official Claude Code CLI and complete its account sign-in flow (or run `claude auth status` to inspect it). Open Builder requires the documented [`stream-json` and isolation flags](https://code.claude.com/docs/en/cli-usage) and runs in restricted mode with no user/project setting sources, a private system-prompt file, strict MCP configuration, and only the Open Builder tool bridge. Claude's safe mode is intentionally not used because it disables the explicit per-run MCP bridge along with other customizations. A validated Claude gateway configuration may supply its endpoint, explicit credential, and model-routing environment without loading the rest of user settings. Open Builder automatically performs a bounded, read-only `GET /v1/models` against that configured gateway, accepts the documented [Anthropic model-list shape](https://platform.claude.com/docs/en/api/beta/models/list) and compatible gateway shapes, and shows every valid ID in gateway order, including GPT and Gemini models; this does not require Claude Code's optional [gateway discovery](https://code.claude.com/docs/en/llm-gateway-connect) switch. Local aliases remain separate from exact gateway IDs.
- **Pi with Node.js 22.19 or newer:** Install with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`. Pi also publishes the official installer `curl -fsSL https://pi.dev/install.sh | sh`. Open Builder detects the installed version and checks its required RPC and isolation capabilities. Start `pi`, then run `/login` inside Pi to configure a model provider. See the [Pi quickstart](https://pi.dev/docs/latest/quickstart).
- **Pi standalone on Windows:** download the official `pi-windows-x64.zip` or `pi-windows-arm64.zip` asset and `SHA256SUMS` from a [Pi release](https://github.com/earendil-works/pi/releases/latest), extract it, then select `pi.exe` with **Choose program** if it is not on `PATH`.
- **Antigravity:** install the modern Google Antigravity CLI and complete its account sign-in flow. Open Builder accepts `agy` only when it advertises the official [streaming headless protocol](https://antigravity.google/docs/cli/headless/) flags `--input-format stream-json`, `--output-format stream-json`, and `--agent`; use `agy models` to inspect available models. The official [`modelProvider: "gemini"`](https://antigravity.google/docs/cli/install/#using-a-gemini-api-key) mode is supported with `GEMINI_API_KEY` and an optional validated `GOOGLE_GEMINI_BASE_URL`. Compatibility is determined by the detected structured headless capabilities. Plain-text fallback is intentionally unavailable.

Start the desktop app, open **Settings → Model → Runtime → Local CLI**, select the CLI provider, and confirm that its status is either **Installed and ready** or **Ready. The first message verifies login and may use quota.** The latter means the first real message—not the settings scan—will verify the configured credentials or gateway and may consume quota. Open Builder scans `PATH` and common installation locations; **Choose program** stores only a validated executable override in native app data. Model and reasoning choices are provider-specific and come from the selected CLI. Ordinary checks use a short-lived cached catalog; **Rescan** forces a fresh read. If a catalog is partial or stale, the currently saved model and effort remain selectable as **Unverified**, unknown effort choices are hidden, and the UI warns rather than clearing the preference. Switching among Codex, Claude, Pi, and Antigravity never reuses another provider's session; an installation, launch configuration, model, effort, or protocol change starts a fresh provider-scoped session.

Local CLI output and any public thinking summaries enter chat as they arrive, while the existing typewriter animation controls display speed. Codex prefers the app-server delta protocol with a verified pre-run compatibility fallback; thinking text still depends on the CLI, model, and provider. See [streaming and thinking behavior](docs/local-cli-streaming.md).

If the page reloads while the desktop process remains running, Open Builder checks for the original CLI task and reconnects without resending the prompt. Confirmed tool results are replayed without repeating execution. If a tool started but its side effects cannot be confirmed, recovery stops and asks you to check the project or external operation before continuing. Stop or switching sessions or branches cancels the run; exiting or crashing the desktop process ends this recovery window. Native recovery changes require restarting or rebuilding the desktop app, not just refreshing its page.

In Local CLI Chat runs, Codex receives `generate_image` with optional opaque reference-image IDs, while Antigravity receives text-to-image generation only. Claude and Pi do not receive that tool. A generated result stays in the conversation until the agent calls `import_generated_image` for an initialized project; the Host then creates a managed project-image module at the requested safe path. These media tools remain unavailable in Plan and other restricted profiles.

The local CLI is not an offline model. Prompts, attachments, search activity, and tool results are normally sent to the model provider configured in that CLI and may consume subscription or API quota. For Codex, Claude, and Antigravity, Open Builder reads only the documented provider fields required by the selected configuration and passes referenced credentials directly to that CLI child process; it never persists, displays, logs, or places those credential values in command arguments or temporary configuration. Antigravity account login remains in the operating system's secure credential store; Open Builder does not guess or copy Gemini credential files. It persists only Agy's native conversation/cache state in a hashed app-private home per Open Builder conversation, while utility runs use disposable homes. Pi owns OAuth and API-key data in `~/.pi/agent/auth.json`, created with owner-only permissions; Open Builder strips provider API-key environment variables from the Pi child and relies on that OAuth/auth file. Inline, environment-resolved, and command-resolved credentials from `models.json` are rejected before user content is sent; the credential-source probe does not resolve or execute those values. Save the provider credential through Pi's `/login` flow instead. Ordinary Pi sessions default to cwd-organized JSONL under `~/.pi/agent/sessions/`, but Open Builder supplies an app-private session directory instead and retains only the provider-scoped opaque session ID with its local conversation. See the official [provider](https://pi.dev/docs/latest/providers) and [session](https://pi.dev/docs/latest/sessions) references.

Projects remain in Open Builder's in-memory virtual file system. Each provider uses a stable app-private blank scratch directory and can interact with the project only through the per-run authenticated loopback tool bridge. Attachment IDs are opaque; host file paths are not exposed. User-level Skills, Agents, MCP servers, rules, project instruction files, hooks, extensions, native shell/filesystem tools, browser execution, and native writes are rejected or disabled before user content is sent. Antigravity additionally receives a private per-run agent, MCP configuration, and permission policy; only Open Builder MCP tools are allowed (plus read-only URL access when model-built-in search is explicitly selected).

Trust boundaries, per process:

- **Every CLI child** starts from an empty environment plus a fixed allowlist (`PATH`, `HOME`, temp, locale, proxy, certificate, XDG and Windows profile variables, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`), with loopback added to `NO_PROXY`. Credential variables are added only when the validated provider configuration references them.
- **Codex** receives the referenced `env_key`/`env_http_headers` variables and the per-run bridge token in its environment; the token is excluded from Codex's shell environment policy. If a required variable is missing from the app process, the scan reports **Installed, setup required** and names the variable.
- **Claude** reads the bridge token from its environment through the `${OPEN_BUILDER_MCP_TOKEN}` reference in its private MCP configuration; the token is never written to disk.
- **Pi** receives the bridge token in an owner-only per-run configuration file for the private extension; provider API-key variables are stripped and login stays in `~/.pi/agent/auth.json`.
- **Antigravity** reads the bridge bearer token from an owner-only per-run `mcp_config.json` inside the run directory, which is deleted with the run. Its private HOME projects the macOS keychain directory and passes the Linux session-bus variables so `agy` can read its own login; this equals the exposure of any process the same user runs.
- **Stdio MCP servers** receive the same allowlist plus only the `env` values from their own configuration, never the app's full environment.
- **The tool bridge** listens on loopback only with a random port and a per-run bearer token, and rejects requests whose `Host` header is not `127.0.0.1` or `localhost`.

Headless local CLIs do not open their own permission dialog. Open Builder projects the exact run-scoped tool list into each Provider only so calls can reach the existing Host authorization flow; that projection never grants project access by itself. A Provider-side approval or permission rejection ends the run immediately and appears in chat with the Provider, failure phase, safe recovery guidance, and a copyable diagnostic ID. Provider stderr and credentials are never shown in the chat error.

Pi tool results can carry text and images. Text-backed resources and image resources are converted without loss; PDF, audio, and other binary resource results that Pi cannot consume are rejected with an explicit tool error instead of being silently reduced to a filename or summary. Convert those attachments to text or images before asking Pi to inspect them.

When Web Search is **Model Built-in**, compatible local CLIs use their native search only after the selected adapter verifies the corresponding capability. Pi has no native web-search tool, so Open Builder blocks the turn and asks you to choose Tavily, Firecrawl, Exa, or Disabled; it never silently changes the search engine. Those explicit search providers use Open Builder's brokered tools and keep CLI-native or extension-provided search disabled. If detection reports not installed, setup required, unsupported, or an isolation error, use **Rescan**, **Choose program**, **Use auto-detection**, or copy the displayed setup command. Web and mobile builds show a blocking message and require switching back to API.

DeepSeek Harness support is intentionally deferred and will use ACP only. At this documentation snapshot, the installable [npm `latest`](https://www.npmjs.com/package/@deepseek-ai/dsh) is `0.1.1-rc.2` and its Open Builder-relevant CLI surface is only the one-shot headless runner; ACP remains alpha/source-only in the pinned [official ACP adapter source](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/acp/acp/README.md). DeepSeek Harness will not enter the provider catalog or settings UI until an official npm release with no alpha, beta, or RC prerelease suffix includes `dsh --profile acp`; source-only profiles, headless output, and the separate SDK protocol do not meet the integration threshold.

### Configuration

Click the settings button in the top-right corner and fill in:

| Option              | Description                                   | Example                               |
| ------------------- | --------------------------------------------- | ------------------------------------- |
| API Type            | Provider protocol adapter                     | OpenAI, Anthropic, Google, compatible |
| API Key             | Provider credential, when required            | `sk-...`                              |
| API Base URL        | Provider origin or base path                  | `https://api.openai.com`              |
| Model Name          | Model ID; supported providers can list models | `gpt-5.6-sol`, `deepseek-chat`        |
| Web Search          | Keyless Firecrawl, or provider credentials    | `fc-...`, `tvly-...`, or an Exa key   |
| Image Search        | Optional Pixabay or Unsplash credential       | Provider API key                      |
| Custom Instructions | Reusable instructions under Advanced settings | Up to 32,000 characters               |
| Image Compression   | Compress new local images once before storage | Enabled; quality `0.85`               |

> Settings and API keys are stored in browser local storage. Custom instructions are sent to the selected model provider for Chat, Plan, retry, and subagent work. They cannot expand tool permissions; do not place credentials or other secrets in them. Treat the browser profile and device as part of your credential security boundary.

MCP servers and Skills are managed from the chat toolbar. A Skills management switch controls metadata auto-discovery only. Selecting a Skill in the toolbar loads its full instructions for the next request and then clears the selection. Desktop-only options are shown only when the native runtime reports the required capability.

The managed Agnes API key is masked in the MCP panel, stored only in local app data, removed by the panel reset action, and redacted from exports and diagnostic output. The configuration check validates local completeness without contacting Agnes.

---

## Architecture

### Core Engine: WebAppGenerator

[src/lib/ai/generator.ts](src/lib/ai/generator.ts) is the project's core, implementing the full AI Tool Call loop engine:

```
                         ┌─ API Backend → AI SDK
User Message → Generator┤
                         └─ Local CLI Backend → Tauri Agent Manager
                                                  ↓
                                      Loopback MCP Tool Bridge
                                                  ↓
                                   Shared Tool Executor and Policy
                                                  ↓
                                      In-Memory File System
                                                  ↓
                                       Sandpack Live Preview
```

Built-in tools:

| Tool                             | Description                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `init_project`                   | Initialize Sandpack project template                                                                    |
| `manage_dependencies`            | Modify package.json to manage dependencies                                                              |
| `list_files`                     | List all project files                                                                                  |
| `read_files`                     | Batch read file contents                                                                                |
| `write_file`                     | Create or overwrite a file                                                                              |
| `patch_file`                     | Precise search-and-replace patch                                                                        |
| `delete_file`                    | Delete a file                                                                                           |
| `rename_file` / `move_file`      | Rename or move files while updating relative imports                                                    |
| `search_in_files`                | Global file content search                                                                              |
| `get_console_logs`               | Read Sandpack preview console output                                                                    |
| `compact_context`                | Compress long conversation context                                                                      |
| `ask_user_question`              | Ask 1-4 independent clarifications, or run a dependent stress-test interview one question at a time     |
| `exit_plan_mode`                 | Submit a plan and wait for user approval                                                                |
| `dispatch_subagent`              | Dispatch read-only subagents for exploration, review, or diagnosis                                      |
| `project_health_check`           | Inspect project structure, package files, env schema, console logs, accessibility, and responsive risks |
| `web_search`                     | Web search (supports Built-in, Tavily, Firecrawl, Exa)                                                  |
| `web_reader`                     | Read web page content                                                                                   |
| `image_search`                   | Image search (supports Pixabay, Unsplash)                                                               |
| `search_npm_packages`            | NPM package search                                                                                      |
| `get_npm_package_detail`         | Get detailed information about NPM package                                                              |
| `install_component`              | Install an approved shadcn registry component and its dependencies                                      |
| `screenshot_to_code`             | Generate and write a component from a supplied UI image                                                 |
| `apply_design_style`             | Add a selected design specification to the project                                                      |
| `apply_design_system`            | Apply the explicitly selected Design-mode system contract to an initialized project                     |
| `submit_design_review`           | Submit the bounded structured result from the read-only Design Review profile                           |
| `list_skills` / `read_skill`     | Discover enabled Skill metadata, then load full instructions and resource listings                      |
| `execute_skill_script`           | Run an active skill script in the desktop app only                                                      |
| `read_env_schema` / `manage_env` | Safely inspect and manage env files                                                                     |

Enabled MCP tools are injected dynamically after server discovery and approval, then filtered by the current platform and Chat, Plan, Design, Automatic QA, Design Review, or subagent run policy. `apply_design_style` remains the Auto-mode compatibility path; Design mode uses `apply_design_system`.

The managed Agnes MCP adapter adds `generate_image`, `create_video`, and `get_video_status` without creating a remote MCP transport session. Its image and video results render directly in the conversation as media placeholders and replace those placeholders in place when a remote URL becomes available.

Supported Local CLI Chat runs add provider-native `generate_image`. Initialized projects also expose `import_generated_image`, which admits a generated result through the managed project-image boundary instead of treating native CLI scratch files as project files.

### Tech Stack

| Category       | Technology                        |
| -------------- | --------------------------------- |
| Framework      | React 19 + TypeScript 6           |
| Build Tool     | Vite 8                            |
| Styling        | Tailwind CSS v4                   |
| UI Components  | shadcn/ui + Radix UI              |
| Code Sandbox   | Sandpack (CodeSandbox)            |
| State Mgmt     | Zustand 5                         |
| Local Storage  | localforage                       |
| Icons          | Lucide React                      |
| Markdown       | react-markdown + rehype-highlight |
| Desktop/Mobile | Tauri 2                           |

---

## Supported API Protocols

Open Builder selects a native AI SDK adapter from the configured API Type and can query supported provider endpoints for their model list.

| API Type          | Protocol/adapter           | Default base URL                            | Typical use                    |
| ----------------- | -------------------------- | ------------------------------------------- | ------------------------------ |
| OpenAI Compatible | OpenAI-compatible chat API | `http://localhost:11434`                    | Ollama and compatible gateways |
| OpenAI            | Responses API              | `https://api.openai.com`                    | OpenAI                         |
| Anthropic         | Messages API               | `https://api.anthropic.com`                 | Anthropic                      |
| Google            | Generative Language API    | `https://generativelanguage.googleapis.com` | Google Gemini                  |

> For best results, use a model with strong Function Calling support.

---

## Deployment

Static Web deployments do not include the Tauri API proxy, stdio MCP, or Skill script execution. Model and search endpoints used directly from a browser must allow the deployment origin through CORS.

### Build for Production

```bash
pnpm build
# Output to dist/ directory
```

### Docker / GitHub Container Registry

The lightweight container image serves the Web build with an unprivileged Nginx Alpine runtime:

```bash
docker run --rm -p 8080:8080 ghcr.io/amery2010/open-builder:latest
```

Open `http://localhost:8080`. The image supports `linux/amd64` and `linux/arm64`. It intentionally contains no provider credentials, API proxy, stdio MCP, Local CLI, or Skill script runtime; browser-facing provider and search endpoints must allow the deployed origin through CORS.

Pushing a semantic version tag such as `v2.0.0` runs the frontend quality gates and a container smoke test before publishing `2.0.0`, `2.0`, `2`, and `latest` tags to `ghcr.io/amery2010/open-builder`. Pre-release tags publish only their full pre-release version. GitHub initializes a new container package as private, so a repository owner must change its visibility to public once after the first successful publish.

See [.github/workflows/release.yml](.github/workflows/release.yml).

### GitHub Pages

GitHub Actions builds and deploys Pages when `main` is updated (or when the workflow is started manually). The workflow sets Vite's base path to the repository subpath, including the static MCP OAuth callback entry. A `v*` tag creates a draft desktop release and publishes the container image after their respective quality gates pass; it does not deploy Pages.

See [.github/workflows/deploy.yml](.github/workflows/deploy.yml).

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAmery2010%2Fopen-builder)

Or manually: import the GitHub repo, select `Vite` as framework preset, build command `pnpm run build`, output directory `dist`.

### Cloudflare Workers

[![Deploy to Cloudflare Worker](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Amery2010/open-builder)

Or manually:

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → Create → Worker → Connect to Git
2. Select the `open-builder` repo with the following build config:

| Option        | Value            |
| ------------- | ---------------- |
| Build Command | `pnpm run build` |
| Output Dir    | `dist`           |
| Node.js Ver   | `24`             |

### Netlify

Import the repo, build command `pnpm run build`, output directory `dist`. No additional configuration needed.

---

## Contributing

Issues and Pull Requests are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) first.

---

## License

[GPLv3 License](LICENSE) © 2026 Open Builder Contributors
