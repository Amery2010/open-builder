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

---

## Code of Conduct

By participating in this project, you agree to abide by the following guidelines:

- Respect all participants and maintain friendly, constructive communication
- Accept constructive criticism and focus on what's best for the project
- Do not post any discriminatory, harassing, or inappropriate content

---

## How to Contribute

### Reporting Bugs

1. Search [Issues](https://github.com/your-username/open-builder/issues) first to ensure the bug hasn't been reported
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

- Node.js 20+ (recommend using [nvm](https://github.com/nvm-sh/nvm) for version management)
- Git

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
pnpm dev      # Start dev server (hot reload)
pnpm build    # Build for production
pnpm preview  # Preview production build
pnpm lint     # TypeScript type checking
```

---

## Project Structure

Before contributing, familiarize yourself with the core modules:

```
src/
├── lib/generator.ts      # Core engine: WebAppGenerator (Tool Call loop)
├── lib/tavily.ts         # Web search tool
├── lib/settings.ts       # Settings persistence
├── store/conversation.ts # Zustand session state management
├── hooks/useGenerator.ts # Hook connecting engine to UI
└── components/           # UI components
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

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `style` | Code formatting (no functional changes) |
| `refactor` | Refactoring (no new features, no bug fixes) |
| `perf` | Performance optimization |
| `chore` | Build process or tooling changes |

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
   pnpm lint   # Ensure no TypeScript errors
   pnpm build  # Ensure build succeeds
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

---

## Code Style

- Use TypeScript; avoid `any` (add a comment explaining the reason if necessary)
- Use functional components with React Hooks
- File naming: PascalCase for components, camelCase for utility functions
- Keep code concise and avoid over-abstraction
- When adding new tools, define them in the `BUILTIN_TOOLS` array in `generator.ts` and add handling logic in the `executeTool` switch

---

## Need Help?

If you encounter any issues while contributing:

- Comment on the relevant Issue
- Create a new Issue describing your problem

Thank you for contributing!
