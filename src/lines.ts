/** Offsets where each line starts, built once per content; lookups are O(log lines). */
export class LineIndex {
  private readonly starts: Uint32Array;

  constructor(content: string) {
    let count = 1;
    for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) count++;
    this.starts = new Uint32Array(count);
    let line = 1;
    for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) this.starts[line++] = i + 1;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** 1-based line containing `offset`. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Offset where 1-based `line` starts, or Infinity past the last line. */
  lineStart(line: number): number {
    return line >= 1 && line <= this.starts.length ? this.starts[line - 1]! : Number.POSITIVE_INFINITY;
  }
}

export interface OccurrenceSummary {
  /** All occurrences, overlapping ones included. */
  count: number;
  /** Number of distinct lines where an occurrence starts. */
  distinctLines: number;
  /** The first `maxListed` of those lines, ascending. */
  listedLines: number[];
}

/** Counts every (overlapping) occurrence in O(content + needle) with KMP; line numbers only for the first `maxListed` lines. */
export function summarizeOccurrences(content: string, needle: string, maxListed: number): OccurrenceSummary {
  const summary: OccurrenceSummary = { count: 0, distinctLines: 0, listedLines: [] };
  const m = needle.length;
  if (m === 0) return summary;

  const failure = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && needle.charCodeAt(i) !== needle.charCodeAt(k)) k = failure[k - 1]!;
    if (needle.charCodeAt(i) === needle.charCodeAt(k)) k++;
    failure[i] = k;
  }

  let index: LineIndex | undefined;
  let line = 0;
  let nextLineStart = Number.NEGATIVE_INFINITY;
  for (let i = 0, k = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    while (k > 0 && c !== needle.charCodeAt(k)) k = failure[k - 1]!;
    if (c === needle.charCodeAt(k)) k++;
    if (k < m) continue;
    k = failure[m - 1]!;

    const start = i - m + 1;
    summary.count++;
    if (start < nextLineStart) continue;
    index ??= new LineIndex(content);
    // Matches arrive in order, so walking forward costs O(lines) in total.
    while (index.lineStart(line + 1) <= start) line++;
    nextLineStart = index.lineStart(line + 1);
    summary.distinctLines++;
    if (summary.listedLines.length < maxListed) summary.listedLines.push(line);
  }
  return summary;
}
