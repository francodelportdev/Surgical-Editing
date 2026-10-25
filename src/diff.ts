/**
 * Minimal unified diff generator for dry-run previews.
 *
 * Surgical edits touch few lines, so we strip the common prefix/suffix first
 * and only run the O(n×m) LCS on the small changed middle. If the middle is
 * still huge we degrade to a plain remove/add block instead of stalling.
 */

type OpKind = " " | "-" | "+";

interface DiffOp {
  kind: OpKind;
  text: string;
}

const MAX_LCS_CELLS = 4_000_000;
const DEFAULT_CONTEXT = 3;

function lcsOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_LCS_CELLS) {
    return [...a.map((text): DiffOp => ({ kind: "-", text })), ...b.map((text): DiffOp => ({ kind: "+", text }))];
  }

  // dp[i][j] = LCS length of a[i..] and b[j..], stored flat.
  const stride = m + 1;
  const dp = new Uint32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * stride + j] =
        a[i] === b[j]
          ? dp[(i + 1) * stride + j + 1]! + 1
          : Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!) {
      ops.push({ kind: "-", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", text: a[i++]! });
  while (j < m) ops.push({ kind: "+", text: b[j++]! });
  return ops;
}

function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const same = (text: string): DiffOp => ({ kind: " ", text });
  return [
    ...a.slice(0, prefix).map(same),
    ...lcsOps(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
    ...a.slice(a.length - suffix).map(same),
  ];
}

/** Returns a unified diff of `before` → `after`, or "" if they are identical. */
export function unifiedDiff(before: string, after: string, filePath: string, context = DEFAULT_CONTEXT): string {
  if (before === after) return "";
  const ops = diffLines(before.split("\n"), after.split("\n"));

  // 1-based line numbers in each side at the start of every op.
  const aLineAt: number[] = [];
  const bLineAt: number[] = [];
  let aLine = 1;
  let bLine = 1;
  for (const op of ops) {
    aLineAt.push(aLine);
    bLineAt.push(bLine);
    if (op.kind !== "+") aLine++;
    if (op.kind !== "-") bLine++;
  }

  const changes = ops.flatMap((op, idx) => (op.kind === " " ? [] : [idx]));
  const out = [`--- ${filePath}`, `+++ ${filePath}`];

  let h = 0;
  while (h < changes.length) {
    const start = Math.max(0, changes[h]! - context);
    let end = Math.min(ops.length, changes[h]! + context + 1);
    // Merge changes whose context windows touch into a single hunk.
    while (h + 1 < changes.length && changes[h + 1]! - context <= end) {
      h++;
      end = Math.min(ops.length, changes[h]! + context + 1);
    }
    h++;

    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((op) => op.kind !== "+").length;
    const bCount = hunk.filter((op) => op.kind !== "-").length;
    const aStart = aCount === 0 ? aLineAt[start]! - 1 : aLineAt[start]!;
    const bStart = bCount === 0 ? bLineAt[start]! - 1 : bLineAt[start]!;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.text}`);
  }

  return out.join("\n");
}
