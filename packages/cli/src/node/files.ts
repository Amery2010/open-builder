import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isSensitiveProjectPath, type ProjectFiles } from "@open-builder/core";
import { isFsError, ProjectError } from "./errors.js";

const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "target",
  "vendor",
  "playwright-report",
  "test-results",
]);
const binaryExtension =
  /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|br|woff2?|ttf|otf|mp[34]|webm|mov|wasm|exe|dll|so|dylib)$/i;

export interface SkippedFile {
  path: string;
  reason: string;
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  ) {
    throw new ProjectError(
      "PATH_CHANGED",
      "A project directory changed or became a symbolic link.",
    );
  }
}

export async function readTextFile(filename: string): Promise<string> {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ProjectError("INVALID_FILE", "Expected a regular project file.");
  await assertRealDirectory(path.dirname(filename));
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.ino !== before.ino ||
      actual.dev !== before.dev
    )
      throw new ProjectError(
        "FILE_CHANGED",
        "A project file changed while being read.",
      );
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (actual.size !== after.size || actual.mtimeMs !== after.mtimeMs)
      throw new ProjectError(
        "FILE_CHANGED",
        "A project file changed while being read.",
      );
    if (bytes.includes(0))
      throw new ProjectError("BINARY_FILE", "The file contains binary data.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ProjectError("BINARY_FILE", "The file is not UTF-8 text.");
    }
  } finally {
    await handle.close();
  }
}

export async function scanProject(
  directory: string,
): Promise<{ files: ProjectFiles; skipped: SkippedFile[] }> {
  const files: ProjectFiles = {};
  const skipped: SkippedFile[] = [];
  async function visit(current: string, prefix: string): Promise<void> {
    await assertRealDirectory(current);
    const entries = (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(current, entry.name);
      let reason: string | undefined;
      if (entry.isSymbolicLink()) reason = "symbolic-link";
      else if (isSensitiveProjectPath(relative)) reason = "sensitive-path";
      else if (
        entry.isDirectory() &&
        ignoredDirectories.has(entry.name.toLowerCase())
      )
        reason = "generated-or-dependency-directory";
      else if (entry.isDirectory()) {
        await visit(filename, relative);
        continue;
      } else if (!entry.isFile()) reason = "non-regular-file";
      else if (binaryExtension.test(entry.name)) reason = "binary-file";
      else {
        try {
          files[relative] = await readTextFile(filename);
        } catch (error) {
          if (
            error instanceof ProjectError &&
            ["BINARY_FILE", "FILE_CHANGED", "INVALID_FILE"].includes(error.code)
          )
            reason = error.code.toLowerCase().replaceAll("_", "-");
          else if (isFsError(error, "ENOENT")) reason = "removed-during-scan";
          else throw error;
        }
      }
      if (reason) skipped.push({ path: relative, reason });
    }
  }
  await visit(directory, "");
  return { files, skipped };
}

interface CreatedFile {
  filename: string;
  content: string;
  ino: number;
  dev: number;
}
interface CreatedDirectory {
  filename: string;
  ino: number;
  dev: number;
}

export async function writeNewFiles(
  directory: string,
  files: ProjectFiles,
): Promise<void> {
  const created: CreatedFile[] = [];
  const directories: CreatedDirectory[] = [];
  try {
    for (const [relative, content] of Object.entries(files)) {
      if (
        !relative ||
        relative.includes("\\") ||
        path.isAbsolute(relative) ||
        /^[A-Za-z]:/.test(relative) ||
        relative
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      ) {
        throw new ProjectError(
          "INVALID_TEMPLATE_PATH",
          "The template contains an unsafe file path.",
        );
      }
      const segments = relative.split("/");
      let parent = directory;
      for (const segment of segments.slice(0, -1)) {
        await assertRealDirectory(parent);
        parent = path.join(parent, segment);
        try {
          await mkdir(parent);
          const stat = await lstat(parent);
          directories.push({ filename: parent, ino: stat.ino, dev: stat.dev });
        } catch (error) {
          if (!isFsError(error, "EEXIST")) throw error;
        }
      }
      await assertRealDirectory(parent);
      const leaf = segments.at(-1)!;
      if (
        (await readdir(parent)).some(
          (name) => name.toLowerCase() === leaf.toLowerCase(),
        )
      )
        throw new ProjectError(
          "CONFLICT",
          `Target already exists: ${relative}`,
        );
      const filename = path.join(parent, leaf);
      const handle = await open(
        filename,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o644,
      );
      try {
        const stat = await handle.stat();
        created.push({ filename, content, ino: stat.ino, dev: stat.dev });
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    for (const file of created.reverse()) {
      try {
        const stat = await lstat(file.filename);
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.ino === file.ino &&
          stat.dev === file.dev &&
          (await readTextFile(file.filename)) === file.content
        )
          await unlink(file.filename);
      } catch {
        /* Preserve files whose ownership or contents can no longer be confirmed. */
      }
    }
    for (const dir of directories.reverse()) {
      try {
        const stat = await lstat(dir.filename);
        if (stat.isDirectory() && stat.ino === dir.ino && stat.dev === dir.dev)
          await rmdir(dir.filename);
      } catch {
        /* rmdir preserves non-empty or concurrently changed directories. */
      }
    }
    throw error;
  }
}
