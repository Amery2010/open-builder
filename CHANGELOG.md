# Changelog

All notable changes to Open Builder are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and versioning adheres to [Semantic Versioning](https://semver.org/).

---

## [1.2.0] - 2026-03-05

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

[1.2.0]: https://github.com/Amery2010/open-builder/compare/v1.0.0...v1.2.0
[1.0.0]: https://github.com/Amery2010/open-builder/compare/v0.3.0...v1.0.0
[0.1.0]: https://github.com/Amery2010/open-builder/releases/tag/v0.1.0
