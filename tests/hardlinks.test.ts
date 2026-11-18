import assert from "node:assert/strict";
import { linkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { surgicalTransaction } from "../src/surgical.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "surgical-hardlinks-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a file with several hard links is rejected without writing anything", async () => {
  writeFileSync(path.join(dir, "a.txt"), "v = 1\n");
  writeFileSync(path.join(dir, "b.txt"), "v = 1\n");
  linkSync(path.join(dir, "a.txt"), path.join(dir, "a-link.txt"));
  const r = await surgicalTransaction(
    [
      { file_path: "b.txt", replacements: [{ find: "v = 1", replace: "v = 2" }] },
      { file_path: "a.txt", replacements: [{ find: "v = 1", replace: "v = 2" }] },
    ],
    { rootDir: dir },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Operation #1 \(.*a\.txt\): .*a\.txt has 2 hard links\. Editing replaces the file, which would split them/);
    assert.match(r.error, /No files were written\.$/);
  }
  for (const name of ["a.txt", "a-link.txt", "b.txt"]) assert.equal(readFileSync(path.join(dir, name), "utf8"), "v = 1\n");
  assert.deepEqual(readdirSync(dir).sort(), ["a-link.txt", "a.txt", "b.txt"]);
});

test("once the extra link is gone the file can be edited again", async () => {
  writeFileSync(path.join(dir, "a.txt"), "v = 1\n");
  linkSync(path.join(dir, "a.txt"), path.join(dir, "a-link.txt"));
  rmSync(path.join(dir, "a-link.txt"));
  const r = await surgicalTransaction([{ file_path: "a.txt", replacements: [{ find: "v = 1", replace: "v = 2" }] }], { rootDir: dir });
  assert.equal(r.ok, true);
});
