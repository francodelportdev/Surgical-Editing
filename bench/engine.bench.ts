// Reproducible engine benchmark: npm run bench [-- path/to/surgical.ts]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const enginePath = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : "../src/surgical.js";
const { surgicalTransaction } = (await import(enginePath)) as typeof import("../src/surgical.js");
const { findClosestMatch } = (await import(enginePath.replace(/surgical\.(js|ts)$/, "matcher.$1"))) as typeof import("../src/matcher.js");

const MB = 1024 * 1024;
const dir = mkdtempSync(path.join(tmpdir(), "surgical-bench-"));
const rows: string[][] = [["case", "input chars", "seconds", "ns/char", "result"]];

function record(label: string, chars: number, seconds: number, result: string): void {
  rows.push([label, chars.toLocaleString("en"), seconds.toFixed(3), ((seconds * 1e9) / chars).toFixed(2), result]);
}

async function transaction(label: string, content: string, replacements: { find: string; replace: string }[]): Promise<void> {
  writeFileSync(path.join(dir, "f.txt"), content);
  const t = performance.now();
  const r = await surgicalTransaction([{ file_path: "f.txt", replacements }], { rootDir: dir, dryRun: true });
  const outcome = r.ok ? "ok" : (r.error.match(/ambiguous|too expensive|No exact match|not found/)?.[0] ?? r.error.slice(0, 30));
  record(label, content.length * replacements.length, (performance.now() - t) / 1000, outcome);
}

function codeLike(bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; ; i++) {
    const line = `  const value${i} = compute(${i}); return value${i};`;
    if (size + line.length + 1 > bytes) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

try {
  for (const mb of [1, 2, 5, 10]) await transaction(`C2 ambiguous 1-char find, ${mb} MB of "a\\n"`, "a\n".repeat((mb * MB) / 2), [{ find: "a", replace: "b" }]);
  await transaction("C2 ambiguous 1-char find, 10 MB single line", "a".repeat(10 * MB), [{ find: "a", replace: "b" }]);
  await transaction("C2 periodic 1000-char find, 10 MB of 'a'", "a".repeat(10 * MB), [{ find: "a".repeat(1000), replace: "b" }]);
  await transaction("C2 'return' on every line, 10 MB code", codeLike(10 * MB), [{ find: "return", replace: "yield" }]);

  for (const [count, mb] of [[100, 1], [1000, 1], [100, 10]] as const) {
    const content = codeLike(mb * MB);
    const reps = Array.from({ length: count }, (_, i) => ({ find: `const value${i} =`, replace: `let value${i} =` }));
    await transaction(`C3 ${count} replacements, ${mb} MB file`, content, reps);
  }
  const big = codeLike(10 * MB);
  await transaction("C3 1000 replacements, 10 MB file (over budget)", big, Array.from({ length: 1000 }, (_, i) => ({ find: `const value${i} =`, replace: `let value${i} =` })));

  for (const kb of [100, 400, 1900]) {
    const content = "x".repeat(kb * 1024) + "\n";
    const t = performance.now();
    const m = findClosestMatch(content, "y".repeat(1999) + "x");
    record(`P5-c fuzzy, one ${kb} KB line, 2000-char find`, content.length * 2000, (performance.now() - t) / 1000, m ? "suggestion" : "skipped");
  }
  const fuzzyCases: [string, string, string][] = [
    ["P5-c fuzzy, normal 50 KB file, typo", codeLike(50 * 1024), "const valeu120 = compute(120);"],
    [
      "P5-c fuzzy, 300 KB file, 5-line find with typo",
      codeLike(300 * 1024),
      Array.from({ length: 5 }, (_, i) => `  const value${3000 + i} = compute(${3000 + i}); return value${3000 + i};`)
        .join("\n")
        .replace("compute(3002)", "compte(3002)"),
    ],
  ];
  for (const [label, content, needle] of fuzzyCases) {
    const t = performance.now();
    const m = findClosestMatch(content, needle);
    record(label, content.length, (performance.now() - t) / 1000, m ? `suggestion line ${m.line}` : "none");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
for (const row of rows) console.log(row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("  "));
