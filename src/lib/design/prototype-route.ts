/** One policy for declarations, navigation, capture, and observed preview locations. */
export const PROTOTYPE_ROUTE_MAX_LENGTH = 2048;

/** Self-contained so the iframe receives exactly the Host policy implementation. */
function createHashRoutePolicy(maxLength: number) {
  return function safeHashRoute(value: unknown): boolean {
    if (
      typeof value !== "string" ||
      !value.startsWith("#/") ||
      value.length > maxLength ||
      !/^#\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/?[\]-]|%[0-9A-Fa-f]{2})*$/.test(value)
    )
      return false;
    const path = value.slice(1).split("?", 1)[0];
    if (path.includes("//")) return false;
    try {
      for (const segment of path.split("/")) {
        let decoded = segment;
        for (let pass = 0; pass <= segment.length; pass++) {
          if (
            decoded === "." ||
            decoded === ".." ||
            /[\u0000-\u001f\u007f-\u009f/\\]/.test(decoded) ||
            /(?:javascript|data|vbscript)\s*:/i.test(decoded)
          )
            return false;
          if (!/%[0-9A-Fa-f]{2}/.test(decoded)) break;
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        }
      }
      const query = value.indexOf("?");
      if (
        query >= 0 &&
        /[\u0000-\u001f\u007f-\u009f]/.test(
          decodeURIComponent(value.slice(query + 1)),
        )
      )
        return false;
    } catch {
      return false;
    }
    return true;
  };
}

export const isSafePrototypeHashRoute = createHashRoutePolicy(
  PROTOTYPE_ROUTE_MAX_LENGTH,
);
export function prototypeHashRoutePolicySource(): string {
  return `(${createHashRoutePolicy.toString()})(${PROTOTYPE_ROUTE_MAX_LENGTH})`;
}

export type PrototypeRouteIssueReason =
  | "missing-route"
  | "unsafe-route"
  | "route-too-long"
  | "unsupported-pattern"
  | "missing-example"
  | "invalid-example"
  | "unknown-page"
  | "unknown-scenario"
  | "scenario-query-conflict"
  | "ambiguous-route";

export interface PrototypeRoutePage {
  id: string;
  route?: string;
  previewPath?: string;
  defaultScenario?: string;
  scenarioIds?: readonly string[];
}
export interface PrototypeRouteDesign {
  pages: readonly PrototypeRoutePage[];
  scenarios: readonly { id: string }[];
}
export interface PrototypeRouteTarget {
  pageId: string;
  route: string;
  scenarioId: string;
}
export type PrototypeRouteResolution =
  | { status: "ready"; target: PrototypeRouteTarget }
  | {
      status: "unavailable";
      pageId?: string;
      scenarioId?: string;
      reason: PrototypeRouteIssueReason;
      message: string;
    };

type NormalizedRoute =
  | { ok: true; route: string }
  | { ok: false; reason: PrototypeRouteIssueReason; message: string };

function splitRoute(route: string): {
  path: string;
  query: string;
  hasQuery: boolean;
} {
  const index = route.indexOf("?");
  return index < 0
    ? { path: route, query: "", hasQuery: false }
    : {
        path: route.slice(0, index),
        query: route.slice(index + 1),
        hasQuery: true,
      };
}
function encodeLiteral(value: string): string {
  return encodeURI(value)
    .replace(/%25([0-9a-f]{2})/gi, "%$1")
    .replaceAll("#", "%23");
}
const parameter = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

/** Failed normalization never substitutes a guessed path; callers retain draft input. */
export function normalizePrototypeRoute(input: string): NormalizedRoute {
  const raw = input.trim().replace(/^#(?=\/)/, "");
  if (!raw)
    return {
      ok: false,
      reason: "missing-route",
      message: "Add an application route for this page.",
    };
  if (
    !raw.startsWith("/") ||
    /[\u0000-\u001f\u007f-\u009f\\]/.test(input) ||
    /%(?![0-9A-Fa-f]{2})/.test(raw)
  ) {
    return {
      ok: false,
      reason: "unsafe-route",
      message:
        "Use an application path with valid URL encoding, not an external URL or unsafe path.",
    };
  }
  const { path, query, hasQuery } = splitRoute(raw);
  if (path.includes("#") || path.includes("//"))
    return {
      ok: false,
      reason: "unsafe-route",
      message: "Use the application path without an extra fragment.",
    };
  const segments = path
    .split("/")
    .map((part) =>
      part.replace(
        /^\[([A-Za-z_][A-Za-z0-9_]*)\]$|^\{([A-Za-z_][A-Za-z0-9_]*)\}$/,
        (_match, bracket, brace) => `:${bracket ?? brace}`,
      ),
    );
  if (
    segments.some(
      (part) =>
        part.includes("*") ||
        ((part.startsWith(":") ||
          part.startsWith("[") ||
          part.startsWith("{")) &&
          !parameter.test(part)),
    )
  ) {
    return {
      ok: false,
      reason: "unsupported-pattern",
      message:
        "Use a whole named path segment (:id, [id], or {id}) and provide a concrete previewPath.",
    };
  }
  try {
    const normalizedPath = encodeLiteral(
      segments.join("/").replace(/\/$/, "") || "/",
    ).replace(/%[a-f0-9]{2}/gi, (escape) => escape.toUpperCase());
    const route = normalizedPath + (hasQuery ? `?${encodeLiteral(query)}` : "");
    if (route.length + 1 > PROTOTYPE_ROUTE_MAX_LENGTH)
      return {
        ok: false,
        reason: "route-too-long",
        message: `The encoded preview route exceeds ${PROTOTYPE_ROUTE_MAX_LENGTH} characters.`,
      };
    if (!isSafePrototypeHashRoute(`#${route}`))
      return {
        ok: false,
        reason: "unsafe-route",
        message: "This route cannot be used for safe in-app navigation.",
      };
    return { ok: true, route };
  } catch {
    return {
      ok: false,
      reason: "unsafe-route",
      message: "The route contains invalid URL encoding.",
    };
  }
}

function matchesPath(patternPath: string, concretePath: string): boolean {
  const declared = patternPath.split("/");
  const actual = concretePath.split("/");
  return (
    declared.length === actual.length &&
    declared.every((part, index) =>
      parameter.test(part)
        ? !!actual[index] && !parameter.test(actual[index])
        : part === actual[index],
    )
  );
}

export function resolvePrototypeRoute(
  design: PrototypeRouteDesign,
  pageId: string,
  scenarioId?: string,
): PrototypeRouteResolution {
  const page = design.pages.find((candidate) => candidate.id === pageId);
  const fail = (
    reason: PrototypeRouteIssueReason,
    message: string,
  ): PrototypeRouteResolution => ({
    status: "unavailable",
    pageId,
    ...(scenarioId ? { scenarioId } : {}),
    reason,
    message,
  });
  if (!page) return fail("unknown-page", "This page is not in the blueprint.");
  const normalized = normalizePrototypeRoute(page.route ?? "");
  if (!normalized.ok) return fail(normalized.reason, normalized.message);
  const { path, query, hasQuery } = splitRoute(normalized.route);
  let concretePath = path;
  if (path.split("/").some((part) => parameter.test(part))) {
    if (!page.previewPath)
      return fail(
        "missing-example",
        "Add a concrete previewPath for this dynamic page.",
      );
    const example = normalizePrototypeRoute(page.previewPath);
    if (
      !example.ok ||
      example.route.includes("?") ||
      example.route.split("/").some((part) => parameter.test(part)) ||
      !matchesPath(path, example.route)
    ) {
      return fail(
        "invalid-example",
        "previewPath must be a concrete matching pathname without query parameters; keep business queries in route.",
      );
    }
    concretePath = example.route;
  }
  const selected = scenarioId ?? page.defaultScenario ?? "default";
  const baseline =
    selected === "default" &&
    !page.defaultScenario &&
    !(page.scenarioIds ?? []).includes("default");
  if (
    !baseline &&
    (!design.scenarios.some((scenario) => scenario.id === selected) ||
      (!(page.scenarioIds ?? []).includes(selected) &&
        page.defaultScenario !== selected))
  ) {
    return fail(
      "unknown-scenario",
      `Scenario "${selected}" is not defined for this page.`,
    );
  }
  const existing = new URLSearchParams(query).getAll("scenario");
  if (
    existing.length > 1 ||
    (existing.length === 1 && existing[0] !== selected)
  ) {
    return fail(
      "scenario-query-conflict",
      "The route scenario query conflicts with the selected scenario; update the declaration without overwriting business query values.",
    );
  }
  const suffix = existing.length
    ? hasQuery
      ? `?${query}`
      : ""
    : `${hasQuery ? `?${query}${query ? "&" : ""}` : "?"}scenario=${encodeURIComponent(selected)}`;
  const route = `#${concretePath}${suffix}`;
  if (route.length > PROTOTYPE_ROUTE_MAX_LENGTH)
    return fail(
      "route-too-long",
      `The final preview route including its scenario exceeds ${PROTOTYPE_ROUTE_MAX_LENGTH} characters.`,
    );
  if (!isSafePrototypeHashRoute(route))
    return fail(
      "unsafe-route",
      "This route cannot be used for safe in-app navigation.",
    );
  return { status: "ready", target: { pageId, route, scenarioId: selected } };
}

/** Exact pages win over parameter declarations; equally specific matches remain ambiguous. */
export function resolveObservedPrototypeRoute(
  design: PrototypeRouteDesign,
  observedRoute: string,
): PrototypeRouteResolution {
  const normalized = normalizePrototypeRoute(observedRoute);
  if (!normalized.ok)
    return {
      status: "unavailable",
      reason: normalized.reason,
      message: normalized.message,
    };
  const observed = splitRoute(normalized.route);
  const query = new URLSearchParams(observed.query);
  const scenarios = query.getAll("scenario");
  if (scenarios.length > 1)
    return {
      status: "unavailable",
      reason: "scenario-query-conflict",
      message: "The observed route contains multiple scenario values.",
    };
  const matches: Array<{ page: PrototypeRoutePage; score: number }> = [];
  for (const page of design.pages) {
    const declared = normalizePrototypeRoute(page.route ?? "");
    if (!declared.ok) continue;
    const parts = splitRoute(declared.route);
    if (!matchesPath(parts.path, observed.path)) continue;
    const declaredQuery = new URLSearchParams(parts.query);
    const remaining = [...query.entries()];
    let matched = true;
    for (const [key, value] of declaredQuery) {
      if (key === "scenario") continue;
      const index = remaining.findIndex(
        (entry) => entry[0] === key && entry[1] === value,
      );
      if (index < 0) {
        matched = false;
        break;
      }
      remaining.splice(index, 1);
    }
    if (matched)
      matches.push({
        page,
        score:
          parts.path.split("/").filter((part) => !parameter.test(part)).length *
            100 +
          [...declaredQuery].length,
      });
  }
  matches.sort((a, b) => b.score - a.score);
  if (!matches.length)
    return {
      status: "unavailable",
      reason: "unknown-page",
      message: "No blueprint page matches this preview location.",
    };
  if (matches[1]?.score === matches[0].score)
    return {
      status: "unavailable",
      reason: "ambiguous-route",
      message: "Multiple blueprint pages match this preview location.",
    };
  const page = matches[0].page;
  const result = resolvePrototypeRoute(
    { ...design, pages: [{ ...page, previewPath: observed.path }] },
    page.id,
    scenarios[0] ?? page.defaultScenario ?? "default",
  );
  return result.status === "ready"
    ? { ...result, target: { ...result.target, route: `#${normalized.route}` } }
    : result;
}
