import { describe, expect, it } from "vitest";
import { BUILTIN_WRITE_TOOL_NAMES } from "../tools-schema";
import { SUBAGENT_REGISTRY } from "./registry";

describe("subagent registry write policy", () => {
  it("keeps every read-only definition free of built-in write tools", () => {
    for (const definition of SUBAGENT_REGISTRY) {
      if ((definition.writePolicy ?? "readonly") !== "readonly") continue;

      expect(
        definition.toolWhitelist.filter((name) =>
          BUILTIN_WRITE_TOOL_NAMES.has(name),
        ),
        `${definition.name} must not advertise project write tools`,
      ).toEqual([]);
    }
  });
});
