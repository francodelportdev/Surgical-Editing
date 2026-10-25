import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
  filePath: string;
  original: string;
  content: string;
  mode: number;
  applied: AppliedReplacement[];
}

const NOTHING_WRITTEN = "No files were written.";

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

async function loadFile(filePath: string): Promise<FileState | string> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return `Not a regular file: ${filePath}`;
    const original = await readFile(filePath, "utf8");
    return { filePath, original, content: original, mode: info.mode, applied: [] };
  } catch (err) {
    return describeFsError(err, "read", filePath);
  }
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
 * Two-phase commit across files. Phase 1 writes every new version to a temp
 * file next to its target, where nearly all I/O failures (permissions, disk
 * full) surface while the originals are still untouched. Phase 2 swaps them in
 * with rename(), which is atomic per file on POSIX. If a rename still fails we
 * restore the files already swapped, so a transaction never ends half-applied.
 */
async function commit(states: readonly FileState[]): Promise<string | undefined> {
  const staged: { state: FileState; tmp: string }[] = [];
  for (const state of states) {
    // Register the temp path before writing: a failed writeFile can still
    // leave a partial file behind that must be cleaned up.
    const tmp = tempPathFor(state.filePath);
    staged.push({ state, tmp });
    try {
      await writeFile(tmp, state.content, { encoding: "utf8", mode: state.mode });
    } catch (err) {
      await Promise.all(staged.map((s) => unlink(s.tmp).catch(() => undefined)));
      return describeFsError(err, "write", state.filePath);
    }
  }

  const swapped: FileState[] = [];
  for (const [i, { state, tmp }] of staged.entries()) {
    try {
      await rename(tmp, state.filePath);
      swapped.push(state);
    } catch (err) {
      await Promise.all(staged.slice(i).map((s) => unlink(s.tmp).catch(() => undefined)));
      const failedRestores: string[] = [];
      for (const done of swapped) {
        try {
          await writeFile(done.filePath, done.original, { encoding: "utf8", mode: done.mode });
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
  options: { dryRun?: boolean } = {},
): Promise<TransactionResult> {
  const dryRun = options.dryRun ?? false;
  if (operations.length === 0) return { ok: false, error: `No operations provided. ${NOTHING_WRITTEN}` };

  // Several operations may target the same file (even via different relative
  // paths); they share one in-memory state so edits compose sequentially.
  const files = new Map<string, FileState>();
  const resolved = operations.map((op) => path.resolve(op.file_path));

  for (const [opIndex, filePath] of resolved.entries()) {
    if (files.has(filePath)) continue;
    const loaded = await loadFile(filePath);
    if (typeof loaded === "string") {
      return { ok: false, error: `Operation #${opIndex}: ${loaded}. ${NOTHING_WRITTEN}` };
    }
    files.set(filePath, loaded);
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
export async function surgicalReplace(rawPath: string, replacements: readonly Replacement[]): Promise<SurgicalResult> {
  const result = await surgicalTransaction([{ file_path: rawPath, replacements }]);
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
