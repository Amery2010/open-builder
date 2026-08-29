import { generateText } from "ai";
import type { Message } from "../ai/generator";
import type { ProviderConfig } from "../ai/provider";
import { getProviderModel } from "../ai/provider";
import { deriveFallbackTitle, getTitleRequestText } from "./title-fallback";

const MAX_MODEL_TITLE_LENGTH = 80;
export const SMART_TITLE_TIMEOUT_MS = 10_000;

export { deriveFallbackTitle };

function stripWrappingQuotes(value: string): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["`", "`"],
  ];
  let result = value.trim();
  for (const [start, end] of pairs) {
    if (result.startsWith(start) && result.endsWith(end)) {
      result = result.slice(start.length, -end.length).trim();
      break;
    }
  }
  return result;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[\s.!?。！？,:：;；，…]+$/u, "").trim();
}

export function normalizeSmartTitle(value: string): string | null {
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;

  let normalized = firstLine.replace(/\s+/gu, " ").trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const cleaned = stripTrailingPunctuation(
      stripWrappingQuotes(normalized.replace(/^#{1,6}\s*/u, "").trim()),
    );
    if (cleaned === normalized) break;
    normalized = cleaned;
  }
  if (!normalized || Array.from(normalized).length > MAX_MODEL_TITLE_LENGTH) {
    return null;
  }
  return normalized;
}

export async function generateSmartTitle(
  messages: Message[],
  cfg: ProviderConfig,
  generateTextOverride?: (
    instructions: string,
    prompt: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<string>,
): Promise<string | null> {
  const firstRequest = messages.find(
    (m) => m.role === "user" && m.metadata?.origin !== "auto_qa",
  );
  if (!firstRequest) return null;

  const requestText = getTitleRequestText(firstRequest);
  const relevant = `user: ${requestText.slice(0, 200)}`;

  const fallback = deriveFallbackTitle([firstRequest]);

  try {
    const instructions =
      "Title this development conversation in 4-12 words, naming the app or task requested in the user's first message. " +
      "Write it in the language the user is using. " +
      "Output the title alone — no quotes, no explanation, no trailing punctuation.";
    const title = generateTextOverride
      ? await generateTextOverride(instructions, relevant, {
          timeoutMs: SMART_TITLE_TIMEOUT_MS,
        })
      : (
          await generateText({
            model: getProviderModel(cfg),
            instructions,
            prompt: relevant,
            maxRetries: 0,
            timeout: SMART_TITLE_TIMEOUT_MS,
          })
        ).text || "";

    const normalized = normalizeSmartTitle(title);
    if (normalized) return normalized;
    console.warn(
      "[smart-title] Model returned an empty or invalid title; using the deterministic fallback.",
    );
    return fallback;
  } catch (error) {
    console.warn(
      "[smart-title] Title generation failed; using the deterministic fallback.",
      error,
    );
    return fallback;
  }
}
