# Contributing Guide

Thank you for your interest in Open Builder! We welcome all forms of contribution, including bug reports, feature suggestions, documentation improvements, and code submissions.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Commit Convention](#commit-convention)
- [Pull Request Process](#pull-request-process)
- [Code Style](#code-style)
- [Versioning and Release Notes](#versioning-and-release-notes)

---

## Code of Conduct

By participating in this project, you agree to abide by the following guidelines:

- Respect all participants and maintain friendly, constructive communication
- Accept constructive criticism and focus on what's best for the project
- Do not post any discriminatory, harassing, or inappropriate content

---

## How to Contribute

### Reporting Bugs

1. Search [Issues](https://github.com/Amery2010/open-builder/issues) first to ensure the bug hasn't been reported
2. Create a new Issue using the **Bug Report** template
3. Provide the following information:
   - Operating system and browser version
   - Steps to reproduce (the more detail, the better)
   - Expected behavior vs. actual behavior
   - Relevant screenshots or error logs

### Suggesting Features

1. Search Issues first to ensure the suggestion hasn't been made
2. Create a new Issue using the **Feature Request** template
3. Clearly describe the use case and expected outcome

### Contributing Code

1. Fork this repository
2. Create your feature branch from `main`
3. Complete development and ensure tests pass
4. Submit a Pull Request

---

## Development Setup

### Prerequisites

- Node.js 24 LTS (recommend using [nvm](https://github.com/nvm-sh/nvm) for version management)
- pnpm 11
- Git

The combined `pnpm test` command also requires Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Web-only contributors can run `pnpm test:frontend` without the native toolchain. The signing preflight tests in `pnpm workflow:check` require OpenSSL.

### Local Development

```bash
# 1. Fork and clone the repository
git clone https://github.com/your-username/open-builder.git
cd open-builder

# 2. Install dependencies
pnpm install

# 3. Start the development server
pnpm dev
```

Visit `http://localhost:5173` and enter your API Key in settings to start debugging.

### Available Commands

```bash
pnpm dev               # Start the Vite dev server
pnpm build             # Build for production
pnpm build:check       # Verify production artifact integrity
pnpm preview           # Preview the production build
pnpm typecheck         # TypeScript type checking
pnpm lint              # ESLint with zero warnings
pnpm format:check      # Prettier verification, including documentation
pnpm version:check     # Package/Cargo/Tauri/in-app version contract
pnpm version:sync      # Write package.json version to the other version files
pnpm workflow:check    # GitHub Actions and release-workflow contract
pnpm test              # Frontend and Rust tests
pnpm test:frontend     # Frontend Vitest tests without the native toolchain
pnpm test:rust         # Rust tests using the checked-in Cargo.lock
pnpm test:components   # Component-level Vitest tests
pnpm security:desktop  # Desktop capability and security policy checks
```

---

## Project Structure

Before contributing, familiarize yourself with the core modules:

```
src/
├── lib/ai/generator.ts   # Core engine: WebAppGenerator (Tool Call loop)
├── lib/local-agent/      # Local CLI client: probes, observation cache, run-state mapping, generator
├── lib/tools/            # Built-in project and network tools
├── lib/mcp/              # MCP validation, transports, and runtime policy
├── lib/skills/           # Skill storage, import, activation, and execution policy
├── lib/attachments/      # Blob-backed attachment persistence
├── lib/security/         # Permission broker, activity log, and shared secret redaction
├── store/settings/       # Settings persistence
├── store/conversation.ts # Zustand session state management
├── hooks/useGenerator.ts # Hook connecting engine to UI
└── components/           # UI components

src-tauri/src/
├── local_agent.rs          # Local CLI supervisor: probes, run lifecycle, Tauri commands
├── local_agent_<cli>.rs    # Codex, Claude, Pi, and Antigravity adapters
├── local_agent_protocol.rs # Shared child-process helpers, minimal environment, run states
├── local_agent_runtime.rs  # Failure classification and safe error copy
├── local_agent_bridge*.rs  # Per-run loopback tool bridge and permission broker
├── mcp_*.rs, sse.rs        # MCP stdio/remote transports and OAuth
├── proxy.rs                # Provider request proxy for the desktop webview
├── skills.rs               # Skill script execution with a minimal environment
└── design.rs               # Design-mode project export with a native folder picker
```

**Exercise caution** when modifying the core engine (`generator.ts`) — it directly affects AI tool call stability.

---

## Commit Convention

This project follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <short description>

[optional body]

[optional related issue]
```

### Commit Types

| Type       | Description                                 |
| ---------- | ------------------------------------------- |
| `feat`     | New feature                                 |
| `fix`      | Bug fix                                     |
| `docs`     | Documentation changes                       |
| `style`    | Code formatting (no functional changes)     |
| `refactor` | Refactoring (no new features, no bug fixes) |
| `perf`     | Performance optimization                    |
| `chore`    | Build process or tooling changes            |

### Examples

```bash
feat(generator): add regex search support for search_in_files
fix(chat): fix mobile message list scroll issue
docs: update model configuration in README
refactor(store): migrate session persistence to Zustand middleware
```

---

## Pull Request Process

1. **Create a branch**

   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/issue-123
   ```

2. **Develop and commit**

   Keep each commit focused on a single change and follow the commit convention.

3. **Ensure code quality**

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm format:check
   pnpm version:check
   pnpm workflow:check
   pnpm test
   pnpm test:components
   pnpm security:desktop
   pnpm build
   pnpm build:check

   cd src-tauri
   cargo fmt --check
   cargo clippy --all-targets --all-features -- -D warnings
   cargo test
   ```

4. **Push and create PR**

   ```bash
   git push origin feat/your-feature-name
   ```

   Create a Pull Request on GitHub with:
   - A brief description of the changes
   - Related Issue (if any)
   - Testing method

5. **Wait for review**

   Maintainers will review your PR as soon as possible. Please be patient and address feedback accordingly.

### PR Guidelines

- Keep PRs focused — one PR per concern
- Ensure your PR is based on the latest `main` branch (rebase if there are conflicts)
- Do not include unrelated formatting changes in the PR
- Update both `README.md` and `README.zh-CN.md` when user-facing behavior changes
- Add user-visible changes to the `Unreleased` section of `CHANGELOG.md`

---

## Code Style

- Use TypeScript; avoid `any` (add a comment explaining the reason if necessary)
- Use functional components with React Hooks
- File naming: PascalCase for components, camelCase for utility functions
- Keep code concise and avoid over-abstraction
- When adding a tool, define its capability in `src/lib/ai/tools-schema.ts`; schema visibility and execution authorization must derive from the same policy

---

## Versioning and Release Notes

`package.json` is the version source of truth. After intentionally changing it, run `pnpm version:sync` and verify with `pnpm version:check`. Do not edit Cargo, Tauri, or the in-app version independently.

Keep `CHANGELOG.md` in reverse chronological order under `Unreleased`. Before pushing a `vX.Y.Z` tag, rename that section to `## [vX.Y.Z]`; legacy `## [X.Y.Z] - YYYY-MM-DD` headings remain supported. The tag triggers the desktop draft-release workflow only after the frontend and Rust quality gates pass, and the workflow uses that exact changelog section as the GitHub Release description. Missing, duplicate, or empty release sections fail before release creation. Pages deployment remains tied to `main` or a manual workflow run.

Installer packaging depends on external downloads that unit tests cannot verify. The desktop release job caches Tauri bundler tools by runner OS, architecture, and lockfile/configuration hash, and retries failed builds up to three times after the initial attempt. A prolonged upstream outage can still fail a release.

macOS signing is prepared before compilation:

- With no Apple credentials configured, the workflow uses ad-hoc signing without notarization.
- For Developer ID signing, set `APPLE_CERTIFICATE` to the Base64-encoded `.p12` export containing both the certificate and its private key, and set `APPLE_CERTIFICATE_PASSWORD` to its export password (an empty password is supported). `APPLE_SIGNING_IDENTITY` is optional; Tauri can infer it from the imported certificate.
- For notarization, additionally configure all three of `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), and `APPLE_TEAM_ID`. Leave all three unset to skip notarization.

The preflight rejects malformed certificates, unreadable private keys, incorrect export passwords, and incomplete credentials without logging secret values. It does not validate Apple account credentials, certificate trust, expiration, or the final signing identity; Tauri performs the actual keychain import, signing, and optional notarization during packaging.

---

## Need Help?

If you encounter any issues while contributing:

- Comment on the relevant Issue
- Create a new Issue describing your problem

Thank you for contributing!
