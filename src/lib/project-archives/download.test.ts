// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveProjectArchive } from "./download";
import { saveBlob } from "../utils/save-blob";
const native = vi.hoisted(() => ({
  save: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: native.writeFile }));
vi.mock("./service", () => ({ projectArchiveManager: {} }));
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("project ZIP download", () => {
  it("saves PNG pixels with PNG filters and preserves their bytes", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    native.save.mockResolvedValue("/selected/page.png");
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    await expect(
      saveBlob({ arrayBuffer: async () => bytes.buffer } as Blob, "page.png", {
        mimeType: "image/png",
        extension: "png",
        description: "PNG",
      }),
    ).resolves.toBe(true);
    expect(native.save).toHaveBeenCalledWith({
      defaultPath: "page.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    expect(native.writeFile).toHaveBeenCalledWith("/selected/page.png", bytes);
  });
  it("downloads PNG with its own MIME type and releases its URL", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn((_blob: Blob) => "blob:png");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("page.png");
      });
    await saveBlob(new Blob(["png"]), "page.png", {
      mimeType: "image/png",
      extension: "png",
      description: "PNG",
    });
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0].type).toBe("image/png");
    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:png");
  });
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
    await saveProjectArchive(new Blob(["ZIP"]), "项目-version.zip", {
      preferFilePicker: true,
    });
    expect(downloads).toEqual(["项目-version.zip"]);
    expect(createObjectURL.mock.calls[0][0].type).toBe("application/zip");
    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:archive");
    expect(document.querySelector("a")).toBeNull();
  });
  it("opens the browser save picker synchronously and writes the prepared ZIP", async () => {
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const picker = vi.fn(async () => ({
      createWritable: async () => writable,
    }));
    (window as unknown as Record<string, unknown>).showSaveFilePicker = picker;
    const blob = new Blob(["ZIP"]);
    const result = saveProjectArchive(blob, "website123.zip", {
      preferFilePicker: true,
    });
    expect(picker).toHaveBeenCalledWith({
      suggestedName: "website123.zip",
      types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
    });
    await expect(result).resolves.toBe(true);
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(writable.close).toHaveBeenCalledOnce();
  });

  it("does not fall back to a download when the browser picker is cancelled", async () => {
    (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn(
      async () => {
        throw new DOMException("Cancelled", "AbortError");
      },
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    await expect(
      saveProjectArchive(new Blob(), "website123.zip", {
        preferFilePicker: true,
      }),
    ).resolves.toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  it("does not write a stale ZIP after the native save picker returns", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const controller = new AbortController();
    native.save.mockImplementation(async () => {
      controller.abort();
      return "/selected/website123.zip";
    });
    const blob = {
      arrayBuffer: async () => new Uint8Array([80, 75]).buffer,
    } as Blob;
    await expect(
      saveProjectArchive(blob, "website123.zip", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(native.writeFile).not.toHaveBeenCalled();
  });

  it("aborts an unfinished browser write after the target becomes stale", async () => {
    const controller = new AbortController();
    const writable = {
      write: vi.fn(async () => {
        controller.abort();
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn(
      async () => ({ createWritable: async () => writable }),
    );
    await expect(
      saveProjectArchive(new Blob(), "website123.zip", {
        preferFilePicker: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledOnce();
  });
});
