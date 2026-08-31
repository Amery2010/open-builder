import type { ProjectFiles } from "../../types";

const SAFE_ENV_TEMPLATE_NAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);
const AUTHORITY_FILE_NAMES = new Set(["agents.md", "claude.md", "design.md"]);
const PRIVATE_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "secrets.json",
  "service-account.json",
  "serviceaccount.json",
  "id_rsa",
  "id_dsa",
  "id_ed25519",
]);
const PRIVATE_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".crt",
  ".cer",
];
const PRIVATE_PATH_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
]);
const SERVER_PATH_SEGMENTS = new Set([
  "server",
  "backend",
  "functions",
  "supabase",
]);
const UNSAFE_PROJECT_PATH_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export const REDACTED_PROJECT_SECRET = "[REDACTED]";

const CREDENTIAL_KEY =
  "(?:client[_-]?secret|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|token)";
const QUOTED_CREDENTIAL_ASSIGNMENT = new RegExp(
  `(^|[\\s{\\[,])((?:["']${CREDENTIAL_KEY}["']|${CREDENTIAL_KEY})[ \\t]*[:=][ \\t]*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
  "gim",
);
const TEMPLATE_CREDENTIAL_ASSIGNMENT =
  /(^|[\s{[,])((?:client[_-]?secret|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|password)[ \t]*[:=][ \t]*)(`(?:\\.|[^`\\])*`)/gim;
const UNQUOTED_CREDENTIAL_ASSIGNMENT = new RegExp(
  `(^|[\\s{\\[,])((?:["']${CREDENTIAL_KEY}["']|${CREDENTIAL_KEY})[ \\t]*[:=][ \\t]*)([^\\s,}\\]]+)`,
  "gim",
);
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;

function isCredentialPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    !normalized ||
    normalized === REDACTED_PROJECT_SECRET.toLowerCase() ||
    /^(?:null|undefined|true|false|none)$/.test(normalized) ||
    /^(?:password|secret|token|api[_ -]?key|client[_ -]?secret|your(?:[_ -].*)?|example(?:[_ -].*)?|sample(?:[_ -].*)?|dummy(?:[_ -].*)?|fake(?:[_ -].*)?|placeholder(?:[_ -].*)?|change[_ -]?me|not[_ -]?set|x{3,}|\*{3,})$/.test(
      normalized,
    ) ||
    /^(?:\$\{|\{\{|<[^>]+>$)/.test(normalized) ||
    /^(?:process\.env|import\.meta\.env|deno\.env|bun\.env|os\.environ|env\b|getenv\s*\(|config\.|settings\.|secrets\.)/i.test(
      value.trim(),
    )
  );
}

function isHighConfidenceCredentialValue(
  value: string,
  allowExpressionReference: boolean,
): boolean {
  const candidate = value.trim();
  return (
    candidate.length >= 8 &&
    !isCredentialPlaceholder(candidate) &&
    (!allowExpressionReference ||
      (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(candidate) &&
        !/^[A-Za-z_$][\w$]*\s*\(/.test(candidate)))
  );
}

/**
 * Redact only high-confidence static credentials while preserving source-file
 * syntax and leaving the canonical project tree untouched. References such as
 * `process.env.API_KEY`, empty examples, and obvious placeholders are retained.
 */
export function redactProjectFileSecrets(content: string): string {
  const withoutPrivateKeys = content.replace(
    PRIVATE_KEY_BLOCK,
    REDACTED_PROJECT_SECRET,
  );
  const redactQuotedCredential = (
    match: string,
    boundary: string,
    prefix: string,
    literal: string,
  ): string => {
    const value = literal.slice(1, -1);
    if (!isHighConfidenceCredentialValue(value, false)) return match;
    const quote = literal[0];
    return `${boundary}${prefix}${quote}${REDACTED_PROJECT_SECRET}${quote}`;
  };
  const withoutQuotedCredentials = withoutPrivateKeys
    .replace(QUOTED_CREDENTIAL_ASSIGNMENT, redactQuotedCredential)
    .replace(TEMPLATE_CREDENTIAL_ASSIGNMENT, redactQuotedCredential);
  return withoutQuotedCredentials.replace(
    UNQUOTED_CREDENTIAL_ASSIGNMENT,
    (match, boundary: string, prefix: string, value: string) =>
      !/^["'`]/.test(value) && isHighConfidenceCredentialValue(value, true)
        ? `${boundary}${prefix}${REDACTED_PROJECT_SECRET}`
        : match,
  );
}

export function hasSensitiveProjectFileContent(content: string): boolean {
  return redactProjectFileSecrets(content) !== content;
}

export function hasUnsafeProjectPathCharacters(path: string): boolean {
  return UNSAFE_PROJECT_PATH_CHARACTERS.test(path);
}

function normalized(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/").toLowerCase();
}

function basename(path: string): string {
  const parts = normalized(path).split("/");
  return parts[parts.length - 1] ?? "";
}

export function isEnvironmentSecretPath(path: string): boolean {
  const name = basename(path);
  return name.startsWith(".env") && !SAFE_ENV_TEMPLATE_NAMES.has(name);
}

export function isAuthorityFilePath(path: string): boolean {
  const clean = normalized(path);
  return !clean.includes("/") && AUTHORITY_FILE_NAMES.has(clean);
}

export function isSensitiveProjectPath(path: string): boolean {
  const clean = normalized(path);
  const name = basename(clean);
  const segments = clean.split("/");
  return (
    isEnvironmentSecretPath(clean) ||
    PRIVATE_FILE_NAMES.has(name) ||
    PRIVATE_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
    segments.some((segment) => PRIVATE_PATH_SEGMENTS.has(segment)) ||
    /(?:^|[-_.])(secret|credentials?|private[-_.]?key)(?:[-_.]|$)/i.test(name)
  );
}

export interface PreviewFilePolicy {
  readonly allowedPublicEnvKeys?: ReadonlySet<string>;
  readonly includeServerFiles?: boolean;
}

export const DEFAULT_PREVIEW_FILE_POLICY: PreviewFilePolicy = Object.freeze({
  allowedPublicEnvKeys: new Set<string>(),
  includeServerFiles: false,
});

function projectPublicEnv(
  content: string,
  allowedKeys: ReadonlySet<string>,
): string {
  if (allowedKeys.size === 0) return "";
  return content
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return (
        !!match && match[1].startsWith("VITE_") && allowedKeys.has(match[1])
      );
    })
    .join("\n");
}

/** Canonical files remain untouched; model consumers receive a non-secret copy. */
export function projectFilesForModel(files: ProjectFiles): ProjectFiles {
  return Object.fromEntries(
    Object.entries(files)
      .filter(
        ([path]) =>
          !hasUnsafeProjectPathCharacters(path) &&
          !isSensitiveProjectPath(path),
      )
      .map(([path, content]) => [path, redactProjectFileSecrets(content)]),
  );
}

/** Sandpack receives only browser-safe files and explicitly allowed public env. */
export function projectFilesForPreview(
  files: ProjectFiles,
  policy: PreviewFilePolicy = DEFAULT_PREVIEW_FILE_POLICY,
): ProjectFiles {
  const allowedPublicEnvKeys = policy.allowedPublicEnvKeys ?? new Set<string>();
  const projected: ProjectFiles = {};
  for (const [path, content] of Object.entries(files)) {
    if (hasUnsafeProjectPathCharacters(path)) continue;
    if (isEnvironmentSecretPath(path)) {
      const publicEnv = projectPublicEnv(content, allowedPublicEnvKeys);
      if (publicEnv) projected[path] = publicEnv;
      continue;
    }
    if (isSensitiveProjectPath(path) || isAuthorityFilePath(path)) continue;
    const segments = normalized(path).split("/");
    if (
      !policy.includeServerFiles &&
      segments.some((segment) => SERVER_PATH_SEGMENTS.has(segment))
    ) {
      continue;
    }
    projected[path] = redactProjectFileSecrets(content);
  }
  return projected;
}

export function pickSensitiveProjectFiles(files: ProjectFiles): ProjectFiles {
  return Object.fromEntries(
    Object.entries(files).filter(
      ([path, content]) =>
        isSensitiveProjectPath(path) || hasSensitiveProjectFileContent(content),
    ),
  );
}
