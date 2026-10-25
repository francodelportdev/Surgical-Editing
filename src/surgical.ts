import { randomBytes } from "node:crypto";
// Accessed as `fs.*` (not destructured) so tests can intercept calls with mock.method.
import fs from "node:fs/promises";
import path from "node:path";
import { unifiedDiff } from "./diff.js";
import { findClosestMatch } from "./matcher.js";

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
}

export interface AppliedReplacement {
  /** Index of the operation this replacement belongs to. */
  operation: number;
  index: number;
  find: string;
  replace: string;
  /** 1-based line where the match started, to help the LLM verify the edit. */
  line: number;
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
  applied: AppliedReplacement[];
}

const NOTHING_WRITTEN = "No files were written.";
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NOT_UTF8 = "File is not valid UTF-8 or is binary. Surgical editing aborted to prevent corruption.";
// fatal: invalid byte sequences throw instead of silently becoming U+FFFD,
// which would then be written back and destroy the original bytes.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Counts occurrences of `needle` in `haystack`, including overlapping ones.
 * We count overlaps on purpose: with "aa" inside "aaa" a non-overlapping
 * count would report 1 and hide a real ambiguity about where the edit lands.
 */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + 1;
  }
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
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
async function resolveTarget(rawPath: string, rootDir: string | undefined): Promise<string | { path: string }> {
  const requested = rootDir === undefined ? path.resolve(rawPath) : path.resolve(rootDir, rawPath);
  if (rootDir !== undefined && !isInside(rootDir, requested)) {
    return `Path traversal blocked: ${requested} is outside SURGICAL_ROOT_DIR (${rootDir})`;
  }

  // Follow symlinks so the temp file + rename replaces the real file. Renaming
  // onto the link path would swap the link for a regular file and leave the
  // file it pointed to unedited.
  let real: string;
  try {
    real = await fs.realpath(requested);
  } catch (err) {
    return describeFsError(err, "read", requested);
  }

  // Check again after resolution: a symlink inside the root may point outside it.
  if (rootDir !== undefined && !isInside(rootDir, real)) {
    return `Path traversal blocked: ${requested} resolves to ${real}, outside SURGICAL_ROOT_DIR (${rootDir})`;
  }
  return { path: real };
}

async function loadFile(filePath: string): Promise<FileState | string> {
  let bytes: Buffer;
  let info: Awaited<ReturnType<typeof fs.stat>>;
  try {
    info = await fs.stat(filePath);
    if (!info.isFile()) return `Not a regular file: ${filePath}`;
    bytes = await fs.readFile(filePath);
  } catch (err) {
    return describeFsError(err, "read", filePath);
  }

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
    applied: [],
  };
}

function notFoundMessage(content: string, find: string): string {
  // Before giving up, point the agent at the closest region so it can correct
  // its snippet without another full read of the file.
  const closest = findClosestMatch(content, find);
  if (closest) {
    const pct = Math.round(closest.similarity * 100);
    const hint = closest.hint ? ` Hint: ${closest.hint}` : "";
    return `No exact match found. Line ${closest.line} contains (${pct}% similar): '${closest.text}'.${hint}`;
  }
  return (
    `"find" text ${preview(find)} was not found. It must match the file exactly ` +
    `(whitespace, indentation and line endings included). Re-read the file and retry.`
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
  const matches = countOccurrences(state.content, r.find);
  if (matches === 0) return notFoundMessage(state.content, r.find);
  if (matches > 1) {
    return (
      `"find" text ${preview(r.find)} is ambiguous — it appears ${matches} times. ` +
      `Include more surrounding context so it matches exactly once.`
    );
  }

  const offset = state.content.indexOf(r.find);
  // Splice by offset instead of String.prototype.replace so that "$&", "$1"
  // etc. in `replace` are inserted literally rather than as patterns.
  state.content = state.content.slice(0, offset) + r.replace + state.content.slice(offset + r.find.length);
  state.applied.push({ operation, index, find: r.find, replace: r.replace, line: lineAt(state.content, offset) });
  return undefined;
}

function tempPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
}

/**
 * Detects files modified by someone else since we read them. Compares size as
 * well as mtime because some filesystems only store mtime at 1–2 s resolution.
 */
async function findConcurrentModification(states: readonly FileState[]): Promise<string | undefined> {
  for (const state of states) {
    try {
      const now = await fs.stat(state.filePath);
      if (now.mtimeMs !== state.mtimeMs || now.size !== state.size) {
        return `Concurrent modification detected on ${state.filePath}. Transaction aborted for safety.`;
      }
    } catch (err) {
      return `${describeFsError(err, "re-check", state.filePath)}. Transaction aborted for safety.`;
    }
  }
  return undefined;
}

/**
 * Two-phase commit across files. Phase 1 writes every new version to a temp
 * file next to its target, where nearly all I/O failures (permissions, disk
 * full) surface while the originals are still untouched. Phase 2 swaps them in
 * with rename(), which is atomic per file on POSIX. If a rename still fails we
 * restore the files already swapped, so a transaction never ends half-applied.
 */
async function commit(states: readonly FileState[]): Promise<string | undefined> {
  const staged: { state: FileState; tmp: string }[] = [];
  const discardTemps = (from = 0): Promise<unknown> =>
    Promise.all(staged.slice(from).map((s) => fs.unlink(s.tmp).catch(() => undefined)));

  for (const state of states) {
    // Register the temp path before writing: a failed writeFile can still
    // leave a partial file behind that must be cleaned up.
    const tmp = tempPathFor(state.filePath);
    staged.push({ state, tmp });
    try {
      await fs.writeFile(tmp, encode(state), { mode: state.mode });
    } catch (err) {
      await discardTemps();
      return describeFsError(err, "write", state.filePath);
    }
  }

  // Last check before the point of no return. Staging temps can take a while
  // on large transactions; if anyone touched an original in the meantime, our
  // edits were computed from stale content and would overwrite their changes.
  const conflict = await findConcurrentModification(states);
  if (conflict !== undefined) {
    await discardTemps();
    return conflict;
  }

  const swapped: FileState[] = [];
  for (const [i, { state, tmp }] of staged.entries()) {
    try {
      await fs.rename(tmp, state.filePath);
      swapped.push(state);
    } catch (err) {
      await discardTemps(i);
      const failedRestores: string[] = [];
      for (const done of swapped) {
        try {
          await fs.writeFile(done.filePath, done.originalBytes, { mode: done.mode });
        } catch {
          failedRestores.push(done.filePath);
        }
      }
      const restoreNote =
        failedRestores.length > 0
          ? ` WARNING: could not restore ${failedRestores.join(", ")}; these files contain the new content.`
          : swapped.length > 0
            ? " Files already updated were restored to their original content."
            : "";
      return `${describeFsError(err, "write", state.filePath)}.${restoreNote}`;
    }
  }
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
  const dryRun = options.dryRun ?? false;
  if (operations.length === 0) return { ok: false, error: `No operations provided. ${NOTHING_WRITTEN}` };

  // Several operations may target the same file (even via different relative
  // paths or symlinks); keying by physical path makes them share one
  // in-memory state so edits compose sequentially.
  const files = new Map<string, FileState>();
  const resolved: string[] = [];

  for (const [opIndex, op] of operations.entries()) {
    const target = await resolveTarget(op.file_path, options.rootDir);
    if (typeof target === "string") {
      return { ok: false, error: `Operation #${opIndex}: ${target}. ${NOTHING_WRITTEN}` };
    }
    resolved.push(target.path);
    if (files.has(target.path)) continue;
    const loaded = await loadFile(target.path);
    if (typeof loaded === "string") {
      return { ok: false, error: `Operation #${opIndex} (${target.path}): ${loaded} ${NOTHING_WRITTEN}` };
    }
    files.set(target.path, loaded);
  }

  for (const [opIndex, op] of operations.entries()) {
    const state = files.get(resolved[opIndex]!)!;
    if (op.replacements.length === 0) {
      return { ok: false, error: `Operation #${opIndex} (${state.filePath}): no replacements provided. ${NOTHING_WRITTEN}` };
    }
    for (const [index, replacement] of op.replacements.entries()) {
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
  const changes: FileChange[] = states.map((s) => ({
    filePath: s.filePath,
    applied: s.applied,
    diff: unifiedDiff(s.original, s.content, s.filePath),
  }));

  if (!dryRun) {
    const error = await commit(states.filter((s) => s.content !== s.original));
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
    const lines = f.applied.map(
      (r) => `    op #${r.operation} #${r.index} (line ${r.line}): ${preview(r.find, 60)} → ${preview(r.replace, 60)}`,
    );
    return `  ${f.filePath}\n${lines.join("\n")}`;
  });
  return `Applied ${summary}:\n${blocks.join("\n")}`;
}
