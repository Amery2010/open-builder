import { intersects, subset, validRange } from "semver";
import type { ProjectFiles, ProjectPreviewMode } from "../../types";

export interface ProjectRuntimeCapability {
  supported: boolean;
  reason?: string;
}

export interface ProjectRuntimeCapabilities {
  template: string;
  previewMode: ProjectPreviewMode;
  preview: ProjectRuntimeCapability;
  staticBuild: ProjectRuntimeCapability;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Candidate selection is deliberately separate from proof by actual compilation. */
export function assessProjectRuntime(
  files: ProjectFiles,
): ProjectRuntimeCapabilities {
  let pkg: Record<string, unknown> | undefined;
  if (files["package.json"] !== undefined) {
    try {
      pkg = record(JSON.parse(files["package.json"]));
    } catch {
      /* Report the manifest error below. */
    }
    if (!pkg)
      return unsupported("package.json must contain a valid JSON object.");
  }
  if (
    pkg?.workspaces ||
    Object.keys(files).some((path) =>
      /(?:^|\/)(?:pnpm-workspace\.yaml|\.pnp\.cjs)$/.test(path),
    )
  ) {
    return unsupported(
      "Workspace and monorepo projects are not supported by this Sandpack import runtime.",
    );
  }
  const deps = {
    ...record(pkg?.dependencies),
    ...record(pkg?.devDependencies),
  };
  for (const [name, value] of Object.entries(deps)) {
    if (
      typeof value !== "string" ||
      /^(?:file:|link:|workspace:|git\+|git:|github:)/.test(value)
    ) {
      return unsupported(
        `Dependency ${name} must be available from the public npm registry; local and Git dependencies cannot be imported.`,
      );
    }
  }
  const has = (name: string) => name in deps;
  const ts = Object.keys(files).some((path) => /\.(?:ts|tsx)$/.test(path));
  let template = "static";
  if (has("next")) template = "nextjs";
  else if (has("astro")) template = "astro";
  else if (has("@angular/core")) template = "angular";
  else if (has("svelte"))
    template = has("vite") ? `vite-svelte${ts ? "-ts" : ""}` : "svelte";
  else if (has("vue"))
    template = `${has("vite") ? "vite-" : ""}vue${ts ? "-ts" : ""}`;
  else if (has("preact")) template = `vite-preact${ts ? "-ts" : ""}`;
  else if (has("solid-js")) template = "solid";
  else if (has("react"))
    template = `${has("vite") ? "vite-" : ""}react${ts ? "-ts" : ""}`;
  else if (has("vite")) template = "vite";
  else if (
    pkg &&
    ((typeof pkg.main === "string" && !/\.html?$/i.test(pkg.main)) ||
      Object.values(record(pkg.scripts) ?? {}).some(
        (script) =>
          typeof script === "string" && /\b(?:node|tsx|ts-node)\b/.test(script),
      ))
  )
    template = "node";
  else if (!files["index.html"])
    return unsupported(
      "No supported framework or root index.html entry was found.",
    );

  if (has("vite")) {
    const version = String(deps.vite);
    const range = validRange(version);
    if (range && !intersects(range, ">=4.0.0 <5.0.0")) {
      return unsupported(
        `Vite ${version} is outside this Sandpack runtime's Vite 4 support range.`,
        template,
      );
    }
    if (!files["index.html"])
      return unsupported(
        "Vite projects require a root index.html entry.",
        template,
      );
  }
  const scripts = record(pkg?.scripts);
  if (
    (has("vite") || ["nextjs", "astro", "node"].includes(template)) &&
    !scripts?.dev &&
    !scripts?.start
  ) {
    return unsupported(
      "The project requires a dev or start script for Sandpack preview.",
      template,
    );
  }
  const staticBuild =
    template === "static" ||
    (has("vite") &&
      validRange(String(deps.vite)) !== null &&
      subset(String(deps.vite), ">=4.0.0 <5.0.0") &&
      !["nextjs", "astro", "node"].includes(template));
  return {
    template,
    previewMode: "sandpack",
    preview: { supported: true },
    staticBuild: staticBuild
      ? { supported: true }
      : {
          supported: false,
          reason:
            "Static deployment downloads support plain static sites and Vite 4 frontend projects. This project needs another build or server runtime.",
        },
  };
}

function unsupported(
  reason: string,
  template = "static",
): ProjectRuntimeCapabilities {
  return {
    template,
    previewMode: "code-only",
    preview: { supported: false, reason },
    staticBuild: { supported: false, reason },
  };
}
