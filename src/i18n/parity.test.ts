import { describe, expect, it } from "vitest";
import { en } from "./en";
import { zh } from "./zh";

type Leaves = Map<string, string>;

function collectLeaves(value: unknown, path: string, out: Leaves): void {
  if (typeof value === "string") {
    out.set(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectLeaves(item, `${path}[${index}]`, out),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectLeaves(child, path ? `${path}.${key}` : key, out);
    }
    return;
  }
  throw new Error(`Unsupported translation value at ${path}: ${typeof value}`);
}

function placeholdersOf(text: string): string[] {
  return [...new Set(text.match(/\{[A-Za-z0-9_]+\}/g) ?? [])].sort();
}

const enLeaves: Leaves = new Map();
const zhLeaves: Leaves = new Map();
collectLeaves(en, "", enLeaves);
collectLeaves(zh, "", zhLeaves);

describe("i18n parity", () => {
  it("defines the same keys in English and Chinese", () => {
    expect([...zhLeaves.keys()].sort()).toEqual([...enLeaves.keys()].sort());
  });

  it("uses the same placeholders for every key", () => {
    const mismatched = [...enLeaves]
      .filter(([key, text]) => {
        const other = zhLeaves.get(key);
        return (
          other !== undefined &&
          placeholdersOf(other).join(",") !== placeholdersOf(text).join(",")
        );
      })
      .map(([key, text]) => ({
        key,
        en: placeholdersOf(text),
        zh: placeholdersOf(zhLeaves.get(key) ?? ""),
      }));
    expect(mismatched).toEqual([]);
  });
});
