import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { formatTransaction, surgicalTransaction } from "../src/surgical.js";

const ORIGINAL = ["line 1", "line 2", "line 3", "const retries = 3;", "line 5", "line 6", "line 7", ""].join("\n");

describe("dry run", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "surgical-editing-"));
    file = path.join(dir, "config.ts");
    writeFileSync(file, ORIGINAL, "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns a unified diff and does not touch the disk", async () => {
    const result = await surgicalTransaction(
      [{ file_path: file, replacements: [{ find: "retries = 3", replace: "retries = 5" }] }],
      { dryRun: true },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dryRun, true);
    assert.equal(
      result.files[0]?.diff,
      [
        `--- ${file}`,
        `+++ ${file}`,
        "@@ -1,7 +1,7 @@",
        " line 1",
        " line 2",
        " line 3",
        "-const retries = 3;",
        "+const retries = 5;",
        " line 5",
        " line 6",
        " line 7",
      ].join("\n"),
    );
    assert.match(formatTransaction(result), /^Dry run: 1 replacement\(s\) across 1 file\(s\) validated\. No files were written\./);
    assert.equal(readFileSync(file, "utf8"), ORIGINAL);
  });

  test("still fails validation on ambiguity", async () => {
    const result = await surgicalTransaction(
      [{ file_path: file, replacements: [{ find: "line", replace: "row" }] }],
      { dryRun: true },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /ambiguous/);
  });
});
