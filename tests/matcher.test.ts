import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { findClosestMatch } from "../src/matcher.js";
import { surgicalReplace } from "../src/surgical.js";

const SOURCE = "function main() {\n  const userName = getUser();\n    return userName;\n}\n";

describe("findClosestMatch", () => {
  test("finds a near-miss typo with its line and similarity", () => {
    const match = findClosestMatch(SOURCE, "const usrName = getUser();");
    assert.ok(match);
    assert.equal(match.line, 2);
    assert.ok(match.similarity > 0.8);
    assert.equal(match.hint, undefined);
  });

  test("flags whitespace-only differences", () => {
    const match = findClosestMatch(SOURCE, "const userName = getUser();\n  return userName;");
    assert.ok(match);
    assert.equal(match.line, 2);
    assert.match(match.hint ?? "", /whitespace/);
  });

  test("flags CRLF vs LF line endings", () => {
    const match = findClosestMatch(SOURCE.replace(/\n/g, "\r\n"), "main() {\n  const");
    assert.ok(match);
    assert.equal(match.hint, "File uses CRLF line endings.");
  });

  test("returns nothing below the similarity threshold", () => {
    assert.equal(findClosestMatch(SOURCE, "completely unrelated text"), undefined);
  });
});

describe("fuzzy diagnostics in surgicalReplace errors", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "surgical-editing-"));
    file = path.join(dir, "target.ts");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("includes the similar line in the agreed format", async () => {
    writeFileSync(file, SOURCE, "utf8");
    const result = await surgicalReplace(file, [{ find: "const usrName = getUser();", replace: "x" }]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /No exact match found\. Line 2 contains \(\d+% similar\): ' {2}const userName = getUser\(\);'\./);
    assert.equal(readFileSync(file, "utf8"), SOURCE);
  });

  test("appends the line-ending hint", async () => {
    writeFileSync(file, SOURCE.replace(/\n/g, "\r\n"), "utf8");
    const result = await surgicalReplace(file, [{ find: "main() {\n  const", replace: "x" }]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /\(100% similar\).*Hint: File uses CRLF line endings\./s);
  });
});
