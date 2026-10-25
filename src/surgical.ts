import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Replacement {
  find: string;
  replace: string;
}

export interface AppliedReplacement {
  index: number;
  find: string;
  replace: string;
  /** 1-based line where the match started, to help the LLM verify the edit. */
  line: number;
}

export type SurgicalResult =
  | { ok: true; filePath: string; applied: AppliedReplacement[] }
  | { ok: false; error: string };

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
 * Writes via a temp file in the same directory followed by rename(), which is
 * atomic on POSIX filesystems. A crash mid-write therefore never leaves a
 * half-written source file behind.
 */
async function atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode });
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Applies all replacements in memory and writes the file once, only if every
 * replacement matched exactly one location. Any failure leaves the file untouched.
 */
export async function surgicalReplace(
  rawPath: string,
  replacements: readonly Replacement[],
): Promise<SurgicalResult> {
  const filePath = path.resolve(rawPath);

  let original: string;
  let mode: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { ok: false, error: `Not a regular file: ${filePath}` };
    mode = info.mode;
    original = await readFile(filePath, "utf8");
  } catch (err) {
    return { ok: false, error: describeFsError(err, "read", filePath) };
  }

  let content = original;
  const applied: AppliedReplacement[] = [];

  // Replacements run sequentially against the evolving in-memory content, so a
  // later `find` may target text introduced by an earlier `replace`.
  for (const [index, { find, replace }] of replacements.entries()) {
    // An empty `find` would match everywhere; reject it rather than guess.
    if (find.length === 0) {
      return { ok: false, error: `Replacement #${index}: "find" must not be empty. No changes were written.` };
    }

    // Uniqueness is the core safety guarantee: if the LLM's snippet is
    // ambiguous we cannot know which occurrence it meant, and guessing could
    // silently corrupt the file.
    const matches = countOccurrences(content, find);
    if (matches === 0) {
      return {
        ok: false,
        error:
          `Replacement #${index}: "find" text ${preview(find)} was not found in ${filePath}. ` +
          `It must match the file exactly (whitespace, indentation and line endings included). ` +
          `Re-read the file and retry. No changes were written.`,
      };
    }
    if (matches > 1) {
      return {
        ok: false,
        error:
          `Replacement #${index}: "find" text ${preview(find)} is ambiguous — it appears ${matches} times in ${filePath}. ` +
          `Include more surrounding context so it matches exactly once. No changes were written.`,
      };
    }

    const offset = content.indexOf(find);
    // Splice by offset instead of String.prototype.replace so that "$&", "$1"
    // etc. in `replace` are inserted literally rather than as patterns.
    content = content.slice(0, offset) + replace + content.slice(offset + find.length);
    applied.push({ index, find, replace, line: lineAt(content, offset) });
  }

  if (content !== original) {
    try {
      await atomicWrite(filePath, content, mode);
    } catch (err) {
      return { ok: false, error: describeFsError(err, "write", filePath) };
    }
  }

  return { ok: true, filePath, applied };
}

export function formatSuccess(result: Extract<SurgicalResult, { ok: true }>): string {
  const lines = result.applied.map(
    (r) => `  #${r.index} (line ${r.line}): ${preview(r.find, 60)} → ${preview(r.replace, 60)}`,
  );
  return `Applied ${result.applied.length} replacement(s) to ${result.filePath}:\n${lines.join("\n")}`;
}
