# Changelog

All notable changes to Open Builder are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and versioning adheres to [Semantic Versioning](https://semver.org/).

Tagged versions use their Git tag date. Versions 1.4.0 through 1.7.0 were not tagged in this repository history; their entries are reconstructed from the compare range ending at the commit that first changed `package.json` to that version. These are version milestones, not evidence of published GitHub releases.

---

## [Unreleased]

### Added

- Added a managed Agnes AI MCP adapter for image generation, text-to-video tasks, and manual video-status queries across Web, desktop, and experimental mobile, using a fixed official endpoint, local masked API-key configuration, per-tool approval, and an image-only opt-in subagent grant.
- Agnes image and video calls now render as direct conversation placeholders instead of generic tool cards. Image URLs replace their placeholder immediately; active source conversations poll video tasks on a bounded in-memory schedule and replace the original placeholder without adding messages or notifications.
- Added per-project Code, Plan, and Design workspace modes while retaining the persisted `"auto"` compatibility value. Design mode generates runnable marketing sites and multi-screen product interfaces, returns from approved plans to Design, defaults new visual projects to `vite-react-ts`, and skips Automatic QA in favor of an explicit review flow.
- Added a curated catalog of 12 bundled unofficial visual-reference systems with independent full-frame 640×480 WebP preview images, plus bounded ZIP/browser-directory/local-directory imports, one isolated project-level AI selection including an explicit None result, separate selected/applied state, and card selection that starts explicit `apply_design_system` application for initialized projects.
- Added isolated custom design-system compilation from a name and three rule groups. Successful JSON, CSS, semantic-token, and package validation registers and selects a local custom system with a generic preview without applying it to project files.
- Added preview-only point selection for supported Sandpack templates with stable `data-ob-id` context, a semantic Token panel with live drafts and snapshot-backed canonical saves, and explicit legacy `DESIGN.md` upgrade behavior.
- Added upload-based visual review on Web and desktop, plus desktop unique-directory export, followed by a structured Design Review card and user-selected fix application.
- Added focused Vitest, component, Rust, and authorized Playwright coverage for mode migration, prompts, tool profiles, design-system validation, Bridge isolation, tokens, review gating, responsive previews, and non-overwriting export.

### Changed

- User messages and the generating state now appear immediately after submission, before Design-system selection, attachment hydration, generator setup, or the first provider response completes.
- Skill discovery and loading now use the shared `ScrollText` icon. Multiple `list_skills` and `read_skill` calls in one Agent turn render as one expandable status list without exposing loaded instruction bodies.
- Ask Question now uses compact native radio and checkbox controls, retains option descriptions and recommendations, keeps single-choice auto-advance, and presents custom answers as one-line input rows.
- Replaced the built-in Skill catalog with eight detailed English version-2 manuals: `debug-web-app`, `build-tailwind-ui`, `build-accessible-ui`, `write-safe-typescript`, `art-direct-web`, `design-product-ui`, `review-code`, and `simplify-code`. The Skills Store migrates legacy built-in IDs and preserves their discovery preferences; `react-patterns` has been removed.
- Conversation persistence now stores workspace mode, Plan return mode, AI design-system decisions, and versioned Design state per project while preserving existing conversations as Code through the `"auto"` compatibility value and migrating an active legacy global Plan selection once.
- The composer now uses neutral, blue, and violet mode borders for Code, Plan, and Design; Design uses `PencilRuler`, while its Palette selector exposes the full Auto, AI, None, or manual system name through text, tooltip, and ARIA.
- The design-system dialog now keeps its header and custom-creation action footer visible around a bounded vertical scroll region, applies catalog choices without a redundant footer confirmation, uses responsive preview grids, and switches to custom creation in the same dialog while preserving the catalog selection and scroll position.
- Design-system project contracts share the same `manifest.json + DESIGN.md + tokens.css` format on Web and desktop; Web stores imports in OPFS and desktop stores them in AppData.
- Removed entry, JavaScript chunk, and CSS size budgets. The production artifact check still verifies lazy-loading boundaries and chunk initialization.
- Updated the English and Chinese documentation, tool tables, and platform capability matrix for Design mode.

### Fixed

- Provider `error`, `tool-error`, `abort`, and error finish events from streamed responses now reach the shared retry and error-classification path. Ask Question can therefore resume the same Agent loop after a transient post-answer failure instead of ending on an empty assistant response.

### Security

- Agnes credentials are excluded from history, logs, diagnostics, and storage exports; current-message image IDs are run-scoped, public references require HTTPS, attachment counts and decoded bytes are bounded, response bodies are size-limited, and permission changes abort in-flight work. Plan, Automatic QA, Design Review, and video-capable subagent paths remain fail-closed.
- Design-system imports and custom compilation now enforce safe app-owned IDs and paths, text-only files, strict JSON/schema checks, semantic-token CSS validation, digest verification, strict input and package limits, no symlinks, serialized ID allocation, one bounded repair attempt, and no silent overwrite. Automatic selection accepts only the current candidate pool and runs without tools or project writes.
- The preview Bridge validates iframe source, origin when available, protocol version, per-activation nonce, and an 8 KB payload ceiling; Bridge files never enter canonical project files, snapshots, or exports.
- Design Review exposes exactly four read-only tools, disables MCP, networking, Skills, scripts, and native writes, bounds screenshot input and findings, discards its isolated backend/session after use, and cannot trigger fixes without an explicit user selection.

## [v1.9.0]

### Added

- Added Open Builder 1.0.0 adaptations of the built-in `design-taste-frontend`, `frontend-design`, `code-review`, and `code-simplifier` Skills, including upstream source notes and license copies.
- Added Advanced-settings custom instructions with transactional persistence, a 32,000-character limit, and request-start snapshots for Chat, Plan, retry, approved-plan continuation, API, Local CLI, and subagents; settings storage now migrates to version 19, initializing missing instruction and Exa-key fields without changing an existing search-engine selection.
- Added Exa search and page-content reading through the existing `web_search` and `web_reader` contracts, with bounded output and Jina Reader fallback for failed page reads.

### Changed

- Skills now use progressive model-context loading: auto-discovery exposes metadata only, `read_skill` loads full instructions and resource listings, and toolbar selections inject full mandatory instructions for one request and its subagents before clearing.
- Built-in Skills default to metadata auto-discovery, while imported Skills remain disabled until reviewed and enabled; the existing same-name import conflict policy and Skills Store version are unchanged.
- Firecrawl is now the default search engine for new and reset settings, supports keyless requests without an empty authorization header, and uses bounded single-page scrape requests instead of batch scraping; existing users retain their saved engine.
- Skills and MCP dialogs now share a 576 px desktop width limit, chat-input controls use fixed icon-button sizing and localized tooltips, and the initial chat state keeps only the accessible suggestion group.
- Runtime settings are hidden when API is the only available choice. Custom instructions now use a fixed three-row field without helper copy or a live character count while retaining keyboard focus and over-limit error states.
- Expanded `ask_user_question` with an exploration-first grilling contract: ordinary clarification can batch up to four independent questions, while stress-test or dependent interviews ask one recommended question at a time until the decision boundary is complete.
- Distilled assumption disclosure, simplest-sufficient implementation, surgical changes, anti-speculation, and verifiable success criteria into the base prompt instead of shipping a separate `karpathy-guidelines` Skill.

### Security

- Custom instructions are boundary-escaped as internal system-prompt content, rejected before provider invocation when over limit, cannot expand tool or mode permissions, and are excluded from Automatic QA, smart-title, and context-compression calls.
- Added third-party notices for the adapted Skills and the MIT-licensed grilling method; no standalone `grill-me` Skill is shipped.

## [v1.8.0]

### Added

- Added a lightweight, non-root Nginx Alpine Web image and `v*`-tagged GHCR publishing for `linux/amd64` and `linux/arm64`, gated by frontend checks and container smoke tests.
- Added an explicit desktop-only Local CLI runtime with Codex App Server support, provider-specific resumable sessions, native model/auth probing, and no silent API fallback. The Claude stream-JSON adapter remains fail-closed until the CLI can prove pre-input isolation while retaining the Open Builder MCP bridge and subscription authentication.
- Added a token-authenticated loopback Streamable HTTP MCP bridge so local agents reuse the same project tools, permission policy, virtual files, Plan Mode, Skills, MCP, attachments, Automatic QA, subagents, title generation, and context compression as API generation.
- Added compact Local CLI settings with executable discovery and validated overrides, signed-in/readiness states, provider-reported model and effort choices, login repair actions, desktop capability gating, and English/Chinese disclosures.
- Added MCP server management with JSON import, per-server and per-tool enablement, definition-drift review, remote Streamable HTTP and SSE transports, OAuth authorization-code and client-credentials flows, and desktop stdio support.
- Added a central tool capability and authorization policy shared by schema exposure and execution, immutable per-run permission contexts, and a local redacted permission activity log.
- Added Blob-backed attachment persistence and native PDF file parts for models that support PDF input.
- Added version synchronization, workflow validation, desktop security checks, component tests, and build-budget checks to the release quality gates.
- Added a dedicated tablet workspace for iPad and Android tablets, with the project workspace above chat in a resizable vertical split.
- Added a full-viewport session drawer for compact layouts and a dedicated Advanced settings tab for Automatic QA and permission activity.

### Changed

- Refactored generation behind a shared backend and tool-executor contract while preserving the existing API path; conversation storage now tracks independent Codex and Claude session references guarded by authoritative history and virtual-file fingerprints.
- Hardened local-agent execution with fixed Rust-owned arguments, minimal child environments, isolated CLI configuration, loopback-only transport, per-run tokens and temp directories, process-tree cancellation, payload budgets, and desktop-only command registration.
- Hardened project-file, secret, registry, proxy, redirect, streaming, MCP, and Skill-import boundaries with explicit size, time, origin, approval, and platform limits.
- Improved session and Sandpack persistence, reset/clear lifecycle behavior, device-preview scaling, message virtualization, lazy loading, shared tooltips, focus behavior, and tool-result rendering.
- Settings storage migrated to version 16, adds explicit API/local-CLI runtime preferences, and disables desktop Skill script execution by default during upgrade.
- Pinned the current frontend toolchain to TypeScript 6 and synchronized version 1.7.0 across the package, Rust, Tauri, and in-app version contracts.
- Phone layouts remain chat-first with inline preview, while desktop keeps the horizontal resizable chat-and-workspace split.

## [1.7.0] - 2026-08-25

### Added

- Added a command palette and global keyboard shortcuts, richer diff rendering, and copy/download actions across chat and file surfaces.
- Added `install_component`, `screenshot_to_code`, `apply_design_style`, `rename_file`, `move_file`, `read_env_schema`, and `manage_env` tooling, plus guarded support for root-level `AGENTS.md`, `CLAUDE.md`, and `DESIGN.md` project references.
- Added reusable project templates, searchable/pinnable/archivable/forkable sessions, expanded snapshot history with names, diffs, patch export and replay, Storage Governance, and Automatic QA through `project_health_check`.
- Added a public Skills manifest, on-demand built-in Skill caching, automatic metadata matching, one-request forced Skill context, structured text Skill creation, and nested reference loading through `read_skill`.
- Added frontend CI, desktop security checks, and broad unit coverage for generator, storage, file, network, Skill, and UI behavior.

### Changed

- Refactored the generator, settings, chat input, session list, file explorer, stores, and tool handlers into smaller modules with explicit runtime and persistence boundaries.
- Upgraded the development line to AI SDK 7, TypeScript 7, Vite 8, current compatible Tauri/Rust dependencies, Node.js 24 LTS, and pnpm 11.
- The generator now uses locally configured AI, web-search, and asset-search providers, with provider settings and API keys persisted in browser local storage.
- Settings storage migrated through version 14, removed obsolete server/auth and custom search endpoint fields, and split Search Services, Storage Governance, and System settings into dedicated tabs.
- Built-in Skills now ship from `public/skills`, cache to OPFS on Web and AppData on desktop, and refresh only after being disabled and re-enabled.
- Tightened retry, cancellation, context compression, subagent limits, Skill-import limits, network access, deletion confirmation, and project-file validation.

### Removed

- Removed the Mohua backend API integration, OAuth2/SSO login flow, remote model routing, server-backed search modes, and related settings UI.
- Removed conversation import/export, session filter tabs, the header source-code shortcut, Security Center, Credential Vault workflows, the local Style Assets library, and Skill Script Audit logging during the 1.7 development line.
- Removed Web Skill script execution and the dismissible Skill script warning banner; local scripts became desktop-only.
- Web upgrades now remove references, scripts, and other package resources from existing Skill directories, retaining only each root `SKILL.md`.
- Removed generated Tauri Android and Apple project artifacts from source control; platform projects are generated by Tauri when needed.

## [1.6.0] - 2026-05-25

### Added

- Added read-only subagent collaboration for code exploration, review, dependency advice, bug investigation, and UI critique, with dedicated progress/result cards and up to three parallel dispatches per turn.
- Added the Skills system with built-in and imported Skills, enable/disable and removal controls, message-level Skill selection, reference/script discovery, and the `list_skills`, `read_skill`, and `execute_skill_script` tools.
- Added OPFS persistence for Web Skills and Tauri-backed persistence for desktop Skills.

### Changed

- Refactored the message input into a dedicated toolbar with separate media and Skills controls.

## [1.5.0] - 2026-05-24

### Added

- Added Plan Mode, including project exploration, an approval/rejection card, feedback-driven replanning, and write-tool blocking until approval.
- Added `ask_user_question` with single-select, multi-select, and free-text clarification flows.
- Added an explicit rollback confirmation flow.

### Changed

- Reorganized the generator, AI client, tools, settings, chat input, session list, and file explorer into focused modules while preserving the existing project and conversation data model.

## [1.4.0] - 2026-05-21

### Added

- Added the Mohua unified server API for centrally proxied model, web-search, and asset-search requests.
- Added OAuth2 Public Client + PKCE SSO through `u14.app`, dynamic server provider discovery, authenticated settings mode, and a dedicated authentication callback screen.

### Changed

- Removed local JWT auto-refresh in favor of SSO reauthorization after token expiry.
- Authenticated users used server-provided asset-search configuration instead of local asset-search settings.

---

## [1.3.0] - 2026-03-14

### Added

- Built-in search services support within models
- Client-side API reverse proxy forwarding to resolve CORS issues

### Refactored

- Integrated AI SDK to unify API output and ensure compatibility with mainstream LLM APIs
- Rewrote Tool Call definitions using Zod for better type safety

### Fixed

- Fixed an issue where the thinking process block was unexpectedly split into multiple blocks by tool calls

---

## [1.2.0] - 2026-03-06

### Added

- Project snapshot support: roll back code to any previous version
- Multi-language and appearance theme switching
- Global memory support, allowing AI to remember user development habits
- Context compression to reduce token usage in long conversations
- Slash commands (`/compact`, `/review`, etc.) in the input box
- File attachment upload as context input
- Auto session naming based on conversation content
- Drag to resize chat and editor panels
- Image search tool supporting Pixabay and Unsplash
- NPM search tool for package discovery
- Global memory tool call for persistent AI context
- Automatic retry mechanism for failed requests
- Tauri framework integration for cross-platform desktop app builds
- System reset control for clearing local project and application data
- Automated desktop release workflows for version tags

### Refactored

- Optimized AI request retry logic for improved stability
- Enhanced file explorer with download and copy path menus
- Optimized system colors for light and dark themes
- Improved message list rendering
- Refactored session list into a sidebar with context menu
- Rewrote system command descriptions for better project build requirement expression
- Web search service now supports Tavily and Firecrawl
- Settings page model and logic improvements
- Slash commands now appear in correct context
- Text output effects optimization
- Markdown rendering improvements for better user experience

### Documentation

- Added English documentation
- Updated project documentation

### Misc

- Introduced GFM (GitHub Flavored Markdown) support for improved todolist rendering
- Optimized scrollbar styles throughout the project

---

## [1.1.1] - 2026-02-27

### Added

- Added `get_console_logs` so the AI could inspect Sandpack errors and warnings before completing a task, with console details surfaced in tool cards.

### Fixed

- Fixed transient request-error handling and missing streaming Tool Call IDs.
- Fixed generator lifecycle state that prevented a conversation from continuing after a task completed, a page refresh, a session switch, or generator reconstruction.

---

## [1.1.0] - 2026-02-27

### Added

- Added File Explorer context menus with inline create, rename, and delete actions, plus drag-and-drop file and folder moves.

---

## [1.0.0] - 2026-02-26

### Added

- Full AI Tool Call loop engine (`WebAppGenerator`) supporting up to 30 tool call rounds
- 8 built-in file system tools: `init_project`, `manage_dependencies`, `list_files`, `read_files`, `write_file`, `patch_file`, `delete_file`, `search_in_files`
- Browser-based live code preview via Sandpack, supporting 20+ project templates
- Multi-session management: create, switch, delete conversations; history persisted via localforage
- Image input support (multimodal) for uploading screenshots or design mockups
- Streaming output for real-time AI generation display
- Extended Thinking / Reasoning support (DeepSeek-R1, Claude 3.7, etc.)
- Web search integration (Tavily API) with `web_search` and `web_reader` tools
- Jina Reader as automatic fallback for web content reading
- Tool call visualization cards (`ToolCallCard`) showing status and results
- One-click project download as ZIP
- Mobile responsive layout with embedded preview
- Settings dialog: API Key, API URL, model name, Tavily configuration
- All settings stored in browser localStorage, never uploaded to servers

### Tech Stack

- React 19 + TypeScript 5
- Vite 7 + Tailwind CSS v4
- shadcn/ui + Radix UI
- Zustand 5 state management

## [0.1.0] - 2026-02-24

### Added

- Project initialization based on Vite + React TypeScript template
- Basic `WebAppGenerator` class implementing OpenAI Tool Call loop
- `ChatInterface` chat UI component
- `CodeViewer` code viewer (editor + Sandpack preview)
- `SettingsDialog` settings dialog
- OpenAI-compatible API support (OpenAI, DeepSeek, etc.)
- Basic file operation tools: `write_file`, `read_files`, `list_files`, `delete_file`

[Unreleased]: https://github.com/Amery2010/open-builder/compare/f3aae1f...HEAD
[1.7.0]: https://github.com/Amery2010/open-builder/compare/086c92a...f3aae1f
[1.6.0]: https://github.com/Amery2010/open-builder/compare/7c44060...086c92a
[1.5.0]: https://github.com/Amery2010/open-builder/compare/c0990ae...7c44060
[1.4.0]: https://github.com/Amery2010/open-builder/compare/v1.3.0...c0990ae
[1.3.0]: https://github.com/Amery2010/open-builder/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Amery2010/open-builder/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/Amery2010/open-builder/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Amery2010/open-builder/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Amery2010/open-builder/compare/4319310...v1.0.0
[0.1.0]: https://github.com/Amery2010/open-builder/tree/4319310
