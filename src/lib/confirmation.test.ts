// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  cancelAllConfirmations,
  getCurrentConfirmation,
  registerConfirmationHost,
  requestConfirmation,
  settleConfirmation,
} from "./confirmation";

describe("confirmation queue", () => {
  afterEach(() => {
    cancelAllConfirmations();
  });

  it("fails closed until a confirmation host is mounted", async () => {
    await expect(
      requestConfirmation({ message: "unhosted confirmation" }),
    ).resolves.toBe(false);
    expect(getCurrentConfirmation()).toBeNull();
  });

  it("settles queued confirmations in order", async () => {
    const unregister = registerConfirmationHost();
    const first = requestConfirmation({ message: "first" });
    const second = requestConfirmation({ message: "second" });

    expect(getCurrentConfirmation()).toMatchObject({ message: "first" });
    expect(settleConfirmation(getCurrentConfirmation()!.id, true)).toBe(true);
    await expect(first).resolves.toBe(true);
    expect(getCurrentConfirmation()).toMatchObject({ message: "second" });
    expect(settleConfirmation(getCurrentConfirmation()!.id, false)).toBe(true);
    await expect(second).resolves.toBe(false);

    unregister();
  });

  it("cancels unresolved prompts when the last host unmounts", async () => {
    const unregister = registerConfirmationHost();
    const pending = requestConfirmation({ message: "pending" });

    unregister();

    await expect(pending).resolves.toBe(false);
    expect(getCurrentConfirmation()).toBeNull();
  });
});
