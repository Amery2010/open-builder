import type { ProjectFiles } from "../../types";
import { SANDBOX_TEMPLATES } from "@codesandbox/sandpack-react";
import { diffChars } from "diff";

interface CommandProjection {
  original: string;
  projected: string;
  spans: Array<{
    start: number;
    end: number;
    original: string;
    inserted: boolean;
  }>;
}

function withoutTerminalClearing(command: string): CommandProjection {
  const original = command;
  // Keep quoted shell arguments opaque, so strings such as `echo "vite"`
  // cannot be mistaken for an executable or a second shell command.
  const tokens = [
    ...command.matchAll(
      /(?:[^\s"';&|\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+|&&|\|\||[;&|]/g,
    ),
  ];
  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (let start = 0; start < tokens.length;) {
    let end = start;
    while (end < tokens.length && !/^[;&|]+$/.test(tokens[end][0])) end += 1;
    let executable = start;
    if (["env", "cross-env"].includes(tokens[executable]?.[0])) executable += 1;
    while (/^[A-Za-z_]\w*=/.test(tokens[executable]?.[0] ?? ""))
      executable += 1;
    if (["npx", "bunx"].includes(tokens[executable]?.[0])) {
      executable += 1;
      if (["-y", "--yes"].includes(tokens[executable]?.[0])) executable += 1;
    } else if (
      ["npm", "pnpm", "yarn"].includes(tokens[executable]?.[0]) &&
      tokens[executable + 1]?.[0] === "exec"
    ) {
      executable += 2;
      if (tokens[executable]?.[0] === "--") executable += 1;
    }
    if (executable < end && tokens[executable][0] === "vite") {
      let hasFlag = false;
      for (let index = executable + 1; index < end; index += 1) {
        const token = tokens[index];
        if (token[0] === "--") break;
        if (!/^--clearScreen(?:=|$)/.test(token[0])) continue;
        hasFlag = true;
        let last = token;
        if (
          token[0] === "--clearScreen" &&
          /^(?:true|false|"true"|"false"|'true'|'false')$/.test(
            tokens[index + 1]?.[0] ?? "",
          )
        ) {
          last = tokens[++index];
        }
        edits.push({
          start: token.index,
          end: last.index + last[0].length,
          value: "--clearScreen false",
        });
      }
      if (!hasFlag) {
        const position =
          tokens[executable].index + tokens[executable][0].length;
        edits.push({
          start: position,
          end: position,
          value: " --clearScreen false",
        });
      }
    }
    start = end + 1;
  }
  let offset = 0;
  const spans = edits.map((edit) => {
    const inserted = edit.start === edit.end;
    const span = {
      start: edit.start + offset + (inserted ? 1 : 0),
      end: edit.start + offset + edit.value.length,
      original: original.slice(edit.start, edit.end),
      inserted,
    };
    offset += edit.value.length - (edit.end - edit.start);
    return span;
  });
  for (const edit of [...edits].reverse()) {
    command =
      command.slice(0, edit.start) + edit.value + command.slice(edit.end);
  }
  return { original, projected: command, spans };
}

function restoreCommand(projection: CommandProjection, edited: string): string {
  if (edited === projection.projected) return projection.original;
  let sourceOffset = 0;
  let targetOffset = 0;
  const restores: Array<{ start: number; end: number; value: string }> = [];
  for (const change of diffChars(projection.projected, edited)) {
    if (!change.added && !change.removed) {
      for (const span of projection.spans) {
        if (
          span.start < sourceOffset ||
          span.end > sourceOffset + change.value.length
        )
          continue;
        let start = targetOffset + span.start - sourceOffset;
        const end = targetOffset + span.end - sourceOffset;
        if (span.inserted && edited[start - 1] === " ") start -= 1;
        restores.push({ start, end, value: span.original });
      }
    }
    if (!change.added) sourceOffset += change.value.length;
    if (!change.removed) targetOffset += change.value.length;
  }
  // Only undo generated spans the user left intact; keep edits to the option itself.
  for (const restore of restores.reverse()) {
    edited =
      edited.slice(0, restore.start) +
      restore.value +
      edited.slice(restore.end);
  }
  return edited;
}

function packageRecord(content: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Match Sandpack's package bytes and disable unsupported Vite terminal clearing. */
export function projectSandpackRuntime(
  files: ProjectFiles,
  enabled = true,
  template?: string,
): {
  files: ProjectFiles;
  restore: (path: string, content: string) => string | undefined;
} {
  const identity = {
    files,
    restore: (_path: string, content: string) => content,
  };
  if (!enabled) return identity;
  const base =
    template && template in SANDBOX_TEMPLATES
      ? SANDBOX_TEMPLATES[template as keyof typeof SANDBOX_TEMPLATES]
      : undefined;
  let source = files["package.json"];
  const synthetic = source === undefined;
  if (synthetic && template?.startsWith("vite") && base) {
    const file = (base.files as Record<string, string | { code: string }>)[
      "/package.json"
    ];
    source = typeof file === "string" ? file : file?.code;
  }
  if (!source) return identity;
  const pkg = packageRecord(source);
  if (!pkg) return identity;
  const scripts =
    pkg.scripts &&
    typeof pkg.scripts === "object" &&
    !Array.isArray(pkg.scripts)
      ? ({ ...pkg.scripts } as Record<string, unknown>)
      : undefined;
  const replacements = new Map<string, CommandProjection>();
  for (const [name, command] of Object.entries(scripts ?? {})) {
    if (typeof command !== "string") continue;
    const projection = withoutTerminalClearing(command);
    if (projection.projected === command) continue;
    scripts![name] = projection.projected;
    replacements.set(name, projection);
  }
  // SandpackProvider reserializes package.json and supplies dependency maps.
  // Produce those exact bytes before synchronization rather than relaxing the
  // delivery comparison or writing formatting changes into the project.
  const projectedPackage = {
    ...pkg,
    ...(scripts ? { scripts } : {}),
    dependencies: {
      ...(pkg.dependencies as Record<string, unknown> | undefined),
    },
    devDependencies: {
      ...(pkg.devDependencies as Record<string, unknown> | undefined),
    },
  };
  const projected = JSON.stringify(projectedPackage, null, 2);
  if (projected === source) return identity;
  return {
    files: { ...files, "package.json": projected },
    restore(path, content) {
      if (path !== "package.json") return content;
      if (content === projected) return synthetic ? undefined : source;
      const edited = packageRecord(content);
      if (!edited) return content;
      const editedScripts =
        edited.scripts && typeof edited.scripts === "object"
          ? (edited.scripts as Record<string, unknown>)
          : {};
      let restored = false;
      for (const [name, replacement] of replacements) {
        const command = editedScripts[name];
        if (typeof command !== "string") continue;
        const original = restoreCommand(replacement, command);
        if (original !== command) {
          editedScripts[name] = original;
          restored = true;
        }
      }
      for (const key of ["dependencies", "devDependencies"] as const) {
        if (
          !(key in pkg) &&
          JSON.stringify(edited[key]) === JSON.stringify(projectedPackage[key])
        ) {
          delete edited[key];
          restored = true;
        }
      }
      if (synthetic && JSON.stringify(edited) === JSON.stringify(pkg))
        return undefined;
      return restored ? JSON.stringify(edited, null, 2) + "\n" : content;
    },
  };
}
