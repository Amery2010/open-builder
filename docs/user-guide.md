# User Guide

[Back to README](../README.md) · [简体中文](user-guide.zh-CN.md)

## Models and configuration

Open **Settings** to select an API type, base URL, model, and credential. Open Builder provides these adapters:

| API type          | Protocol                | Default base URL                            |
| ----------------- | ----------------------- | ------------------------------------------- |
| OpenAI Compatible | Compatible chat API     | `http://localhost:11434`                    |
| OpenAI            | Responses API           | `https://api.openai.com`                    |
| Anthropic         | Messages API            | `https://api.anthropic.com`                 |
| Google            | Generative Language API | `https://generativelanguage.googleapis.com` |

Choose a model that supports tool calls; screenshot workflows also require image input. Model and reasoning choices depend on the selected provider's capabilities.

API settings and keys are stored in browser local storage. Advanced settings accept up to 32,000 characters of custom instructions for generation requests, including Plan and subagents. These instructions cannot grant tools or override mode restrictions; keep credentials out of them.

### Local CLI on desktop

1. Install and sign in to Codex, Claude, Pi, or Antigravity using that provider's setup flow.
2. Open **Settings → Model → Runtime → Local CLI** and select the provider. Use **Choose program** if it is not detected automatically.
3. Check the reported status and select a model. **Rescan** refreshes detection and the model catalog.

Open Builder checks the executable, structured protocol, and isolation capabilities before starting a run. A ready status that says the first message verifies login means the credentials or gateway still require a real inference request, which may consume quota. Partial catalogs keep saved choices marked **Unverified**; providers are never silently substituted.

The CLI uses Open Builder's project tools through a scoped loopback bridge. Projects remain in the app's virtual file system, and CLI-native shell/filesystem access is not exposed to the model. CLI mode is not offline: prompts, attachments, and tool results may be sent to its configured model service.

Provider-specific behavior:

- **Codex** supports native image generation and reference-image editing in eligible Chat runs.
- **Antigravity (`agy`)** requires its structured headless protocol and supports native text-to-image generation, without reference-image editing.
- **Claude** and **Pi** do not receive the native image-generation tool.
- **Pi** uses credentials saved through its `/login` flow in `~/.pi/agent/auth.json`. Provider API-key environment variables are stripped; inline, environment-resolved, and command-resolved credentials in `models.json` are rejected. Choose an explicit search provider because Pi has no native web-search tool.

Generated images stay in the conversation until explicitly imported into an initialized project. Provider sessions are separate; incompatible installation, configuration, model, or protocol changes start a fresh session.

A page reload can reconnect to a CLI run while the same desktop process is still running. Confirmed tool results are replayed without re-execution; uncertain side effects stop recovery. Exiting or crashing the desktop process ends this recovery window. See [streaming and recovery](local-cli-streaming.md) and [diagnostics](local-cli-diagnostics.md) for implementation and troubleshooting notes in Chinese.

## Project workflows

**Code** works directly on project files. **Plan** explores the project and requests approval before writing. **Design** prepares visual context and generates runnable interfaces or product prototypes. The mode is remembered per project; approving a plan entered from Design returns to Design.

Import a ZIP or project folder into a new conversation, or save a reusable copy in the Project Starter Library. Imports check file and resource integrity locally, exclude sensitive paths, redact credentials, and show file statistics and the preview mode. Once these checks pass, you can import while keeping your current project and chat history. Supported projects start Sandpack after import and show compilation status separately. Compilation errors and network timeouts leave imported files available for editing; you can retry the preview. Frameworks and versions that the current Sandpack runtime cannot preview open in code mode, with the reason available in the details. Starters preview excluded sensitive paths and redacted credentials before saving; they do not copy chat history or runtime sessions.

Source downloads preserve project files and managed resources. Static deployment ZIPs are available for plain static sites and supported Vite 4 frontend projects. Compatibility builds target modern browsers, disable minification and CSS splitting, and do not run custom build scripts or type checks. They do not produce SSR/Node deployments. Configure the deployment base path and SPA routing for your host.

### Design canvas

Single-page projects open directly in Preview/Code while retaining Design mode and its tools. Projects with two or more blueprint pages use the canvas, including unfinished pages in the count.

- Select a page board to set the editing context; open the Code tab to inspect its source.
- Double-click a board or press Enter to open its interactive preview. Returning to the canvas preserves the running page's state.
- Drag boards with alignment snapping, pan the canvas, and switch desktop, tablet, or phone viewport sizes.
- Board positions and the viewing position are saved locally per conversation branch. They do not change source files, snapshots, or exports.

Canvas images are temporary full-page previews, not review evidence. New complete product prototypes use the `vite-react-ts-prototype` starter with hash-based routing and shared resettable mock data.

The root `design-project.json` is the project blueprint for pages, routes, shared UI, flows, and committed progress. It can start incomplete; dynamic routes need concrete preview paths. Schema v1/v2 files remain readable and migrate to v3 on edit, retaining historical checkpoints and safe default preview locations. Product goals and audience are maintained through normal Design requests. `/continue` rebuilds context from the current files.

### Design systems and tokens

Choose from 36 bundled visual references, import a package, or create a custom system from a name and three rule groups. **Auto** lets an isolated model decision choose a system or **None**. Selecting a system for an existing project starts its application workflow; an empty project uses it for the next Design request.

Imports use `manifest.json`, `DESIGN.md`, and `tokens.css`. Packages are validated before saving and never silently overwrite an existing ID. A standalone legacy `DESIGN.md` remains a visual reference until explicitly upgraded. Token edits can be previewed before saving; a save updates canonical files and creates a snapshot.

### Element selection

In the interactive preview, click **Select an element in the preview**, then select the element to describe in your next message. Stable `data-ob-id` attributes improve identification but are not required: unmarked elements use bounded runtime locators and nearby anchors.

Selection supports these 19 built-in templates:

| Family                  | Templates                                             |
| ----------------------- | ----------------------------------------------------- |
| Static                  | `static`                                              |
| Vite                    | `vite`                                                |
| Vite React              | `vite-react`, `vite-react-ts`                         |
| Vite Preact             | `vite-preact`, `vite-preact-ts`                       |
| Vite Vue                | `vite-vue`, `vite-vue-ts`                             |
| Vite Svelte             | `vite-svelte`, `vite-svelte-ts`                       |
| React                   | `react`, `react-ts`                                   |
| Vue                     | `vue`, `vue-ts`                                       |
| Other browser templates | `svelte`, `solid`, `angular`, `vanilla`, `vanilla-ts` |

Static/Vite projects need a root `index.html` with a body element. Other templates use an executable `package.json.main`, including implicit template defaults. Custom Angular CLI entry configurations, unresolved entries, `nextjs`, `astro`, `node`, `test-ts`, and code-only projects remain unavailable for selection. The UI explains the reason. Bridge code stays out of saved project files and exports.

## Screenshots and review

The **Camera icon** in the preview toolbar exports the **Current viewport**, **Full page**, or **Selected area** as a PNG at its original CSS pixel dimensions. Selected area freezes the current viewport for drag selection; reselect or press Escape to cancel. Capture preserves input and scroll state. Desktop opens a save dialog, while the browser downloads the file.

**Annotate preview** captures the current viewport or full rendered page. Add shapes, arrows, text, or freehand marks, then choose **Attach image** to add the flattened image to the composer without sending it. Drawings remain temporary; cancelling or switching conversation, branch, or checkout discards them.

The `capture_preview_sequence` tool samples the mounted preview at 1–5 increasing offsets between 0 and 30,000 ms. It preserves interaction state without refreshing or navigating, reports actual timing and partial failures, and stores summaries rather than image bytes in history.

Full-page capture covers the currently rendered DOM; it does not expand inner scroll containers, virtual lists, or infinite content. Video, WebGL, cross-origin frames, and external resources have capture limitations. Review evidence collected by tools may be uniformly scaled to fit transmission limits; exported PNGs retain their original CSS pixel dimensions.

Design Review accepts uploaded screenshots or captures declared prototype pages and viewports. Reviews read project files and return findings; they cannot edit files or use external tools. Automatic Design Review also reports results without changing code. Select findings and choose **Apply selected fixes** to start a normal Design task. Missing captures stay unreviewed, source changes make evidence stale, and old scenario-based reports require a new page-level review. Sampled DOM diagnostics are not a complete accessibility audit.

**Auto QA** in system settings is off by default and controls both automatic coding QA and automatic Design Review. Turning it off cancels unfinished automatic design reviews while retaining manual reviews and completed reports. Turning it back on only affects subsequent generation.

## History and storage

Snapshots retain project files and available managed assets, plus recorded conversation context and Design state. Continuing from a checkout creates a branch while preserving the original continuation. `/fork` creates a separate conversation. Older snapshots can have incomplete context or Design history.

Download matching source ZIPs from messages or snapshot history without switching projects. New snapshots queue archive preparation; older archives are built on demand. Archive storage requires OPFS and Web Locks. Packaging failures can be retried.

Storage Governance reports usage and offers cleanup for sessions, snapshots, archives, design systems, canvas preferences, and managed images. Image bytes may remain after their last visible owner is removed to avoid cross-tab races; **Clear All Data** clears retained storage. Desktop directory export creates a new directory and does not provide two-way filesystem synchronization.

## MCP, Skills, search, and media

Manage MCP and Skills from the chat toolbar. Remote HTTPS MCP supports Streamable HTTP or SSE, static headers, and OAuth. Desktop adds stdio servers. Enable servers and tools separately; changed tool definitions require review. Plan and subagents only receive the tools allowed by their mode and permissions.

Enabled Skills expose metadata for discovery. Full instructions load through `read_skill` or an explicit selection for the next message; that selection also applies to subagents and clears after sending. Imported Skills start with discovery disabled. Skill scripts require desktop capability, the developer switch, and per-call approval.

Firecrawl is the default search service; Tavily, Exa, and supported provider-native search are optional. Failed page reads can fall back to Jina Reader. Image search supports Pixabay and Unsplash. Configure credentials where required.

The managed **Agnes AI** integration provides image generation and text-to-video with a local API key and per-tool approval. Results appear in the conversation as remote media; they are not automatically written into project files. Video polling runs only while its source conversation is active and does not resume after app restart; a manual status query remains available. Only image generation can be separately enabled for subagents.

Images, text files, and PDFs can be attached to messages. New local images are compressed once by default at quality `0.85`; PDF handling depends on model support. Pi rejects unsupported binary tool results explicitly rather than silently replacing them with text summaries.

## Commands and shortcuts

| Command                | Action                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| `/new` / `/fork`       | Create a conversation / copy the current conversation and project      |
| `/clear` / `/reset`    | Clear chat context / reset the conversation and project after approval |
| `/compact`             | Compress conversation context                                          |
| `/health` / `/review`  | Check project health / request a project review                        |
| `/continue` / `/retry` | Continue unfinished work / retry the latest generation                 |

| Shortcut     | Action                                             |
| ------------ | -------------------------------------------------- |
| `Cmd/Ctrl+K` | Command palette                                    |
| `Cmd/Ctrl+N` | New conversation                                   |
| `Cmd/Ctrl+,` | Settings                                           |
| `Cmd/Ctrl+/` | Focus the composer                                 |
| `Esc`        | Close the palette first, otherwise stop generation |

## Native builds

Install Rust and the [Tauri platform prerequisites](https://tauri.app/start/prerequisites/) first. Mobile builds are experimental and omit Local CLI, stdio MCP, and Skill script execution.

```bash
pnpm tauri:build

# Run init once for each mobile target.
pnpm tauri ios init
pnpm tauri:ios:dev
pnpm tauri:ios:build

pnpm tauri android init
pnpm tauri:android:dev
pnpm tauri:android:build
```

For architecture and contribution workflows, see [CONTEXT.md](../CONTEXT.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).

## Headless tools

Portable Skills, native project commands and the local stdio MCP are documented in the [headless guide](headless.md). They use real project directories and their own native templates.
