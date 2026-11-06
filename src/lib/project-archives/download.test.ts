// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveProjectArchive } from "./download";
const native = vi.hoisted(() => ({
  save: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: native.writeFile }));
vi.mock("./service", () => ({ projectArchiveManager: {} }));
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("project ZIP download", () => {
  it("passes the ZIP filename and exact binary bytes through the desktop save dialog", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    native.save.mockResolvedValue("/selected/project-version.zip");
    const bytes = new Uint8Array([80, 75, 0, 255]);
    const blob = { arrayBuffer: async () => bytes.buffer } as Blob;
    await expect(saveProjectArchive(blob, "project-version.zip")).resolves.toBe(
      true,
    );
    expect(native.save).toHaveBeenCalledWith({
      defaultPath: "project-version.zip",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    expect(native.writeFile).toHaveBeenCalledWith(
      "/selected/project-version.zip",
      bytes,
    );
  });
  it("does not write anything when the desktop save dialog is cancelled", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    native.save.mockResolvedValue(null);
    await expect(saveProjectArchive(new Blob(), "project.zip")).resolves.toBe(
      false,
    );
    expect(native.writeFile).not.toHaveBeenCalled();
  });
  it("uses an explicit .zip browser download name and releases its object URL", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn((_blob: Blob) => "blob:archive");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
      expect(this.href).toBe("blob:archive");
    });
    await saveProjectArchive(new Blob(["ZIP"]), "项目-version.zip");
    expect(downloads).toEqual(["项目-version.zip"]);
    expect(createObjectURL.mock.calls[0][0].type).toBe("application/zip");
    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:archive");
    expect(document.querySelector("a")).toBeNull();
  });
});
