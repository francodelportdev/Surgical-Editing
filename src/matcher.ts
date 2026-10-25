/**
 * Fuzzy diagnostics for failed exact matches.
 *
 * When an LLM's `find` text has zero exact matches, the usual cause is a small
 * drift: different indentation, CRLF vs LF, a renamed identifier, a stale
 * snapshot of the file. Pointing at the closest region lets the agent fix its
 * snippet without spending another round-trip re-reading the whole file.
 *
 * This module only diagnoses; it never decides an edit. Edits stay exact-only.
 */

export interface ClosestMatch {
  /** 1-based line where the similar region starts. */
  line: number;
  /** The similar region as it appears in the file (lines may be truncated). */
  text: string;
  /** 0..1, where 1 means identical after the comparison used. */
  similarity: number;
  /** Specific explanation when the difference is mechanical (whitespace, line endings). */
  hint?: string;
}

export const DEFAULT_THRESHOLD = 0.8;

// Fuzzy search is O(needle × file). These caps keep a failed call cheap even on
// large files; beyond them we just skip the suggestion rather than stall.
const MAX_NEEDLE_CHARS = 2_000;
const MAX_CONTENT_CHARS = 2_000_000;
const MAX_PREVIEW_LINE_CHARS = 160;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Approximate-substring edit distance (semi-global alignment): the minimum
 * Levenshtein distance between `needle` and ANY substring of `text`. Leading
 * and trailing text is free, so a short needle inside a long line still scores
 * well, which plain Levenshtein against the whole line would not.
 *
 * Returns `Infinity` as soon as the distance is guaranteed to exceed `maxDist`:
 * the minimum of each DP row never decreases, so once a row's minimum passes
 * the budget no later row can come back under it.
 */
export function substringDistance(needle: string, text: string, maxDist: number): number {
  const n = text.length;
  let prev = new Uint32Array(n + 1); // row 0: starting anywhere in text costs nothing
  let curr = new Uint32Array(n + 1);

  for (let i = 1; i <= needle.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const nc = needle.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = nc === text.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j - 1]! + cost, prev[j]! + 1, curr[j - 1]! + 1);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return Infinity;
    [prev, curr] = [curr, prev];
  }

  let best = Infinity;
  for (let j = 0; j <= n; j++) best = Math.min(best, prev[j]!);
  return best;
}

function previewLines(lines: readonly string[]): string {
  return lines
    .map((l) => {
      const clean = l.replace(/\r$/, "");
      return clean.length > MAX_PREVIEW_LINE_CHARS ? `${clean.slice(0, MAX_PREVIEW_LINE_CHARS)}…` : clean;
    })
    .join("\n");
}

/**
 * Finds the region of `content` most similar to `needle`, or `undefined` if
 * nothing reaches `threshold`. Windows are spans of as many lines as the
 * needle has, so multi-line snippets are compared against multi-line regions.
 */
export function findClosestMatch(
  content: string,
  needle: string,
  threshold: number = DEFAULT_THRESHOLD,
): ClosestMatch | undefined {
  if (needle.length === 0 || needle.length > MAX_NEEDLE_CHARS || content.length > MAX_CONTENT_CHARS) {
    return undefined;
  }

  const fileLines = content.split("\n");
  const needleNormalized = needle.replace(/\r\n/g, "\n");
  const span = Math.min(needleNormalized.split("\n").length, fileLines.length);
  const needleCollapsed = collapseWhitespace(needle);
  const fileUsesCrlf = content.includes("\r\n");
  const needleUsesCrlf = needle.includes("\r\n");

  // Cheapest and most common failure first: identical except for whitespace
  // or line endings. This is a certain diagnosis, so return it immediately.
  for (let start = 0; start + span <= fileLines.length; start++) {
    const window = fileLines.slice(start, start + span);
    const windowText = window.join("\n");
    if (needleCollapsed.length > 0 && collapseWhitespace(windowText).includes(needleCollapsed)) {
      const hint =
        fileUsesCrlf !== needleUsesCrlf
          ? `File uses ${fileUsesCrlf ? "CRLF" : "LF"} line endings.`
          : "Only whitespace differs (indentation, spaces or tabs).";
      return { line: start + 1, text: previewLines(window), similarity: 1, hint };
    }
  }

  // Edit-distance search, tightening the budget as better candidates appear
  // so most windows bail out after a few DP rows.
  const maxAllowed = Math.floor(needleNormalized.length * (1 - threshold));
  let bestDist = maxAllowed;
  let best: ClosestMatch | undefined;

  for (let start = 0; start + span <= fileLines.length; start++) {
    const window = fileLines.slice(start, start + span);
    const windowText = window.join("\n").replace(/\r/g, "");
    const dist = substringDistance(needleNormalized, windowText, bestDist);
    if (dist <= bestDist && (best === undefined || dist < bestDist)) {
      bestDist = dist;
      best = {
        line: start + 1,
        text: previewLines(window),
        similarity: 1 - dist / needleNormalized.length,
      };
      if (dist === 0) break;
    }
  }

  return best;
}
