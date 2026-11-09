import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isFsError, ProjectError } from "./errors.js";

export class ProjectPaths {
  private readonly root?: Promise<string>;

  constructor(root?: string) {
    if (root !== undefined) {
      this.root = realpath(root).then(async (canonical) => {
        if (!(await lstat(canonical)).isDirectory())
          throw new ProjectError(
            "INVALID_ROOT",
            "The workspace root must be a directory.",
          );
        return canonical;
      });
      // The startup caller may not use a project tool immediately.
      void this.root.catch(() => undefined);
    }
  }

  async ready(): Promise<void> {
    await this.root;
  }

  async resolve(project: string, allowMissing = false): Promise<string> {
    if (!project || /[\u0000-\u001f]/.test(project))
      throw new ProjectError(
        "INVALID_PATH",
        "A project directory is required.",
      );
    const root = await this.root;
    let target: string;
    if (root) {
      if (
        path.isAbsolute(project) ||
        path.win32.isAbsolute(project) ||
        /^[A-Za-z]:/.test(project) ||
        project.includes("\\") ||
        project.split("/").includes("..")
      ) {
        throw new ProjectError(
          "PATH_OUTSIDE_ROOT",
          "Project paths must be relative to the configured workspace and cannot traverse parents.",
        );
      }
      if ((await realpath(root)) !== root)
        throw new ProjectError(
          "PATH_CHANGED",
          "The configured workspace directory changed.",
        );
      target = path.resolve(root, project);
      const relative = path.relative(root, target);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new ProjectError(
          "PATH_OUTSIDE_ROOT",
          "Project path is outside the workspace.",
        );
      let current = root;
      const parts = relative ? relative.split(path.sep) : [];
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        try {
          const stat = await lstat(current);
          if (stat.isSymbolicLink())
            throw new ProjectError(
              "SYMLINK_PATH",
              "Project paths cannot traverse symbolic links.",
            );
          if (!stat.isDirectory())
            throw new ProjectError(
              "NOT_DIRECTORY",
              "Project paths must name directories.",
            );
        } catch (error) {
          if (!(
            allowMissing &&
            index === parts.length - 1 &&
            isFsError(error, "ENOENT")
          ))
            throw error;
        }
      }
    } else {
      const requested = path.resolve(project);
      const parent = await realpath(path.dirname(requested));
      target = path.join(parent, path.basename(requested));
    }
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink())
        throw new ProjectError(
          "SYMLINK_PATH",
          "The project directory cannot be a symbolic link.",
        );
      if (!stat.isDirectory())
        throw new ProjectError(
          "NOT_DIRECTORY",
          "The project path is not a directory.",
        );
      if ((await realpath(target)) !== target)
        throw new ProjectError(
          "PATH_CHANGED",
          "The project path changed during the operation.",
        );
    } catch (error) {
      if (!(allowMissing && isFsError(error, "ENOENT"))) throw error;
    }
    return target;
  }
}
