import { describe, expect, it, vi } from "vitest";
import {
  AgnesApiError,
  createAgnesVideo,
  generateAgnesImage,
  getAgnesVideoStatus,
} from "./client";
import {
  AGNES_API_ORIGIN,
  AGNES_IMAGE_MODEL,
  AGNES_VIDEO_MODEL,
} from "./types";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function videoResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "record-1",
    task_id: "task-1",
    video_id: "video_1",
    model: AGNES_VIDEO_MODEL,
    size: "720P",
    seconds: "5",
    status: "queued",
    progress: 0,
    created_at: 1,
    completed_at: null,
    ...overrides,
  };
}

function fetchCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls as unknown as Array<
    [RequestInfo | URL, RequestInit | undefined]
  >;
}

describe("Agnes fixed-endpoint API client", () => {
  it("sends the documented image payload to the official endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ url: "https://cdn.example.com/image.png" }] }),
    );
    const result = await generateAgnesImage(
      {
        prompt: "A quiet lake",
        size: "1K",
        ratio: "1:1",
        images: ["https://cdn.example.com/reference.png"],
      },
      { apiKey: "agnes-secret", fetch: fetchMock as typeof fetch },
    );

    expect(result).toMatchObject({
      urls: ["https://cdn.example.com/image.png"],
      retried: false,
      duplicatePossible: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchCalls(fetchMock)[0];
    expect(url).toBe(`${AGNES_API_ORIGIN}/v1/images/generations`);
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer agnes-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: AGNES_IMAGE_MODEL,
      prompt: "A quiet lake",
      size: "1K",
      ratio: "1:1",
      extra_body: {
        response_format: "url",
        image: ["https://cdn.example.com/reference.png"],
      },
    });
  });

  it("retries one 5xx POST and marks the duplicate-generation possibility", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503, { "retry-after": "0" }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ url: "https://cdn.example.com/retry.png" }] }),
      );

    await expect(
      generateAgnesImage(
        { prompt: "Retry", size: "1K", ratio: "1:1", images: [] },
        { apiKey: "secret", fetch: fetchMock as typeof fetch },
      ),
    ).resolves.toMatchObject({
      retried: true,
      duplicatePossible: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry ordinary client or network failures and never reflects the key", async () => {
    const denied = vi.fn(async () => jsonResponse({ secret: "body" }, 401));
    await expect(
      generateAgnesImage(
        { prompt: "Denied", size: "1K", ratio: "1:1", images: [] },
        { apiKey: "sentinel-api-key", fetch: denied as typeof fetch },
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(denied).toHaveBeenCalledTimes(1);

    try {
      await generateAgnesImage(
        { prompt: "Denied", size: "1K", ratio: "1:1", images: [] },
        {
          apiKey: "sentinel-api-key",
          fetch: vi.fn(async () => {
            throw new TypeError("sentinel-api-key");
          }) as typeof fetch,
        },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(AgnesApiError);
      expect(String(error)).not.toContain("sentinel-api-key");
    }
  });

  it("validates video creation and status responses before exposing URLs", async () => {
    const createFetch = vi.fn(async () => jsonResponse(videoResponse()));
    await expect(
      createAgnesVideo(
        { prompt: "Ocean waves", seconds: 5, aspectRatio: "16:9" },
        { apiKey: "secret", fetch: createFetch as typeof fetch },
      ),
    ).resolves.toMatchObject({
      videoId: "video_1",
      status: "queued",
      progress: 0,
    });
    expect(
      JSON.parse(String(fetchCalls(createFetch)[0][1]?.body)),
    ).toMatchObject({
      model: AGNES_VIDEO_MODEL,
      seconds: "5",
      mode: "text",
      size: "720P",
      aspect_ratio: "16:9",
      n: 1,
    });

    const statusFetch = vi.fn(async () =>
      jsonResponse(
        videoResponse({
          status: "completed",
          progress: 100,
          metadata: { url: "https://cdn.example.com/video.mp4" },
        }),
      ),
    );
    await expect(
      getAgnesVideoStatus("video_1", {
        apiKey: "secret",
        fetch: statusFetch as typeof fetch,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      url: "https://cdn.example.com/video.mp4",
    });
    expect(fetchCalls(statusFetch)[0][0]).toBe(
      `${AGNES_API_ORIGIN}/agnesapi?video_id=video_1&model_name=${AGNES_VIDEO_MODEL}`,
    );
  });

  it("does not retry a video-status GET", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse(videoResponse()));

    await expect(
      getAgnesVideoStatus("video_1", {
        apiKey: "secret",
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed image counts and unsafe completed video URLs", async () => {
    await expect(
      generateAgnesImage(
        { prompt: "Two", size: "1K", ratio: "1:1", images: [] },
        {
          apiKey: "secret",
          fetch: vi.fn(async () =>
            jsonResponse({
              data: [
                { url: "https://cdn.example.com/1.png" },
                { url: "https://cdn.example.com/2.png" },
              ],
            }),
          ) as typeof fetch,
        },
      ),
    ).rejects.toThrow(/image count/i);

    await expect(
      getAgnesVideoStatus("video_1", {
        apiKey: "secret",
        fetch: vi.fn(async () =>
          jsonResponse(
            videoResponse({
              status: "completed",
              progress: 100,
              metadata: { url: "https://localhost/video.mp4" },
            }),
          ),
        ) as typeof fetch,
      }),
    ).rejects.toThrow(/unsafe video URL/i);
  });
});
