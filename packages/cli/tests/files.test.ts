import {
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writeNewFiles } from "../src/node/files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it("preserves a concurrent user edit when a later file conflicts and rollback begins", async () => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "builder-concurrent-")),
  );
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  try {
    await writeFile(
      path.join(directory, "existing.txt"),
      "pre-existing user work",
    );
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const originalWrite = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => {
        await originalWrite(...writeArgs);
        // A host edit occurs after creation and before the next file fails.
        await writeFile(args[0], "concurrent user edit");
      });
      return handle;
    });
    await expect(
      writeNewFiles(directory, {
        "created.txt": "initial generated content",
        "existing.txt": "replacement",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(path.join(directory, "created.txt"), "utf8")).toBe(
      "concurrent user edit",
    );
    expect(await readFile(path.join(directory, "existing.txt"), "utf8")).toBe(
      "pre-existing user work",
    );
  } finally {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});
