// Best-effort secret redaction for everything the server returns; see README "Secrets in responses".
import path from "node:path";

const SENSITIVE_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.?(npmrc|pypirc|netrc|pgpass|git-credentials|htpasswd)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg|kdbx)$/i,
  /^(credentials|secrets?)(\.[a-z]+)?$/i,
];
const SENSITIVE_DIRS = new Set([".ssh", ".gnupg", ".aws", ".docker", ".kube"]);

/** True for files whose content must never appear in diagnostics. */
export function isSensitivePath(filePath: string): boolean {
  const base = path.basename(filePath);
  if (SENSITIVE_NAMES.some((re) => re.test(base))) return true;
  return filePath.split(/[\\/]/).some((part) => SENSITIVE_DIRS.has(part));
}

export const REDACTED = "[REDACTED]";

const KEY_WORDS = "(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|session|cookie|bearer)";
// key = value / key: value / "key": "value", value redacted up to a delimiter.
const ASSIGNMENT = new RegExp(`(${`[\\w.-]*${KEY_WORDS}[\\w.-]*`}["']?\\s*[:=]\\s*)(["']?)([^\\s"',;]+)`, "gi");
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
// Long opaque tokens (API keys, JWTs, hashes). Requires a digit and a letter
// so ordinary long identifiers are left alone.
const OPAQUE = /\b(?=[A-Za-z0-9_\-+/=.]*\d)(?=[A-Za-z0-9_\-+/=.]*[A-Za-z])[A-Za-z0-9_\-+/=.]{24,}\b/g;

/** Redacts likely secrets in one line of file content. */
export function redactLine(line: string): string {
  if (PEM.test(line)) return REDACTED;
  return line
    .replace(ASSIGNMENT, (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}`)
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(URL_CREDENTIALS, (_m, prefix: string) => `${prefix}${REDACTED}@`)
    .replace(OPAQUE, REDACTED);
}

export function redactText(text: string): string {
  return text.split("\n").map(redactLine).join("\n");
}

const KEY_VALUE = /^(\s*(?:export\s+)?["']?[\w.-]+["']?\s*[:=]\s*)(.*)$/;
const SECTION_HEADER = /^\s*\[[^\]]*\]\s*$/;

/** For sensitive files: keeps keys and structure, hides every value and any other content. */
export function maskValues(line: string): string {
  if (line.trim() === "" || SECTION_HEADER.test(line)) return line;
  const match = KEY_VALUE.exec(line);
  if (match === null) return REDACTED;
  return match[2]!.trim() === "" ? match[1]! : `${match[1]!}${REDACTED}`;
}

export type LineRedactor = (line: string) => string;

export function redactorFor(filePath: string): LineRedactor {
  return isSensitivePath(filePath) ? maskValues : redactLine;
}

/** Caps a message at `max` characters, marking the cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = " …[truncated]";
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}
