import type { ProjectFiles } from "../../types";

interface StaticPreviewProjection {
  files: ProjectFiles;
  restore: (path: string, content: string) => string | undefined;
}

// Match real tags while keeping comments and raw-text elements opaque. In
// particular, a JavaScript string containing "<body>" is not a document body.
const HTML_TOKEN =
  /<!--[\s\S]*?-->|<![^>]*>|<(script|style|textarea|title)\b(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*?<\/\1\s*>|<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi;

/** Adapt the desktop Parcel renderer without changing the stored HTML. */
export function projectStaticPreview(
  files: ProjectFiles,
  enabled = true,
): StaticPreviewProjection {
  const identity: StaticPreviewProjection = {
    files,
    restore: (_path, content) => content,
  };
  if (!enabled) return identity;
  const path = Object.keys(files).find(
    (name) => !name.includes("/") && name.toLowerCase() === "index.html",
  );
  if (!path) return identity;
  const source = files[path];
  const styles: string[] = [];
  let inHead = false;
  let templateDepth = 0;
  let bodyEnd: number | undefined;
  for (const match of source.matchAll(HTML_TOKEN)) {
    const token = match[0];
    const tag = (match[1] ?? match[2] ?? "").toLowerCase();
    const closing = token.startsWith("</");
    if (tag === "template") {
      templateDepth += closing ? -1 : 1;
      continue;
    }
    if (templateDepth > 0) continue;
    if (tag === "head") {
      inHead = !closing;
      continue;
    }
    if (tag === "body" && !closing) {
      // Parcel's special body extraction is only entered for this exact tag.
      // Attributed bodies and HTML fragments retain their existing handling.
      if (token !== "<body>") return identity;
      bodyEnd = match.index + token.length;
      break;
    }
    if (!inHead) continue;
    if (tag === "style") styles.push(token);
    if (tag === "link" && !closing) {
      const link = new DOMParser()
        .parseFromString(token, "text/html")
        .querySelector("link");
      if (link?.rel.toLowerCase().split(/\s+/).includes("stylesheet"))
        styles.push(token);
    }
  }
  if (bodyEnd === undefined) return identity;
  let marker = "open-builder-static-preview";
  while (source.includes(marker)) marker += "-";
  const start = `\n<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const block = `${start}\n${styles.join("\n")}\n${end}`;
  return {
    files: {
      ...files,
      [path]: source.slice(0, bodyEnd) + block + source.slice(bodyEnd),
    },
    restore(changedPath, content) {
      if (changedPath !== path) return content;
      const begin = content.indexOf(start);
      const finish = content.indexOf(end, begin < 0 ? 0 : begin + start.length);
      if (begin < 0 && finish < 0) return content;
      // An incomplete generated block is not a canonical source edit.
      if (begin < 0 || finish < 0) return undefined;
      return content.slice(0, begin) + content.slice(finish + end.length);
    },
  };
}
