# Open Builder tool integration

The host agent edits code and installs dependencies. Open Builder provides deterministic project operations, not an independent model loop.

## Discover and select

For CLI use, run `open-builder --help` and `open-builder --version`. For MCP, inspect the available tool list; server configuration may omit task execution. Choose one available integration for a given operation rather than invoking both.

| Operation            | CLI                                          | MCP                                    |
| -------------------- | -------------------------------------------- | -------------------------------------- |
| Templates            | `templates list`                             | `builder_list_templates`               |
| Design systems       | `design list`                                | `builder_list_design_systems`          |
| Create project       | `init <dir> --template <id> [--design <id>]` | `builder_init_project`                 |
| Add design files     | `design apply <dir> --id <id>`               | `builder_apply_design_system`          |
| Static checks        | `check <dir>`                                | `builder_check_project`                |
| Run a project script | `verify <dir> --task <name>`                 | `builder_verify_project`, when exposed |

Use `--json` for machine-readable one-shot command results. Check `ok`, errors, verification status, scan omissions, and `notRun`; a tool response alone is not proof of a passing check.

MCP project paths are relative to the workspace fixed by the server operator. Creation requires a new directory. Design application creates `DESIGN.md` and `tokens.css`; if either already exists, preserve it and perform any requested migration with host editing tools. Existing projects need the host to wire their style entry after design files are added.

## Script execution

Only `build`, `typecheck`, `lint`, and `test` are supported, and each must exist as a same-named package script. npm and pnpm are supported. Dependencies must already be installed. Run against a concrete application directory, not a workspace orchestration root.

The CLI runs the explicitly requested script. MCP exposes verification only when its operator enables project scripts at startup. A model argument cannot grant that capability. Project scripts are trusted local code, not sandboxed by Open Builder.

Report an absent script as unsupported, a failed script as failed, and a timeout or cancellation as incomplete. Use the host's own command tool when it needs an operation outside this fixed set and the user has authorized it.
