import { describe, expect, it } from "vitest";
import { runStateForLocalCliStatus } from "./orchestration";

describe("runStateForLocalCliStatus", () => {
  it("maps every enumerated run state onto a generator run state", () => {
    expect(runStateForLocalCliStatus("preparing")).toBe("preparing");
    expect(runStateForLocalCliStatus("handshaking")).toBe("preparing");
    expect(runStateForLocalCliStatus("streaming")).toBe("streaming");
  });
});
