import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { pendingFileLocks, surgicalTransaction, type Operation } from "../src/surgical.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "surgical-concurrency-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const edit = (file: string, find: string, replace: string): Operation => ({ file_path: file, replacements: [{ find, replace }] });
const run = (...ops: Operation[]) => surgicalTransaction(ops, { rootDir: dir });
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");

describe("C1: concurrent transactions in one process", () => {
  test("200 concurrent pairs on the same file never lose an update", async () => {
    let lost = 0;
    for (let trial = 0; trial < 200; trial++) {
      writeFileSync(path.join(dir, "a.txt"), "x = 1\ny = 1\n");
      const [first, second] = await Promise.all([run(edit("a.txt", "x = 1", "x = 2")), run(edit("a.txt", "y = 1", "y = 2"))]);
      assert.equal(first.ok && second.ok, true, `trial ${trial}`);
      if (read("a.txt") !== "x = 2\ny = 2\n") lost++;
    }
    assert.equal(lost, 0);
    assert.equal(pendingFileLocks(), 0);
  });

  test("20 concurrent transactions each editing their own line are all applied", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `v${i} = 0`);
    writeFileSync(path.join(dir, "a.txt"), lines.join("\n") + "\n");
    const results = await Promise.all(lines.map((line, i) => run(edit("a.txt", line, `v${i} = 1`))));
    assert.ok(results.every((r) => r.ok));
    assert.equal(read("a.txt"), lines.map((_, i) => `v${i} = 1`).join("\n") + "\n");
  });

  test("multi-file transactions in opposite orders finish without deadlock and keep every edit", async () => {
    const count = 100;
    const body = (name: string) => Array.from({ length: count }, (_, i) => `${name}${i} = 0`).join("\n") + "\n";
    writeFileSync(path.join(dir, "a.txt"), body("a"));
    writeFileSync(path.join(dir, "b.txt"), body("b"));
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        i % 2 === 0
          ? run(edit("a.txt", `a${i} = 0`, `a${i} = 1`), edit("b.txt", `b${i} = 0`, `b${i} = 1`))
          : run(edit("b.txt", `b${i} = 0`, `b${i} = 1`), edit("a.txt", `a${i} = 0`, `a${i} = 1`)),
      ),
    );
    assert.ok(results.every((r) => r.ok));
    assert.equal(read("a.txt"), body("a").replace(/ = 0/g, " = 1"));
    assert.equal(read("b.txt"), body("b").replace(/ = 0/g, " = 1"));
    assert.equal(pendingFileLocks(), 0);
  });

  test("the same file reached through a symlink shares the lock", async () => {
    writeFileSync(path.join(dir, "a.txt"), "x = 1\ny = 1\n");
    symlinkSync(path.join(dir, "a.txt"), path.join(dir, "link.txt"));
    for (let trial = 0; trial < 50; trial++) {
      writeFileSync(path.join(dir, "a.txt"), "x = 1\ny = 1\n");
      const results = await Promise.all([run(edit("a.txt", "x = 1", "x = 2")), run(edit("link.txt", "y = 1", "y = 2"))]);
      assert.ok(results.every((r) => r.ok));
      assert.equal(read("a.txt"), "x = 2\ny = 2\n", `trial ${trial}`);
    }
  });

  test("of two conflicting transactions exactly one wins and the other fails cleanly instead of overwriting it", async () => {
    // Which one takes the lock first depends on async path resolution, so the test checks the guarantee, not the order.
    for (let trial = 0; trial < 50; trial++) {
      writeFileSync(path.join(dir, "a.txt"), "x = 1\n");
      const results = await Promise.all([run(edit("a.txt", "x = 1", "x = 2")), run(edit("a.txt", "x = 1", "x = 3"))]);
      const winners = results.flatMap((r, i) => (r.ok ? [i] : []));
      assert.equal(winners.length, 1, `trial ${trial}: exactly one transaction must win`);
      const loser = results[1 - winners[0]!]!;
      if (!loser.ok) assert.match(loser.error, /No exact match found|was not found/);
      assert.equal(read("a.txt"), winners[0] === 0 ? "x = 2\n" : "x = 3\n");
    }
    assert.equal(pendingFileLocks(), 0);
  });

  test("failed transactions release their locks", async () => {
    writeFileSync(path.join(dir, "a.txt"), "x = 1\n");
    const results = await Promise.all([
      run(edit("a.txt", "missing", "y")),
      run(edit("a.txt", "x", "y"), edit("missing.txt", "x", "y")),
      surgicalTransaction([edit("a.txt", "x = 1", "x = 2")], { rootDir: dir, limits: { maxWorkChars: 1 } }),
      run(edit("../outside.txt", "x", "y")),
      run(edit("a.txt", "x = 1", "x = 2")),
    ]);
    assert.deepEqual(
      results.map((r) => r.ok),
      [false, false, false, false, true],
    );
    assert.equal(read("a.txt"), "x = 2\n");
    assert.equal(pendingFileLocks(), 0);
  });

  test("dry runs wait for a commit in progress and see its result", async () => {
    writeFileSync(path.join(dir, "a.txt"), "x = 1\n");
    const [, dry] = await Promise.all([
      run(edit("a.txt", "x = 1", "x = 2")),
      surgicalTransaction([edit("a.txt", "x = 2", "x = 3")], { rootDir: dir, dryRun: true }),
    ]);
    assert.equal(dry.ok, true);
    assert.equal(read("a.txt"), "x = 2\n");
  });
});
