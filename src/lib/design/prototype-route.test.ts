import { describe, expect, it } from "vitest";
import {
  PROTOTYPE_ROUTE_MAX_LENGTH,
  isSafePrototypeHashRoute,
  prototypeHashRoutePolicySource,
  normalizePrototypeRoute,
  resolvePrototypeRoute,
  resolveObservedPrototypeRoute,
  type PrototypeRouteDesign,
} from "./prototype-route";

const design: PrototypeRouteDesign = {
  pages: [
    {
      id: "details",
      route: "#/商品/[id]/?tab=history&tag=a&tag=b&empty=",
      previewPath: "/商品/sku-42",
    },
  ],
};

describe("Prototype Route module", () => {
  it("normalizes common declarations once without losing business queries", () => {
    const normalized = normalizePrototypeRoute(
      "  #/商品/[id]/?tag=a&tag=b&empty=&q=中文&encoded=%2f  ",
    );
    expect(normalized).toEqual({
      ok: true,
      route:
        "/%E5%95%86%E5%93%81/:id?tag=a&tag=b&empty=&q=%E4%B8%AD%E6%96%87&encoded=%2f",
    });
    if (normalized.ok)
      expect(normalizePrototypeRoute(normalized.route)).toEqual(normalized);
    for (const route of ["/items/:id", "/items/[id]", "/items/{id}"]) {
      expect(normalizePrototypeRoute(route)).toEqual({
        ok: true,
        route: "/items/:id",
      });
    }
    expect(normalizePrototypeRoute("/hello world/")).toEqual({
      ok: true,
      route: "/hello%20world",
    });
  });

  it("resolves explicit dynamic examples without adding host query parameters", () => {
    expect(resolvePrototypeRoute(design, "details")).toEqual({
      status: "ready",
      target: {
        pageId: "details",
        route: "#/%E5%95%86%E5%93%81/sku-42?tab=history&tag=a&tag=b&empty=",
      },
    });
    const noExample = {
      ...design,
      pages: [{ ...design.pages[0], previewPath: undefined }],
    };
    expect(resolvePrototypeRoute(noExample, "details")).toMatchObject({
      status: "unavailable",
      reason: "missing-example",
    });
    for (const previewPath of [
      "/other/sku-42",
      "/商品/:id",
      "/商品/sku-42?tab=history",
    ]) {
      expect(
        resolvePrototypeRoute(
          { ...design, pages: [{ ...design.pages[0], previewPath }] },
          "details",
        ),
      ).toMatchObject({ status: "unavailable", reason: "invalid-example" });
    }
    expect(noExample.pages[0].previewPath).toBeUndefined();
  });

  it("treats former scenario parameters as ordinary business queries", () => {
    for (const route of [
      "/items?scenario=error",
      "/items?scenario=a&scenario=b",
      "/items?%73cenario=default&x=",
    ]) {
      const blueprint = { pages: [{ id: "items", route }] };
      expect(resolvePrototypeRoute(blueprint, "items")).toEqual({
        status: "ready",
        target: { pageId: "items", route: `#${route}` },
      });
      expect(
        resolveObservedPrototypeRoute(blueprint, `#${route}`),
      ).toMatchObject({ status: "ready" });
      expect(resolveObservedPrototypeRoute(blueprint, "#/items")).toMatchObject(
        { status: "ready", target: { route: "#/items" } },
      );
    }
  });

  it("applies one safety policy to Host and injected code", () => {
    const iframePolicy = Function(
      `return ${prototypeHashRoutePolicySource()}`,
    )() as (route: unknown) => boolean;
    const cases: Array<[unknown, boolean]> = [
      ["#/", true],
      ["#/search?link=https://example.test/a&text=javascript:example", true],
      ["#/%E8%AE%BE%E7%BD%AE?scenario=default", true],
      ["#/100%25", true],
      ["https://external.test/", false],
      ["javascript:alert(1)", false],
      ["#/javascript:alert(1)", false],
      ["#//external.test", false],
      ["#/../settings", false],
      ["#/%2e%2e/settings", false],
      ["#/%252e%252e/settings", false],
      ["#/a%2Fb", false],
      ["#/a%5Cb", false],
      ["#/a%00", false],
      ["#/x?q=%00", false],
      ["#/x?q=%ZZ", false],
      ["#/" + "a".repeat(PROTOTYPE_ROUTE_MAX_LENGTH - 2), true],
      ["#/" + "a".repeat(PROTOTYPE_ROUTE_MAX_LENGTH - 1), false],
      [null, false],
    ];
    for (const [route, expected] of cases) {
      expect(isSafePrototypeHashRoute(route), String(route)).toBe(expected);
      expect(iframePolicy(route), String(route)).toBe(expected);
    }
  });

  it("checks the actual final target including encoded query and dynamic sample", () => {
    const page = {
      id: "long",
      route: "/items/:id?q=" + "a".repeat(1900),
      previewPath: "/items/" + "b".repeat(200),
    };
    expect(normalizePrototypeRoute(page.route).ok).toBe(true);
    expect(resolvePrototypeRoute({ pages: [page] }, "long")).toMatchObject({
      status: "unavailable",
      reason: "route-too-long",
    });
  });

  it("matches observed concrete routes and refuses equally specific declarations", () => {
    expect(
      resolveObservedPrototypeRoute(
        design,
        "#/商品/sku-99?tag=a&tag=b&tab=history&empty=",
      ),
    ).toMatchObject({
      status: "ready",
      target: { pageId: "details" },
    });
    const pages = [
      { id: "dynamic", route: "/items/:id" },
      { id: "new", route: "/items/new" },
    ];
    expect(
      resolveObservedPrototypeRoute({ pages }, "#/items/new"),
    ).toMatchObject({ status: "ready", target: { pageId: "new" } });
    expect(
      resolveObservedPrototypeRoute(
        {
          pages: [pages[0], { id: "other", route: "/items/[key]" }],
        },
        "#/items/1",
      ),
    ).toMatchObject({ status: "unavailable", reason: "ambiguous-route" });
  });
});

describe("observed links with preview query defaults", () => {
  it("recognizes a unique page when an internal link omits its preview query", () => {
    const pages = [
      { id: "home", route: "/home?scenario=default" },
      { id: "library", route: "/library?scenario=empty" },
    ];
    expect(resolveObservedPrototypeRoute({ pages }, "#/library")).toEqual({
      status: "ready",
      target: { pageId: "library", route: "#/library" },
    });
    expect(
      resolveObservedPrototypeRoute({ pages }, "#/library?tab=all"),
    ).toEqual({
      status: "ready",
      target: { pageId: "library", route: "#/library?tab=all" },
    });
  });
  it("prefers strict business queries and refuses ambiguous pathname fallback", () => {
    const pages = [
      { id: "open", route: "/items?filter=open" },
      { id: "closed", route: "/items?filter=closed" },
    ];
    expect(
      resolveObservedPrototypeRoute({ pages }, "#/items?filter=open"),
    ).toMatchObject({ status: "ready", target: { pageId: "open" } });
    expect(resolveObservedPrototypeRoute({ pages }, "#/items")).toMatchObject({
      status: "unavailable",
      reason: "ambiguous-route",
    });
    expect(
      resolveObservedPrototypeRoute(
        {
          pages: [
            ...pages,
            {
              id: "detail",
              route: "/items/:id?tab=history",
              previewPath: "/items/42",
            },
          ],
        },
        "#/items/other",
      ),
    ).toMatchObject({
      status: "ready",
      target: { pageId: "detail", route: "#/items/other" },
    });
  });
});
