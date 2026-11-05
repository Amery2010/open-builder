import { tool } from "ai";
import { z } from "zod";
import type { AssetSearchSettings } from "../../store/settings";
import {
  ASSET_DESCRIPTION_MAX_CHARS,
  ASSET_SEARCH_MAX_RESULTS,
  clampInt,
  fetchTextWithTimeout,
  formatHttpError,
  limitArray,
  normalizeToolQuery,
  safeErrorMessage,
  truncateText,
} from "./network-guard";

const PIXABAY_API_URL = "https://pixabay.com/api";
const UNSPLASH_API_URL = "https://api.unsplash.com";

export const ASSET_SEARCH_TOOLS = {
  image_search: tool({
    description:
      "Search for high-quality stock images using keywords. " +
      "Returns image URLs, thumbnails, and metadata. " +
      "Use this when you need real photos or illustrations for the application.",
    inputSchema: z.object({
      query: z.string().describe("Search keywords for images"),
      image_type: z
        .enum(["all", "photo", "illustration", "vector"])
        .optional()
        .describe("Type of image (default: all)"),
      orientation: z
        .enum(["all", "horizontal", "vertical"])
        .optional()
        .describe("Image orientation (default: all)"),
      color: z
        .enum(["black", "white", "yellow", "orange", "red", "green", "blue"])
        .optional()
        .describe("Filter by color (optional, Unsplash only)"),
      per_page: z
        .number()
        .optional()
        .describe("Number of results (default: 10, max: 20)"),
    }),
  }),
};

async function pixabaySearch(
  settings: AssetSearchSettings,
  query: string,
  imageType: string = "all",
  orientation: string = "all",
  color?: string,
  perPage: number = 10,
  signal?: AbortSignal,
): Promise<string> {
  const checkedQuery = normalizeToolQuery(query);
  if (!checkedQuery.ok) {
    return JSON.stringify({ ok: false, error: checkedQuery.error });
  }
  const size = clampInt(perPage, 10, 1, ASSET_SEARCH_MAX_RESULTS);
  const params = new URLSearchParams({
    key: settings.pixabayApiKey,
    q: checkedQuery.query,
    image_type: imageType,
    orientation: orientation,
    per_page: size.toString(),
  });
  if (color) params.append("colors", color);

  try {
    const { response: res, text: body } = await fetchTextWithTimeout(
      `${PIXABAY_API_URL}/?${params}`,
      { signal },
    );
    if (!res.ok) {
      const text = body;
      return JSON.stringify({
        ok: false,
        error: formatHttpError("Pixabay search failed", res.status, text),
      });
    }

    const data = JSON.parse(body);
    const limited = limitArray(data.hits ?? [], size);
    return JSON.stringify({
      ok: true,
      images: limited.items.map((img: any) => {
        const description = truncateText(img.tags, ASSET_DESCRIPTION_MAX_CHARS);
        return {
          url: `https://i0.wp.com/${img.webformatURL.replace(/^https?:\/\//, "")}`,
          thumbnail: `https://i0.wp.com/${img.previewURL.replace(/^https?:\/\//, "")}`,
          width: img.webformatWidth,
          height: img.webformatHeight,
          description: description.text,
          descriptionTruncated: description.truncated,
        };
      }),
      meta: {
        engine: "pixabay",
        maxResults: size,
        truncatedResults: limited.truncated,
      },
    });
  } catch (err) {
    signal?.throwIfAborted();
    return JSON.stringify({ ok: false, error: safeErrorMessage(err) });
  }
}

async function unsplashSearch(
  settings: AssetSearchSettings,
  query: string,
  orientation: string = "all",
  color?: string,
  perPage: number = 10,
  signal?: AbortSignal,
): Promise<string> {
  const checkedQuery = normalizeToolQuery(query);
  if (!checkedQuery.ok) {
    return JSON.stringify({ ok: false, error: checkedQuery.error });
  }
  const size = clampInt(perPage, 10, 1, ASSET_SEARCH_MAX_RESULTS);
  const params = new URLSearchParams({
    query: checkedQuery.query,
    client_id: settings.unsplashApiKey,
    per_page: size.toString(),
  });

  if (orientation === "horizontal") params.append("orientation", "landscape");
  if (orientation === "vertical") params.append("orientation", "portrait");
  if (color) params.append("color", color);

  try {
    const { response: res, text: body } = await fetchTextWithTimeout(
      `${UNSPLASH_API_URL}/search/photos?${params}`,
      { signal },
    );
    if (!res.ok) {
      const text = body;
      return JSON.stringify({
        ok: false,
        error: formatHttpError("Unsplash search failed", res.status, text),
      });
    }

    const data = JSON.parse(body);
    const limited = limitArray(data.results ?? [], size);
    return JSON.stringify({
      ok: true,
      images: limited.items.map((img: any) => {
        const description = truncateText(
          img.description || img.alt_description || "",
          ASSET_DESCRIPTION_MAX_CHARS,
        );
        return {
          url: img.urls.regular,
          thumbnail: img.urls.thumb,
          width: 1080,
          height: Math.round((1080 * img.height) / img.width),
          description: description.text,
          descriptionTruncated: description.truncated,
        };
      }),
      meta: {
        engine: "unsplash",
        maxResults: size,
        truncatedResults: limited.truncated,
      },
    });
  } catch (err) {
    signal?.throwIfAborted();
    return JSON.stringify({ ok: false, error: safeErrorMessage(err) });
  }
}

export function createAssetSearchToolHandler(
  settings: AssetSearchSettings,
): (name: string, args: unknown, signal?: AbortSignal) => Promise<string> {
  return async (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string> => {
    signal?.throwIfAborted();
    const a = args as Record<string, any>;
    const engine = settings.engine;
    if (name === "image_search") {
      const checkedQuery = normalizeToolQuery(a?.query);
      if (!checkedQuery.ok) {
        return JSON.stringify({ ok: false, error: checkedQuery.error });
      }
      a.query = checkedQuery.query;
    }

    if (engine === "pixabay" && name === "image_search") {
      return pixabaySearch(
        settings,
        a.query,
        a.image_type,
        a.orientation,
        a.color,
        a.per_page,
        signal,
      );
    }

    if (engine === "unsplash" && name === "image_search") {
      return unsplashSearch(
        settings,
        a.query,
        a.orientation,
        a.color,
        a.per_page,
        signal,
      );
    }

    return `Error: unknown tool "${name}" or engine "${engine}"`;
  };
}
