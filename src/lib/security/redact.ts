/**
 * The one secret-redaction implementation shared by persisted chat text, the
 * permission activity log, and local CLI diagnostics. Pattern classes: PEM
 * private-key blocks, Bearer/Basic values, credential query parameters,
 * `key: value` pairs, and ENV-style assignments. Diagnostic forms add
 * `--token VALUE` flags and `API key VALUE` phrases; they stay off by default
 * because ordinary prose such as "token efficient" must survive.
 */
export interface RedactSecretsOptions {
  /** Replacement text; defaults to "[REDACTED]". */
  placeholder?: string;
  /** Hard length cap applied after redaction. */
  maxLength?: number;
  /** Also redact whitespace-delimited CLI flags and credential phrases. */
  diagnosticForms?: boolean;
}

export const DEFAULT_REDACTION_PLACEHOLDER = "[REDACTED]";

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const BEARER_OR_BASIC = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const QUERY_CREDENTIAL =
  /([?&](?:api[_-]?key|access[_-]?token|auth|key|password|secret|token)=)[^&#\s]*/gi;
// The lookahead keeps an already-handled "Authorization: Bearer …" intact.
const KEY_VALUE_CREDENTIAL =
  /((?:api[_ -]?key|access[_ -]?token|authorization|client[_ -]?secret|password|private[_ -]?key|secret|token)\s*[=:]\s*["']?)(?!(?:bearer|basic)\s)[^\s,"'\]}]+/gi;
const ENV_ASSIGNMENT =
  /^([A-Z_][A-Z0-9_]*(?:API_KEY|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)[A-Z0-9_]*)\s*=.*$/gim;
const CLI_FLAG_CREDENTIAL =
  /(--?(?:api[_-]?key|access[_-]?token|password|secret|token)\s+)[^\s,;]+/gi;
const CREDENTIAL_PHRASE = /((?:api[_ -]?key|access[_ -]?token)\s+)[^\s,;]+/gi;

export function redactSecrets(
  text: string,
  options: RedactSecretsOptions = {},
): string {
  const placeholder = options.placeholder ?? DEFAULT_REDACTION_PLACEHOLDER;
  let redacted = text
    .replace(PRIVATE_KEY_BLOCK, placeholder)
    .replace(BEARER_OR_BASIC, `$1 ${placeholder}`)
    .replace(QUERY_CREDENTIAL, `$1${placeholder}`)
    .replace(KEY_VALUE_CREDENTIAL, `$1${placeholder}`)
    .replace(ENV_ASSIGNMENT, `$1=${placeholder}`);
  if (options.diagnosticForms) {
    redacted = redacted
      .replace(CLI_FLAG_CREDENTIAL, `$1${placeholder}`)
      .replace(CREDENTIAL_PHRASE, `$1${placeholder}`);
  }
  return options.maxLength === undefined
    ? redacted
    : redacted.slice(0, options.maxLength);
}
