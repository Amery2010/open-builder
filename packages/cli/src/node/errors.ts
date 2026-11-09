export class ProjectError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 2,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

export function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectError("CANCELLED", "Operation cancelled.", 130);
}

export function projectError(error: unknown): ProjectError {
  if (error instanceof ProjectError) return error;
  if (isFsError(error, "ENOENT"))
    return new ProjectError(
      "NOT_FOUND",
      "The project, parent directory, or required file does not exist.",
    );
  if (isFsError(error, "EEXIST"))
    return new ProjectError(
      "CONFLICT",
      "The target already exists; no existing files will be replaced.",
    );
  if (isFsError(error, "EACCES") || isFsError(error, "EPERM"))
    return new ProjectError(
      "ACCESS_DENIED",
      "The operating system denied access to the project.",
    );
  return new ProjectError(
    "IO_ERROR",
    error instanceof Error ? error.message : "Project operation failed.",
    1,
  );
}
