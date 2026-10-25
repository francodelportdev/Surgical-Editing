import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { surgicalReplace } from "../src/surgical.js";

const ORIGINAL = "const a = 1;\nconst b = 1;\nconst name = \"world\";\n";

describe("surgicalReplace", () => {
  let dir: string;
  let file: string;

  // Each test gets a fresh temp dir so tests never touch the repo or each other.
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "surgical-editing-"));
    file = path.join(dir, "target.ts");
    writeFileSync(file, ORIGINAL, "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("applies a unique replacement and writes it to disk", async () => {
    const result = await surgicalReplace(file, [{ find: "\"world\"", replace: "\"surgeon\"" }]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0]?.line, 3);
    assert.equal(readFileSync(file, "utf8"), ORIGINAL.replace("\"world\"", "\"surgeon\""));
  });

  test("fails on ambiguity when find appears more than once", async () => {
    const result = await surgicalReplace(file, [{ find: "= 1", replace: "= 2" }]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /ambiguous/);
    assert.match(result.error, /2 times/);
    assert.equal(readFileSync(file, "utf8"), ORIGINAL);
  });

  test("fails when find does not appear in the file", async () => {
    const result = await surgicalReplace(file, [{ find: "does not exist", replace: "x" }]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not found/);
    assert.equal(readFileSync(file, "utf8"), ORIGINAL);
  });

  test("is atomic: a failing second replacement leaves the file untouched", async () => {
    const result = await surgicalReplace(file, [
      { find: "const a = 1", replace: "const a = 99" },
      { find: "missing snippet", replace: "x" },
    ]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Replacement #1/);
    // The first replacement was valid, but nothing may reach disk.
    assert.equal(readFileSync(file, "utf8"), ORIGINAL);
  });
});
