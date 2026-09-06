import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateLocalImage } from "./media";

const tauriMocks = vi.hoisted(() => ({
  generate: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("./tauri", () => ({
  generateLocalAgentImage: tauriMocks.generate,
  cancelLocalAgentImage: tauriMocks.cancel,
}));

describe("generateLocalImage", () => {
  const request = {
    taskId: "run-1:call-1",
    provider: "codex" as const,
    model: "gpt-test",
    effort: "high",
    prompt: "Draw a small red fox",
    references: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.cancel.mockResolvedValue(true);
  });

  it("returns raw image metadata from the desktop backend", async () => {
    const image = {
      id: "image-1",
      mimeType: "image/png" as const,
      data: "iVBORw0KGgo=",
      size: 8,
      sha256: "a".repeat(64),
      fileName: "generated.png",
    };
    tauriMocks.generate.mockResolvedValue(image);

    await expect(generateLocalImage(request)).resolves.toEqual(image);
    expect(tauriMocks.generate).toHaveBeenCalledWith(request);
  });

  it("does not start a task for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      generateLocalImage(request, controller.signal),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(tauriMocks.generate).not.toHaveBeenCalled();
  });

  it("cancels the exact task id and discards a late result", async () => {
    let finish!: (value: unknown) => void;
    tauriMocks.generate.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const result = generateLocalImage(request, controller.signal);

    controller.abort();
    finish({
      id: "late-image",
      mimeType: "image/png",
      data: "late",
      size: 4,
      sha256: "b".repeat(64),
    });

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(tauriMocks.cancel).toHaveBeenCalledWith("run-1:call-1");
  });
});
