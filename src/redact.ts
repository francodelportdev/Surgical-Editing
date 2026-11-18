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

const SECRET_SEGMENTS = new Set([
  "secret", "secrets", "token", "tokens", "password", "passwords", "passwd", "pwd", "pass", "passphrase", "pw",
  "credential", "credentials", "auth", "authorization", "bearer", "apikey", "accesskey", "privatekey", "secretkey",
]);
const SECRET_PAIRS = new Set(["api key", "access key", "private key", "secret key", "client secret"]);

/** Splits an identifier into lowercase words: apiKey, API_KEY and api-key all become ["api", "key"]. */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whole-word match, so author, tokenizer or sessionTimeout are not mistaken for secrets. */
export function isSecretKey(key: string): boolean {
  const words = keySegments(key);
  return words.some((w, i) => SECRET_SEGMENTS.has(w) || SECRET_PAIRS.has(`${w} ${words[i + 1]}`));
}

// A key and its operator (=, ==, ===, :, :=); the lookahead+backreference makes the key atomic, so matching stays linear.
const KEY_OPERATOR = /(?<![\w$.-])(["'`]?)(?=([A-Za-z_$][\w$.-]*))\2\1(?=([ \t]*))\3(:=|={1,3}|:)/g;
const QUOTES = new Set(['"', "'", "`"]);
const BARE_TERMINATORS = new Set([",", ";", "#", ")", "]", "}"]);
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const URL_CREDENTIALS = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
const KNOWN_TOKENS =
  /\b(?:A[KS]IA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|sk-[\w-]{20,}|AIza[\w-]{35}|npm_[A-Za-z0-9]{36}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})\b/g;
// Paths and dotted names split on "/" and ".", so they never form one long candidate.
const OPAQUE_CANDIDATE = /(?<![\w+=-])[\w+=-]{24,}(?![\w+=-])/g;
const INTEGRITY_HASH = /^sha(?:256|384|512)-/;

/** Random-looking: mixed case plus digits scattered in at least three runs; hex hashes and UUIDs have no mixed case. */
function looksOpaque(token: string): boolean {
  if (INTEGRITY_HASH.test(token)) return false;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token)) return false;
  return (token.match(/\d+/g)?.length ?? 0) >= 3;
}

/** End (exclusive) of the value starting at `start`: a whole quoted string, or bare text up to a terminator. */
function valueEnd(line: string, start: number): number {
  const quote = line[start]!;
  if (QUOTES.has(quote)) {
    for (let i = start + 1; i < line.length; i++) {
      if (line[i] === "\\") i++;
      else if (line[i] === quote) return i + 1;
    }
    return line.length;
  }
  let end = start;
  while (end < line.length && !BARE_TERMINATORS.has(line[end]!) && !line.startsWith("//", end)) end++;
  while (end > start && /\s/.test(line[end - 1]!)) end--;
  return end;
}

function redactAssignments(line: string): string {
  let out = "";
  let copied = 0;
  KEY_OPERATOR.lastIndex = 0;
  for (let m = KEY_OPERATOR.exec(line); m !== null; m = KEY_OPERATOR.exec(line)) {
    const [match, quote = "", key = ""] = m;
    let start = m.index + match.length;
    while (start < line.length && (line[start] === " " || line[start] === "\t")) start++;
    // A non-secret value may itself hold secrets (user=app&password=x), so scanning resumes right after its key.
    if (!isSecretKey(key) || start >= line.length || line[start] === "=" || BARE_TERMINATORS.has(line[start]!)) {
      KEY_OPERATOR.lastIndex = m.index + quote.length + key.length;
      continue;
    }
    const end = valueEnd(line, start);
    const opener = line[start]!;
    const closed = QUOTES.has(opener) && end - start >= 2 && line[end - 1] === opener;
    const value = QUOTES.has(opener) ? `${opener}${REDACTED}${closed ? opener : ""}` : REDACTED;
    out += line.slice(copied, start) + value;
    copied = end;
    KEY_OPERATOR.lastIndex = Math.max(end, KEY_OPERATOR.lastIndex);
  }
  return out + line.slice(copied);
}

/** Redacts likely secrets in one line of file content. */
export function redactLine(line: string): string {
  if (PEM.test(line)) return REDACTED;
  return redactAssignments(line)
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(URL_CREDENTIALS, (_m, prefix: string) => `${prefix}${REDACTED}@`)
    .replace(KNOWN_TOKENS, REDACTED)
    .replace(OPAQUE_CANDIDATE, (token) => (looksOpaque(token) ? REDACTED : token));
}

/** Applies a line redactor to every line of a snippet. */
export function redactSnippet(text: string, redact: LineRedactor): string {
  return text.split("\n").map(redact).join("\n");
}

/** True if the text carries the marker responses use for hidden values. */
export function containsRedactionMarker(text: string): boolean {
  return text.includes(REDACTED);
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
