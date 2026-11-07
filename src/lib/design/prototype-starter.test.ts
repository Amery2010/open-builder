import { expect, it } from "vitest";
import { applyPrototypeStarter } from "./prototype-starter";

it("keeps shared mock data and explicit reset without URL-driven states", () => {
  const files = applyPrototypeStarter({});
  const data = files["prototype/PrototypeData.tsx"];
  expect(data).toContain('"open-builder:prototype-reset-data", resetData');
  expect(data).toContain("useState<PrototypeData>");
  expect(data).not.toContain("hashchange");
  expect(data).not.toContain("scenario");
  expect(files["prototype/PrototypeHome.tsx"]).toContain("onClick={resetData}");
  expect(files["prototype/PrototypeHome.tsx"]).not.toContain("scenario");
});
