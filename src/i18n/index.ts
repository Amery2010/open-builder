import { useSettingsStore } from "../store/settings";
import { zh } from "./zh";
import { en } from "./en";

export type Translations = typeof zh;

export type ResolvedLocale = "zh" | "en";

/** Resolve a persisted language setting to the two locales supported by the UI. */
export function resolveLocale(lang: string): ResolvedLocale {
  if (lang === "zh") return "zh";
  if (lang === "en") return "en";
  // "system" — detect from browser
  if (typeof navigator !== "undefined") {
    return navigator.language.startsWith("zh") ? "zh" : "en";
  }
  return "zh";
}

/** Read and resolve the current UI language without subscribing to React state. */
export function getResolvedLocale(): ResolvedLocale {
  return resolveLocale(useSettingsStore.getState().system.language);
}

/** Non-reactive — reads current language from store directly.
 *  Use in non-React code (e.g. mergeMessages). */
export function getT(): Translations {
  const lang = getResolvedLocale();
  return lang === "zh" ? zh : en;
}

/** Reactive hook — re-renders when language setting changes. */
export function useT(): Translations {
  const language = useSettingsStore((s) => s.system.language);
  const lang = resolveLocale(language);
  return lang === "zh" ? zh : en;
}
