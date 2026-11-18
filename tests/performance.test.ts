import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_LIMITS } from "../src/config.js";
import { LineIndex, summarizeOccurrences } from "../src/lines.js";
import { DEFAULT_FUZZY_BUDGET, findClosestMatch } from "../src/matcher.js";
import { countOccurrences, surgicalTransaction, type Replacement } from "../src/surgical.js";

// Generous ceiling: the old quadratic code needed hours to days for these inputs; the new one needs about a second.
const LARGE_INPUT_TIMEOUT = 60_000;
const ENGINE = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/surgical.ts")).href;
const TSX = import.meta.resolve("tsx");
const MB = 1024 * 1024;

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "surgical-perf-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function naiveLineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (content[i] === "\n") line++;
  return line;
}

function naiveSummary(content: string, needle: string, maxListed: number) {
  const offsets: number[] = [];
  for (let from = 0; ; ) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + 1;
  }
  const lines = [...new Set(offsets.map((o) => naiveLineAt(content, o)))];
  return { count: offsets.length, distinctLines: lines.length, listedLines: lines.slice(0, maxListed) };
}

function random(seed: number): () => number {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
}

function codeLike(maxBytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; ; i++) {
    const line = `  const value${i} = compute(${i}); return value${i};`;
    if (size + line.length + 1 > maxBytes) return lines.join("\n");
    lines.push(line);
    size += line.length + 1;
  }
}

function writeTarget(content: string): string {
  writeFileSync(path.join(dir, "f.txt"), content);
  return content;
}

const run = (replacements: Replacement[], limits = {}) =>
  surgicalTransaction([{ file_path: "f.txt", replacements }], { rootDir: dir, limits });

// Runs the transaction in a child process killed at the deadline: blocking CPU work can't be interrupted in-process.
function runIsolated(replacements: Replacement[]): Awaited<ReturnType<typeof run>> {
  // Replacements go through stdin: Windows caps a command line at 32 KB.
  const script =
    `const { surgicalTransaction } = await import(${JSON.stringify(ENGINE)});` +
    `let input = ""; for await (const chunk of process.stdin) input += chunk;` +
    `const r = await surgicalTransaction([{ file_path: "f.txt", replacements: JSON.parse(input) }], { rootDir: ${JSON.stringify(dir)} });` +
    `process.stdout.write(JSON.stringify(r));`;
  const child = spawnSync(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
    input: JSON.stringify(replacements),
    encoding: "utf8",
    timeout: LARGE_INPUT_TIMEOUT,
    maxBuffer: 64 * MB,
  });
  assert.equal(child.signal, null, `engine did not finish within ${LARGE_INPUT_TIMEOUT} ms`);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as Awaited<ReturnType<typeof run>>;
}

function assertUntouched(original: string): void {
  assert.equal(readFileSync(path.join(dir, "f.txt"), "utf8"), original);
  assert.deepEqual(readdirSync(dir), ["f.txt"]);
}

describe("line index and occurrence summary match the reference algorithm", () => {
  test("LineIndex.lineAt equals a naive newline count at every offset", () => {
    const next = random(1);
    for (let trial = 0; trial < 200; trial++) {
      const text = Array.from({ length: Math.floor(next() * 60) }, () => "ab\n"[Math.floor(next() * 3)]).join("");
      const index = new LineIndex(text);
      for (let offset = 0; offset <= text.length; offset++) assert.equal(index.lineAt(offset), naiveLineAt(text, offset));
    }
  });

  test("summarizeOccurrences equals the old findOccurrences + lineAt, overlaps and newline needles included", () => {
    const next = random(2);
    for (let trial = 0; trial < 2_000; trial++) {
      const text = Array.from({ length: Math.floor(next() * 80) }, () => "aab\n"[Math.floor(next() * 4)]).join("");
      const needle = Array.from({ length: 1 + Math.floor(next() * 4) }, () => "ab\n"[Math.floor(next() * 3)]).join("");
      const maxListed = Math.floor(next() * 12);
      assert.deepEqual(summarizeOccurrences(text, needle, maxListed), naiveSummary(text, needle, maxListed), JSON.stringify({ text, needle }));
    }
  });

  test("countOccurrences still counts overlapping matches", () => {
    assert.equal(countOccurrences("aaa", "aa"), 2);
    assert.equal(countOccurrences("abc", "x"), 0);
  });
});

describe("C2: ambiguous finds on large files", () => {
  test("10 MB file with a one-character find is rejected as ambiguous with the usual format", () => {
    const original = writeTarget("a\n".repeat(5 * MB));
    const r = runIsolated([{ find: "a", replace: "b" }]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(
        r.error,
        /"find" text "a" is ambiguous — it appears 5242880 times \(lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, … \+5242870 more\)\. Include more surrounding context so it matches exactly once\./,
      );
    }
    assertUntouched(original);
  });

  test("10 MB single-line file and a periodic 1000-character find", () => {
    const original = writeTarget("a".repeat(10 * MB - 1));
    const r = runIsolated([{ find: "a".repeat(1000), replace: "b" }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, new RegExp(`appears ${10 * MB - 1 - 999} times \\(line 1\\)`));
    assertUntouched(original);
  });

  test("large file with one match per line lists the first lines and counts the rest", () => {
    const original = writeTarget(codeLike(10 * MB - 1));
    const lines = original.split("\n").length;
    const r = runIsolated([{ find: "return", replace: "yield" }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, new RegExp(`appears ${lines} times \\(lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, … \\+${lines - 10} more\\)`));
    assertUntouched(original);
  });

  test("small ambiguity messages are unchanged", async () => {
    writeTarget("x = 1\ny = 1\nx = 1; x = 1\n");
    const r = await run([{ find: "x = 1", replace: "x = 2" }]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(
        r.error,
        `Operation #0, Replacement #0 (${path.join(dir, "f.txt")}): "find" text "x = 1" is ambiguous — it appears 3 times (lines 1, 3). ` +
          "Include more surrounding context so it matches exactly once. No files were written.",
      );
    }
  });
});

describe("C3: many replacements and the work budget", () => {
  const thousandEdits = (): Replacement[] =>
    Array.from({ length: 1_000 }, (_, i) => ({ find: `const value${i} =`, replace: `let value${i} =` }));

  test("1000 replacements on a large file within the default budget are all applied", () => {
    const original = writeTarget(codeLike(900 * 1024));
    const r = runIsolated(thousandEdits());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.files[0]!.applied.length, 1_000);
    assert.equal(r.files[0]!.applied[999]!.line, 1_000);
    const expected = original.replace(/const value(\d+) =/g, (m, n: string) => (Number(n) < 1_000 ? `let value${n} =` : m));
    assert.equal(readFileSync(path.join(dir, "f.txt"), "utf8"), expected);
  });

  test("1000 replacements on a 10 MB file exceed the default budget and are rejected before any work", async () => {
    const original = writeTarget(codeLike(10 * MB - 1));
    const r = await run(thousandEdits());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Transaction too expensive: .* above the budget of 1000000000 \(SURGICAL_MAX_WORK_CHARS\)/);
      assert.match(r.error, /No files were written\.$/);
    }
    assertUntouched(original);
  });

  test("the budget also catches growth during the transaction, not only the up-front estimate", async () => {
    const original = writeTarget("a".repeat(90) + "MARK" + "b".repeat(6));
    const r = await run(
      [
        { find: "MARK", replace: "x".repeat(1_000) },
        { find: "bbbbbb", replace: "c" },
      ],
      { maxWorkChars: 500 },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Transaction too expensive: .*~1196 characters.*budget of 500/);
    assertUntouched(original);
  });

  test("the default budget is documented in DEFAULT_LIMITS and configurable per call", async () => {
    assert.equal(DEFAULT_LIMITS.maxWorkChars, 1_000_000_000);
    writeTarget("v = 1\n");
    assert.equal((await run([{ find: "v = 1", replace: "v = 2" }], { maxWorkChars: 5 })).ok, false);
    assert.equal((await run([{ find: "v = 1", replace: "v = 2" }], { maxWorkChars: 6 })).ok, true);
  });
});

describe("P5-c: fuzzy search budget", () => {
  const code = codeLike(50 * 1024);

  test("an exhausted budget skips the suggestion instead of searching on", () => {
    assert.ok(findClosestMatch(code, "const valeu120 = compute(120);"));
    assert.equal(findClosestMatch(code, "const valeu120 = compute(120);", undefined, 1_000), undefined);
  });

  test("normal suggestions are unchanged under the default budget", () => {
    const m = findClosestMatch(code, "const valeu120 = compute(120);");
    assert.equal(m?.line, 121);
    assert.equal(m?.text, "  const value120 = compute(120); return value120;");
    assert.equal(Math.round((m?.similarity ?? 0) * 1000), 933);
    assert.ok(DEFAULT_FUZZY_BUDGET >= 100_000_000);
  });

  test("an expensive miss keeps the main error without a suggestion", () => {
    const original = writeTarget("x".repeat(1_900 * 1024) + "\n");
    const r = runIsolated([{ find: "y".repeat(1_999) + "x", replace: "z" }]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /was not found\. It must match the file exactly/);
      assert.doesNotMatch(r.error, /similar/);
    }
    assertUntouched(original);
  });

  test("a near miss in a normal file still gets its suggestion through the transaction", async () => {
    writeTarget(code);
    const r = await run([{ find: "const valeu120 = compute(120);", replace: "x" }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Line 121 contains \(93% similar\): '  const value120 = compute\(120\); return value120;'/);
  });
});
