import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { formatTransaction, surgicalReplace, surgicalTransaction } from "../src/surgical.js";

const SOURCE = ["import x from 'x';", "", "const a = 1;", "const b = 2;", "const c = 1;", "export { a, b, c };", ""].join("\n");

describe("agent feedback", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "surgical-editing-"));
    file = path.join(dir, "target.ts");
    writeFileSync(file, SOURCE, "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("ambiguity errors list the line of every occurrence", async () => {
    const result = await surgicalReplace(file, [{ find: "= 1;", replace: "= 9;" }]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /appears 2 times \(lines 3, 5\)/);
  });

  test("ambiguity on a single line uses the singular", async () => {
    writeFileSync(file, "ab ab\n", "utf8");
    const result = await surgicalReplace(file, [{ find: "ab", replace: "x" }]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /appears 2 times \(line 1\)/);
  });

  test("returns numbered context around each edit from the final content", async () => {
    const result = await surgicalReplace(file, [{ find: "b = 2", replace: "b = 20" }]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.applied[0]?.context, ["3 | const a = 1;", "4 | const b = 20;", "5 | const c = 1;"].join("\n"));
  });

  test("line and context track later edits that shift earlier ones", async () => {
    const result = await surgicalTransaction([
      {
        file_path: file,
        replacements: [
          { find: "const c = 1;", replace: "const c = 3;" },
          // Inserts two lines above the first edit, pushing it down.
          { find: "import x from 'x';", replace: "import x from 'x';\nimport y from 'y';\nimport z from 'z';" },
        ],
      },
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [first, second] = result.files[0]!.applied;
    assert.equal(first?.line, 7);
    assert.match(first?.context ?? "", /^7 \| const c = 3;$/m);
    assert.equal(second?.line, 1);
    assert.equal(second?.context, ["1 | import x from 'x';", "2 | import y from 'y';", "3 | import z from 'z';", "4 | "].join("\n"));
  });

  test("truncates the middle of large edited regions", async () => {
    const big = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = await surgicalReplace(file, [{ find: "const b = 2;", replace: big }]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const context = result.applied[0]!.context.split("\n");
    assert.equal(context.length, 11);
    assert.match(context[5]!, /\| …$/);
  });

  test("the success message includes the context", async () => {
    const result = await surgicalTransaction([{ file_path: file, replacements: [{ find: "b = 2", replace: "b = 20" }] }]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(formatTransaction(result), /\(line 4\).*\n {6}3 \| const a = 1;\n {6}4 \| const b = 20;/);
  });
});
