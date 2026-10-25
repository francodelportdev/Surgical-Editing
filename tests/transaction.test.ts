import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { surgicalTransaction } from "../src/surgical.js";

describe("surgicalTransaction (multi-file)", () => {
  let dir: string;
  let fileA: string;
  let fileB: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "surgical-editing-"));
    fileA = path.join(dir, "a.ts");
    fileB = path.join(dir, "b.ts");
    writeFileSync(fileA, "export const port = 3000;\n", "utf8");
    writeFileSync(fileB, "import { port } from './a';\nlisten(port);\n", "utf8");
  });

  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  test("applies replacements across several files in one call", async () => {
    const result = await surgicalTransaction([
      { file_path: fileA, replacements: [{ find: "port = 3000", replace: "port = 8080" }] },
      { file_path: fileB, replacements: [{ find: "listen(port)", replace: "listen(port, host)" }] },
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.files.length, 2);
    assert.equal(readFileSync(fileA, "utf8"), "export const port = 8080;\n");
    assert.equal(readFileSync(fileB, "utf8"), "import { port } from './a';\nlisten(port, host);\n");
  });

  test("is atomic across files: a failure in the last file leaves every file untouched", async () => {
    const result = await surgicalTransaction([
      { file_path: fileA, replacements: [{ find: "port = 3000", replace: "port = 8080" }] },
      { file_path: fileB, replacements: [{ find: "nonexistent snippet xyz", replace: "x" }] },
    ]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Operation #1, Replacement #0/);
    assert.match(result.error, /No files were written/);
    assert.equal(readFileSync(fileA, "utf8"), "export const port = 3000;\n");
  });

  test("operations on the same file compose sequentially", async () => {
    const result = await surgicalTransaction([
      { file_path: fileA, replacements: [{ find: "3000", replace: "PORT" }] },
      { file_path: path.relative(process.cwd(), fileA), replacements: [{ find: "= PORT", replace: "= Number(PORT)" }] },
    ]);

    assert.equal(result.ok, true);
    assert.equal(readFileSync(fileA, "utf8"), "export const port = Number(PORT);\n");
  });

  test("inserts $& and $1 literally", async () => {
    await surgicalTransaction([{ file_path: fileA, replacements: [{ find: "3000", replace: "'$&$1'" }] }]);
    assert.equal(readFileSync(fileA, "utf8"), "export const port = '$&$1';\n");
  });

  test("reports a missing file without writing anything", async () => {
    const result = await surgicalTransaction([
      { file_path: fileA, replacements: [{ find: "3000", replace: "1" }] },
      { file_path: path.join(dir, "missing.ts"), replacements: [{ find: "x", replace: "y" }] },
    ]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Operation #1: File not found/);
    assert.equal(readFileSync(fileA, "utf8"), "export const port = 3000;\n");
  });

  test("reports permission errors and leaves no temp files behind", { skip: process.getuid?.() === 0 }, async () => {
    // A read-only directory blocks creating the temp file, so the commit must
    // fail before any original is replaced.
    chmodSync(dir, 0o555);
    const result = await surgicalTransaction([{ file_path: fileA, replacements: [{ find: "3000", replace: "1" }] }]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Permission denied/);
    assert.equal(readFileSync(fileA, "utf8"), "export const port = 3000;\n");
    assert.deepEqual(readdirSync(dir).sort(), ["a.ts", "b.ts"]);
  });
});
