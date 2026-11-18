import { randomBytes } from "node:crypto";
// Accessed as `fs.*` (not destructured) so tests can intercept calls with mock.method.
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LIMITS, type Limits } from "./config.js";
import { unifiedDiff } from "./diff.js";
import { LineIndex, summarizeOccurrences } from "./lines.js";
import { findClosestMatch } from "./matcher.js";
import {
  containsRedactionMarker,
  isSensitivePath,
  REDACTED,
  redactorFor,
  redactSnippet,
  redactText,
  truncate,
  type LineRedactor,
} from "./redact.js";

export interface Replacement {
  find: string;
  replace: string;
}

export interface Operation {
  file_path: string;
  replacements: readonly Replacement[];
}

export interface TransactionOptions {
  dryRun?: boolean;
  /**
   * Sandbox root. When set, relative paths resolve against it and every
   * target must stay inside it, both before and after following symlinks.
   */
  rootDir?: string;
  /** Required instead of `rootDir` to run without a sandbox. */
  unsafeNoRoot?: boolean;
  /** Resource limits; unspecified fields use DEFAULT_LIMITS. */
  limits?: Partial<Limits>;
}

export interface AppliedReplacement {
  /** Index of the operation this replacement belongs to. */
  operation: number;
  index: number;
  find: string;
  replace: string;
  /** 1-based line where the replaced text starts in the final content. */
  line: number;
  /**
   * The edited region plus surrounding lines from the final content, numbered,
   * so the agent can verify the result without re-reading the file.
   */
  context: string;
}

export interface FileChange {
  filePath: string;
  applied: AppliedReplacement[];
  /** Unified diff of the change; "" when the replacements were no-ops. */
  diff: string;
}

export type TransactionResult =
  | { ok: true; dryRun: boolean; files: FileChange[] }
  | { ok: false; error: string };

/** v1 single-file result, kept for backward compatibility. */
export type SurgicalResult =
  | { ok: true; filePath: string; applied: AppliedReplacement[] }
  | { ok: false; error: string };

interface FileState {
  /** Physical path after resolving symlinks; all I/O uses this. */
  filePath: string;
  /** Exact bytes read from disk, used to restore the file on a failed commit. */
  originalBytes: Buffer;
  original: string;
  content: string;
  hasBom: boolean;
  mode: number;
  mtimeMs: number;
  size: number;
  /** Identity of the file and its directory when read; any swap before the rename aborts the commit. */
  identity: FileIdentity;
  applied: AppliedReplacement[];
  /** Offsets of each applied replacement in `content`, parallel to `applied`. */
  spans: Span[];
}

interface Span {
  start: number;
  end: number;
}

interface Inode {
  dev: number;
  ino: number;
}

interface FileIdentity {
  file: Inode;
  directory: Inode;
}

/** Root canonicalized once per transaction, so every operation and the final checks use the same one. */
interface Sandbox {
  rootDir: string;
  realRoot: string;
}

// Refuses to open a symlink as the final path component; Windows has no equivalent flag, see README.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

class CommitAborted extends Error {}

const NOTHING_WRITTEN = "No files were written.";
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NOT_UTF8 = "File is not valid UTF-8 or is binary. Surgical editing aborted to prevent corruption.";
// fatal: invalid byte sequences throw instead of silently becoming U+FFFD,
// which would then be written back and destroy the original bytes.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const CONTEXT_LINES = 1;
const MAX_CONTEXT_REGION_LINES = 10;
const MAX_LISTED_LINES = 10;

/** Counts overlapping occurrences: "aa" appears twice in "aaa", which is a real ambiguity. */
export function countOccurrences(haystack: string, needle: string): number {
  return summarizeOccurrences(haystack, needle, 0).count;
}

/**
 * Numbered excerpt of `content` covering [start, end) plus CONTEXT_LINES on
 * each side. Large regions keep only their head and tail: the agent already
 * knows the text it sent, it only needs to see the seams.
 */
function contextAround(lines: readonly string[], index: LineIndex, span: Span, redact: LineRedactor): string {
  const firstLine = index.lineAt(span.start);
  const lastLine = index.lineAt(Math.max(span.start, span.end - 1));
  const from = Math.max(1, firstLine - CONTEXT_LINES);
  const to = Math.min(lines.length, lastLine + CONTEXT_LINES);
  const width = String(to).length;
  const fmt = (n: number): string => `${String(n).padStart(width)} | ${redact(lines[n - 1]!.replace(/\r$/, ""))}`;

  const numbers: number[] = [];
  for (let n = from; n <= to; n++) numbers.push(n);
  if (numbers.length <= MAX_CONTEXT_REGION_LINES) return numbers.map(fmt).join("\n");

  const half = MAX_CONTEXT_REGION_LINES / 2;
  return [...numbers.slice(0, half).map(fmt), `${" ".repeat(width)} | …`, ...numbers.slice(-half).map(fmt)].join("\n");
}

function preview(text: string, max = 80): string {
  const oneLine = JSON.stringify(text);
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…"` : oneLine;
}

function describeFsError(err: unknown, action: string, filePath: string): string {
  const code = err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : undefined;
  switch (code) {
    case "ENOENT":
      return `File not found: ${filePath}`;
    case "EACCES":
    case "EPERM":
      return `Permission denied while trying to ${action} ${filePath}`;
    case "EISDIR":
      return `Path is a directory, not a file: ${filePath}`;
    case "EROFS":
      return `Read-only file system, cannot ${action} ${filePath}`;
    case "ELOOP":
      return pathChangedMessage(filePath, "it was replaced by a symlink");
    default: {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to ${action} ${filePath}: ${msg}`;
    }
  }
}

/**
 * True if `target` is `root` or lies beneath it. Uses path.relative instead
 * of a string prefix check, which would wrongly accept "/srv/app-evil" for
 * the root "/srv/app".
 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function encode(state: FileState): Buffer {
  const body = Buffer.from(state.content, "utf8");
  return state.hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
}

/**
 * Resolves the requested path to the physical file that will be edited,
 * enforcing the sandbox. Returns an error message on failure.
 */
async function openSandbox(rootDir: string): Promise<Sandbox | string> {
  try {
    return { rootDir, realRoot: await fs.realpath(rootDir) };
  } catch {
    return `Sandbox root is not accessible: ${rootDir}`;
  }
}

async function resolveTarget(rawPath: string, sandbox: Sandbox | undefined): Promise<string | { path: string }> {
  if (sandbox === undefined) return resolveUnsandboxed(path.resolve(rawPath));

  const { rootDir, realRoot } = sandbox;
  const requested = path.resolve(rootDir, rawPath);
  // Accept either spelling of the root (e.g. /var vs /private/var); the realpath check below is authoritative.
  if (!isInside(path.resolve(rootDir), requested) && !isInside(realRoot, requested)) {
    return `Path traversal blocked: ${requested} is outside SURGICAL_ROOT_DIR (${rootDir})`;
  }

  // Follow symlinks so the temp file + rename replaces the real file instead of the link.
  let real: string;
  try {
    real = await fs.realpath(requested);
  } catch (err) {
    return describeFsError(err, "read", requested);
  }
  // Don't echo `real`: it would disclose where outside the root the link points.
  if (!isInside(realRoot, real)) {
    return `Path traversal blocked: ${requested} is a symlink that resolves outside SURGICAL_ROOT_DIR (${rootDir})`;
  }
  return { path: real };
}

async function resolveUnsandboxed(requested: string): Promise<string | { path: string }> {
  try {
    return { path: await fs.realpath(requested) };
  } catch (err) {
    return describeFsError(err, "read", requested);
  }
}

function pathChangedMessage(filePath: string, detail: string): string {
  return `Path changed during the transaction: ${filePath} (${detail}). Transaction aborted for safety.`;
}

const sameInode = (a: Inode, b: Inode): boolean => a.dev === b.dev && a.ino === b.ino;

/** The directory must still be itself (no symlink swapped into its path) and, when sandboxed, inside the root. */
async function directoryIdentity(directory: string, sandbox: Sandbox | undefined): Promise<Inode | string> {
  try {
    if ((await fs.realpath(directory)) !== directory) return pathChangedMessage(directory, "a directory in its path was replaced");
    if (sandbox !== undefined) {
      if ((await fs.realpath(sandbox.rootDir)) !== sandbox.realRoot) return pathChangedMessage(sandbox.rootDir, "the sandbox root moved");
      if (!isInside(sandbox.realRoot, directory)) return pathChangedMessage(directory, "it is no longer inside the sandbox");
    }
    const info = await fs.lstat(directory);
    return { dev: info.dev, ino: info.ino };
  } catch (err) {
    return pathChangedMessage(directory, describeFsError(err, "re-check", directory));
  }
}

async function directoryUnchanged(state: FileState, sandbox: Sandbox | undefined): Promise<boolean> {
  const directory = await directoryIdentity(path.dirname(state.filePath), sandbox);
  return typeof directory !== "string" && sameInode(directory, state.identity.directory);
}

/** Confirms the path still names the very file and directory that were read. */
async function verifyIdentity(state: FileState, sandbox: Sandbox | undefined): Promise<string | undefined> {
  const directory = await directoryIdentity(path.dirname(state.filePath), sandbox);
  if (typeof directory === "string") return directory;
  if (!sameInode(directory, state.identity.directory)) return pathChangedMessage(state.filePath, "its directory was replaced");
  try {
    const info = await fs.lstat(state.filePath);
    if (info.isSymbolicLink()) return pathChangedMessage(state.filePath, "it was replaced by a symlink");
    if (!info.isFile() || !sameInode(info, state.identity.file)) return pathChangedMessage(state.filePath, "it was replaced by another file");
  } catch (err) {
    return pathChangedMessage(state.filePath, describeFsError(err, "re-check", state.filePath));
  }
  return undefined;
}

async function loadFile(filePath: string, maxFileBytes: number, sandbox: Sandbox | undefined): Promise<FileState | string> {
  let bytes: Buffer;
  let info: Awaited<ReturnType<typeof fs.stat>>;
  let file: Inode;
  try {
    info = await fs.stat(filePath);
    if (!info.isFile()) return `Not a regular file: ${filePath}`;
    // Checked before reading so an oversized file is never loaded into memory.
    if (info.size > maxFileBytes) {
      return `File is ${info.size} bytes, above the ${maxFileBytes}-byte limit (SURGICAL_MAX_FILE_BYTES).`;
    }
    const handle = await fs.open(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!sameInode(opened, info)) return pathChangedMessage(filePath, "it was replaced while being opened");
      file = { dev: opened.dev, ino: opened.ino };
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (err) {
    return describeFsError(err, "read", filePath);
  }
  // Checked after reading: a directory swapped in before the open would have made us read another file.
  const directory = await directoryIdentity(path.dirname(filePath), sandbox);
  if (typeof directory === "string") return directory;

  const hasBom = bytes.subarray(0, 3).equals(UTF8_BOM);
  const body = hasBom ? bytes.subarray(3) : bytes;
  let original: string;
  try {
    original = strictUtf8.decode(body);
  } catch {
    return NOT_UTF8;
  }
  // NUL is valid UTF-8 but never appears in text files; treat it as binary.
  if (original.includes("\0")) return NOT_UTF8;

  return {
    filePath,
    originalBytes: bytes,
    original,
    content: original,
    hasBom,
    mode: info.mode,
    mtimeMs: info.mtimeMs,
    size: info.size,
    identity: { file, directory },
    applied: [],
    spans: [],
  };
}

function notFoundMessage(content: string, find: string, filePath: string): string {
  // Before giving up, point the agent at the closest region so it can correct
  // its snippet without another full read of the file.
  const closest = findClosestMatch(content, find);
  if (closest) {
    const pct = Math.round(closest.similarity * 100);
    const hint = closest.hint ? ` Hint: ${closest.hint}` : "";
    // The excerpt is file content the agent didn't send: never show it for
    // credential files, and redact likely secrets everywhere else.
    if (isSensitivePath(filePath)) {
      return `No exact match found. Line ${closest.line} is ${pct}% similar (content hidden: sensitive file).${hint}`;
    }
    return `No exact match found. Line ${closest.line} contains (${pct}% similar): '${redactText(closest.text)}'.${hint}`;
  }
  return (
    `"find" text ${preview(redactSnippet(find, redactorFor(filePath)))} was not found. It must match the file exactly ` +
    `(whitespace, indentation and line endings included). Re-read the file and retry.`
  );
}

/** Says how often and on which lines `find` occurs, so the agent knows which context to add. */
function ambiguityMessage(content: string, find: string, filePath: string): string {
  const { count, distinctLines, listedLines } = summarizeOccurrences(content, find, MAX_LISTED_LINES);
  const more = distinctLines > MAX_LISTED_LINES ? `, … +${distinctLines - MAX_LISTED_LINES} more` : "";
  return (
    `"find" text ${preview(redactSnippet(find, redactorFor(filePath)))} is ambiguous — it appears ${count} times ` +
    `(line${distinctLines > 1 ? "s" : ""} ${listedLines.join(", ")}${more}). ` +
    `Include more surrounding context so it matches exactly once.`
  );
}

/**
 * Applies one replacement to the in-memory state, or returns why it can't be
 * applied. Never touches disk.
 */
function applyReplacement(state: FileState, operation: number, index: number, r: Replacement): string | undefined {
  // An empty `find` would match everywhere; reject it rather than guess.
  if (r.find.length === 0) return `"find" must not be empty.`;

  // Uniqueness is the core safety guarantee: if the LLM's snippet is
  // ambiguous we cannot know which occurrence it meant, and guessing could
  // silently corrupt the file.
  const offset = state.content.indexOf(r.find);
  if (offset === -1) return notFoundMessage(state.content, r.find, state.filePath);
  if (state.content.indexOf(r.find, offset + 1) !== -1) return ambiguityMessage(state.content, r.find, state.filePath);

  const findEnd = offset + r.find.length;
  const delta = r.replace.length - r.find.length;
  // Splice by offset instead of String.prototype.replace so that "$&", "$1"
  // etc. in `replace` are inserted literally rather than as patterns.
  state.content = state.content.slice(0, offset) + r.replace + state.content.slice(findEnd);

  // Keep earlier spans pointing at their text in the new content: shift the
  // ones after this edit, and grow any span this edit overlapped.
  for (const span of state.spans) {
    if (span.start >= findEnd) {
      span.start += delta;
      span.end += delta;
    } else if (span.end > offset) {
      span.start = Math.min(span.start, offset);
      span.end = Math.max(span.end + delta, offset + r.replace.length);
    }
  }
  state.spans.push({ start: offset, end: offset + r.replace.length });
  // line/context are filled from the final content once all edits are applied.
  state.applied.push({ operation, index, find: r.find, replace: r.replace, line: 0, context: "" });
  return undefined;
}

/** Fills line numbers and context for every applied replacement from the final content. */
function finalizeApplied(state: FileState): void {
  const redact = redactorFor(state.filePath);
  const lines = state.content.split("\n");
  const index = new LineIndex(state.content);
  for (const [i, applied] of state.applied.entries()) {
    const span = state.spans[i]!;
    applied.line = index.lineAt(span.start);
    applied.context = contextAround(lines, index, span, redact);
  }
}

function tempPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
}

/** Flushes the temp file's data and returns its inode, so a crash after the rename can't leave the target empty. */
async function syncTemp(tmp: string): Promise<Inode> {
  const handle = await fs.open(tmp, fs.constants.O_RDWR | O_NOFOLLOW);
  try {
    await handle.sync();
    const info = await handle.stat();
    return { dev: info.dev, ino: info.ino };
  } finally {
    await handle.close();
  }
}

/** Persists the renames done in each directory; best-effort because Windows and some filesystems can't fsync one. */
async function syncDirectories(filePaths: readonly string[]): Promise<void> {
  for (const directory of new Set(filePaths.map((p) => path.dirname(p)))) {
    try {
      const handle = await fs.open(directory, fs.constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // The files are already renamed: a failed directory flush can't be undone, only skipped.
    }
  }
}

function concurrentModification(filePath: string): string {
  return `Concurrent modification detected on ${filePath}. Transaction aborted for safety.`;
}

/** Detects changes by anyone else since the read: identity, then mtime and size, then (optionally) the bytes themselves. */
async function findConcurrentModification(
  state: FileState,
  sandbox: Sandbox | undefined,
  compareContent: boolean,
): Promise<string | undefined> {
  const changed = await verifyIdentity(state, sandbox);
  if (changed !== undefined) return changed;
  try {
    const now = await fs.stat(state.filePath);
    // Size as well as mtime, because some filesystems store mtime at 1–2 s resolution.
    if (now.mtimeMs !== state.mtimeMs || now.size !== state.size) return concurrentModification(state.filePath);
    // The bytes too: rsync -t, cp -p or tar can rewrite a file keeping its size and mtime.
    if (compareContent && !(await fs.readFile(state.filePath)).equals(state.originalBytes)) {
      return concurrentModification(state.filePath);
    }
  } catch (err) {
    return `${describeFsError(err, "re-check", state.filePath)}. Transaction aborted for safety.`;
  }
  return undefined;
}

interface StagedFile {
  state: FileState;
  tmp: string;
  /** Inode of the temp file, which becomes the target's inode once renamed into place. */
  inode?: Inode;
}

type RestoreOutcome = "restored" | "changed" | "failed";

/** Puts the original bytes back atomically, but only if the file is still exactly what this transaction wrote. */
async function restoreOriginal({ state, inode }: StagedFile, sandbox: Sandbox | undefined): Promise<RestoreOutcome> {
  try {
    if (!(await directoryUnchanged(state, sandbox))) return "failed";
    const current = await fs.lstat(state.filePath);
    if (current.isSymbolicLink() || inode === undefined || !sameInode(current, inode)) return "changed";
    if (!(await fs.readFile(state.filePath)).equals(encode(state))) return "changed";
    const tmp = tempPathFor(state.filePath);
    try {
      await fs.writeFile(tmp, state.originalBytes, { mode: state.mode, flag: "wx" });
      await fs.chmod(tmp, state.mode & 0o7777);
      await syncTemp(tmp);
      await fs.rename(tmp, state.filePath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
    return "restored";
  } catch {
    return "failed";
  }
}

function rollbackNote(outcomes: readonly [string, RestoreOutcome][]): string {
  const pick = (kind: RestoreOutcome): string[] => outcomes.filter(([, o]) => o === kind).map(([p]) => p);
  const [restored, changed, failed] = [pick("restored"), pick("changed"), pick("failed")];
  let note = "";
  if (failed.length > 0) note += ` WARNING: could not restore ${failed.join(", ")}; these files contain the new content.`;
  if (changed.length > 0) {
    note += ` WARNING: ${changed.join(", ")} changed again after being replaced, so they were left as they are instead of being restored; check them.`;
  }
  if (restored.length > 0) {
    note += failed.length + changed.length === 0 ? " Files already updated were restored to their original content." : ` Restored: ${restored.join(", ")}.`;
  }
  return note;
}

/**
 * Two-phase commit: stage every new version as a temp file next to its target (where most I/O errors surface while
 * the originals are untouched), check nothing changed, then rename each into place, rolling back on failure.
 */
async function commit(states: readonly FileState[], sandbox: Sandbox | undefined): Promise<string | undefined> {
  const staged: StagedFile[] = [];
  const leftBehind: string[] = [];
  const discardTemps = (from = 0): Promise<unknown> =>
    Promise.all(
      staged.slice(from).map(async ({ state, tmp, inode }) => {
        // Unlink only what is provably our temp file: after a swap the same name may resolve somewhere else.
        const current = await fs.lstat(tmp).catch(() => undefined);
        const ours = inode !== undefined ? current !== undefined && sameInode(current, inode) : await directoryUnchanged(state, sandbox);
        if (ours) await fs.unlink(tmp).catch(() => undefined);
        else if (inode !== undefined) leftBehind.push(tmp);
      }),
    );
  const withLeftovers = (message: string): string =>
    leftBehind.length === 0
      ? message
      : `${message} Temp files were left in place because their directory was moved: ${leftBehind.map((t) => path.basename(t)).join(", ")}.`;

  for (const state of states) {
    // Registered before writing: a failed write can still leave a partial file to clean up.
    const entry: StagedFile = { state, tmp: tempPathFor(state.filePath) };
    staged.push(entry);
    try {
      // "wx" never follows or reuses an existing path, even one planted with this random name.
      await fs.writeFile(entry.tmp, encode(state), { mode: state.mode, flag: "wx" });
      // The creation mode is filtered by the umask; chmod restores the exact bits, setuid/setgid/sticky included.
      await fs.chmod(entry.tmp, state.mode & 0o7777);
      entry.inode = await syncTemp(entry.tmp);
    } catch (err) {
      await discardTemps();
      return withLeftovers(describeFsError(err, "write", state.filePath));
    }
  }

  for (const state of states) {
    const conflict = await findConcurrentModification(state, sandbox, true);
    if (conflict !== undefined) {
      await discardTemps();
      return withLeftovers(conflict);
    }
  }

  const swapped: StagedFile[] = [];
  for (const [i, entry] of staged.entries()) {
    try {
      // Re-checked right before each rename to keep the race window as small as Node allows.
      const conflict = await findConcurrentModification(entry.state, sandbox, false);
      if (conflict !== undefined) throw new CommitAborted(conflict);
      await fs.rename(entry.tmp, entry.state.filePath);
      swapped.push(entry);
    } catch (err) {
      await discardTemps(i);
      const outcomes: [string, RestoreOutcome][] = [];
      for (const done of swapped) outcomes.push([done.state.filePath, await restoreOriginal(done, sandbox)]);
      await syncDirectories(swapped.map((done) => done.state.filePath));
      const reason = err instanceof CommitAborted ? err.message : `${describeFsError(err, "write", entry.state.filePath)}.`;
      return withLeftovers(`${reason}${rollbackNote(outcomes)}`);
    }
  }
  await syncDirectories(states.map((state) => state.filePath));
  return undefined;
}

/**
 * Runs all operations as a single transaction: every file is read once, every
 * replacement is validated and applied in memory, and only if all of them
 * succeed are the files written (or, with `dryRun`, diffed without writing).
 */
export async function surgicalTransaction(
  operations: readonly Operation[],
  options: TransactionOptions = {},
): Promise<TransactionResult> {
  const limits = normalizeLimits(options.limits);
  if (typeof limits === "string") {
    return { ok: false, error: capDiagnostic(`${limits} ${NOTHING_WRITTEN}`, DEFAULT_LIMITS.maxDiagnosticChars) };
  }
  const sandboxError = checkSandboxOptions(options);
  if (sandboxError !== undefined) return { ok: false, error: `${sandboxError} ${NOTHING_WRITTEN}` };
  const result = await runTransaction(operations, options, limits);
  if (result.ok) return result;
  return { ok: false, error: capDiagnostic(result.error, limits.maxDiagnosticChars) };
}

/** Fills omitted limits with defaults; rejects anything that is not a non-negative safe integer. */
export function normalizeLimits(overrides: Partial<Limits> | undefined): Limits | string {
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value: unknown = overrides?.[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return `Invalid limit ${key}: ${String(value)} (expected a non-negative integer).`;
    }
    limits[key] = value;
  }
  return limits;
}

function checkSandboxOptions(options: TransactionOptions): string | undefined {
  if (options.rootDir !== undefined && options.unsafeNoRoot === true) {
    return "rootDir and unsafeNoRoot are mutually exclusive.";
  }
  if (options.rootDir === undefined && options.unsafeNoRoot !== true) {
    return "No sandbox: pass rootDir, or unsafeNoRoot: true to edit without one.";
  }
  return undefined;
}

/** Caps an error message while keeping the "No files were written." guarantee visible. */
function capDiagnostic(error: string, max: number): string {
  if (error.length <= max) return error;
  if (error.endsWith(NOTHING_WRITTEN)) {
    const head = error.slice(0, error.length - NOTHING_WRITTEN.length).trimEnd();
    return `${truncate(head, Math.max(0, max - NOTHING_WRITTEN.length - 1))} ${NOTHING_WRITTEN}`;
  }
  return truncate(error, max);
}

function workBudgetMessage(work: number, limits: Limits): string {
  return (
    `Transaction too expensive: each replacement scans its whole file, so it needs ~${work} characters of work, ` +
    `above the budget of ${limits.maxWorkChars} (SURGICAL_MAX_WORK_CHARS). ` +
    `Use fewer, larger replacements per large file, or split the change into several transactions.`
  );
}

// Tail of each file's lock queue: transactions on the same physical file run one at a time within this process.
const fileLocks = new Map<string, Promise<void>>();

/** Locks every path in sorted order, so two transactions can never wait on each other in a cycle. */
async function lockFiles(paths: readonly string[]): Promise<() => void> {
  const releases: (() => void)[] = [];
  for (const filePath of [...new Set(paths)].sort()) {
    const previous = fileLocks.get(filePath) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => held);
    fileLocks.set(filePath, tail);
    await previous;
    releases.push(() => {
      release();
      if (fileLocks.get(filePath) === tail) fileLocks.delete(filePath);
    });
  }
  return () => releases.forEach((release) => release());
}

/** Number of files with a held or queued lock; exposed so tests can check locks are always released. */
export function pendingFileLocks(): number {
  return fileLocks.size;
}

/** Rejects edits that would copy a redacted response back into a file. */
function checkRedactionMarker(operations: readonly Operation[]): string | undefined {
  for (const [opIndex, op] of operations.entries()) {
    for (const [index, r] of op.replacements.entries()) {
      const field = containsRedactionMarker(r.find) ? "find" : containsRedactionMarker(r.replace) ? "replace" : undefined;
      if (field === undefined) continue;
      return (
        `Operation #${opIndex}, Replacement #${index}: "${field}" contains ${REDACTED}, the marker this server uses to hide secrets ` +
        `in its responses; it is not the file's real text. Use the real value, or ask the user for it.`
      );
    }
  }
  return undefined;
}

/** Rejects oversized requests before any file is touched. */
function checkRequestLimits(operations: readonly Operation[], limits: Limits): string | undefined {
  if (operations.length > limits.maxOperations) {
    return `Too many operations: ${operations.length}, limit is ${limits.maxOperations} (SURGICAL_MAX_OPERATIONS). Split the change into smaller transactions.`;
  }
  let total = 0;
  for (const [opIndex, op] of operations.entries()) {
    total += op.replacements.length;
    if (total > limits.maxReplacements) {
      return `Too many replacements: more than ${limits.maxReplacements} in one transaction (SURGICAL_MAX_REPLACEMENTS).`;
    }
    for (const [index, r] of op.replacements.entries()) {
      if (r.find.length > limits.maxFindChars) {
        return `Operation #${opIndex}, Replacement #${index}: "find" is ${r.find.length} characters, limit is ${limits.maxFindChars} (SURGICAL_MAX_FIND_CHARS).`;
      }
      if (r.replace.length > limits.maxReplaceChars) {
        return `Operation #${opIndex}, Replacement #${index}: "replace" is ${r.replace.length} characters, limit is ${limits.maxReplaceChars} (SURGICAL_MAX_REPLACE_CHARS).`;
      }
    }
  }
  return undefined;
}

async function runTransaction(
  operations: readonly Operation[],
  options: TransactionOptions,
  limits: Limits,
): Promise<TransactionResult> {
  const dryRun = options.dryRun ?? false;
  if (operations.length === 0) return { ok: false, error: `No operations provided. ${NOTHING_WRITTEN}` };
  const limitError = checkRequestLimits(operations, limits) ?? checkRedactionMarker(operations);
  if (limitError !== undefined) return { ok: false, error: `${limitError} ${NOTHING_WRITTEN}` };

  const sandbox = options.rootDir === undefined ? undefined : await openSandbox(options.rootDir);
  if (typeof sandbox === "string") return { ok: false, error: `${sandbox}. ${NOTHING_WRITTEN}` };

  const resolved: string[] = [];
  for (const [opIndex, op] of operations.entries()) {
    const target = await resolveTarget(op.file_path, sandbox);
    if (typeof target === "string") {
      return { ok: false, error: `Operation #${opIndex}: ${target}. ${NOTHING_WRITTEN}` };
    }
    resolved.push(target.path);
  }

  const release = await lockFiles(resolved);
  try {
    return await loadApplyCommit(operations, resolved, limits, dryRun, sandbox);
  } finally {
    release();
  }
}

async function loadApplyCommit(
  operations: readonly Operation[],
  resolved: readonly string[],
  limits: Limits,
  dryRun: boolean,
  sandbox: Sandbox | undefined,
): Promise<TransactionResult> {
  // Keyed by physical path so operations reaching one file through different paths compose sequentially.
  const files = new Map<string, FileState>();
  for (const [opIndex, filePath] of resolved.entries()) {
    if (files.has(filePath)) continue;
    const loaded = await loadFile(filePath, limits.maxFileBytes, sandbox);
    if (typeof loaded === "string") {
      return { ok: false, error: `Operation #${opIndex} (${filePath}): ${loaded} ${NOTHING_WRITTEN}` };
    }
    files.set(filePath, loaded);
  }

  const estimatedWork = operations.reduce(
    (sum, op, opIndex) => sum + op.replacements.length * files.get(resolved[opIndex]!)!.content.length,
    0,
  );
  if (estimatedWork > limits.maxWorkChars) return { ok: false, error: `${workBudgetMessage(estimatedWork, limits)} ${NOTHING_WRITTEN}` };

  let work = 0;
  for (const [opIndex, op] of operations.entries()) {
    const state = files.get(resolved[opIndex]!)!;
    if (op.replacements.length === 0) {
      return { ok: false, error: `Operation #${opIndex} (${state.filePath}): no replacements provided. ${NOTHING_WRITTEN}` };
    }
    for (const [index, replacement] of op.replacements.entries()) {
      work += state.content.length;
      if (work > limits.maxWorkChars) return { ok: false, error: `${workBudgetMessage(work, limits)} ${NOTHING_WRITTEN}` };
      const error = applyReplacement(state, opIndex, index, replacement);
      if (error !== undefined) {
        return {
          ok: false,
          error: `Operation #${opIndex}, Replacement #${index} (${state.filePath}): ${error} ${NOTHING_WRITTEN}`,
        };
      }
    }
  }

  const states = [...files.values()];
  for (const state of states) {
    const size = encode(state).length;
    if (size > limits.maxFileBytes) {
      return {
        ok: false,
        error: `${state.filePath}: the edited file would be ${size} bytes, above the ${limits.maxFileBytes}-byte limit (SURGICAL_MAX_FILE_BYTES). ${NOTHING_WRITTEN}`,
      };
    }
  }
  states.forEach(finalizeApplied);
  const changes: FileChange[] = states.map((s) => ({
    filePath: s.filePath,
    applied: s.applied,
    diff: unifiedDiff(s.original, s.content, s.filePath, undefined, redactorFor(s.filePath)),
  }));

  if (!dryRun) {
    const error = await commit(states.filter((s) => s.content !== s.original), sandbox);
    if (error !== undefined) return { ok: false, error };
  }

  return { ok: true, dryRun, files: changes };
}

/** v1 API: a single-file transaction. */
export async function surgicalReplace(
  rawPath: string,
  replacements: readonly Replacement[],
  options: Omit<TransactionOptions, "dryRun"> = {},
): Promise<SurgicalResult> {
  const result = await surgicalTransaction([{ file_path: rawPath, replacements }], options);
  if (!result.ok) return result;
  const file = result.files[0]!;
  return { ok: true, filePath: file.filePath, applied: file.applied };
}

export function formatTransaction(result: Extract<TransactionResult, { ok: true }>): string {
  const total = result.files.reduce((n, f) => n + f.applied.length, 0);
  const summary = `${total} replacement(s) across ${result.files.length} file(s)`;

  if (result.dryRun) {
    const diffs = result.files.map((f) => f.diff || `(no changes in ${f.filePath})`).join("\n\n");
    return `Dry run: ${summary} validated. ${NOTHING_WRITTEN}\n\n${diffs}`;
  }

  const blocks = result.files.map((f) => {
    const redact = redactorFor(f.filePath);
    const safe = (text: string): string => preview(redactSnippet(text, redact), 60);
    const entries = f.applied.map((r) => {
      const header = `    op #${r.operation} #${r.index} (line ${r.line}): ${safe(r.find)} → ${safe(r.replace)}`;
      const context = r.context
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n");
      return `${header}\n${context}`;
    });
    return `  ${f.filePath}\n${entries.join("\n")}`;
  });
  return `Applied ${summary}:\n${blocks.join("\n")}`;
}
