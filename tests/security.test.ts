import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { surgicalReplace, surgicalTransaction } from "../src/surgical.js";

describe("security hardening", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    // realpath: on some systems tmpdir() is itself a symlink (e.g. macOS /var).
    base = realpathSync(mkdtempSync(path.join(tmpdir(), "surgical-editing-")));
    root = path.join(base, "root");
    mkdirSync(root);
  });

  afterEach(() => {
    mock.restoreAll();
    rmSync(base, { recursive: true, force: true });
  });

  describe("sandbox", () => {
    test("blocks paths that escape SURGICAL_ROOT_DIR via ../", async () => {
      const outside = path.join(base, "outside.ts");
      writeFileSync(outside, "secret = 1\n", "utf8");

      const result = await surgicalReplace("../outside.ts", [{ find: "secret = 1", replace: "secret = 2" }], {
        rootDir: root,
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /Path traversal blocked/);
      assert.equal(readFileSync(outside, "utf8"), "secret = 1\n");
    });

    test("blocks symlinks inside the root that point outside it", async () => {
      const outside = path.join(base, "outside.ts");
      writeFileSync(outside, "secret = 1\n", "utf8");
      symlinkSync(outside, path.join(root, "link.ts"));

      const result = await surgicalReplace("link.ts", [{ find: "secret = 1", replace: "secret = 2" }], {
        rootDir: root,
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /Path traversal blocked: .* resolves to/);
      assert.equal(readFileSync(outside, "utf8"), "secret = 1\n");
    });

    test("allows relative paths inside the root", async () => {
      writeFileSync(path.join(root, "ok.ts"), "a = 1\n", "utf8");
      const result = await surgicalReplace("ok.ts", [{ find: "a = 1", replace: "a = 2" }], { rootDir: root });

      assert.equal(result.ok, true);
      assert.equal(readFileSync(path.join(root, "ok.ts"), "utf8"), "a = 2\n");
    });
  });

  test("edits the symlink target and keeps the link intact", async () => {
    const target = path.join(root, "real.ts");
    const link = path.join(root, "link.ts");
    writeFileSync(target, "value = 1\n", "utf8");
    symlinkSync(target, link);

    const result = await surgicalReplace(link, [{ find: "value = 1", replace: "value = 2" }]);

    assert.equal(result.ok, true);
    assert.equal(readFileSync(target, "utf8"), "value = 2\n");
    assert.ok(lstatSync(link).isSymbolicLink());
  });

  describe("encoding", () => {
    test("rejects invalid UTF-8 without writing", async () => {
      const file = path.join(root, "latin1.txt");
      const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
      writeFileSync(file, bytes);

      const result = await surgicalReplace(file, [{ find: "caf", replace: "tea" }]);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /File is not valid UTF-8 or is binary/);
      assert.deepEqual(readFileSync(file), bytes);
    });

    test("rejects binary content containing NUL bytes", async () => {
      const file = path.join(root, "image.bin");
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x41]);
      writeFileSync(file, bytes);

      const result = await surgicalReplace(file, [{ find: "A", replace: "B" }]);

      assert.equal(result.ok, false);
      assert.deepEqual(readFileSync(file), bytes);
    });

    test("preserves a UTF-8 BOM after editing", async () => {
      const file = path.join(root, "bom.ts");
      writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first = 1\n", "utf8")]));

      // `find` anchored at the start proves the BOM is not part of the content.
      const result = await surgicalReplace(file, [{ find: "first = 1", replace: "first = 2" }]);

      assert.equal(result.ok, true);
      const written = readFileSync(file);
      assert.deepEqual(written.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
      assert.equal(written.subarray(3).toString("utf8"), "first = 2\n");
    });
  });

  test("aborts on concurrent modification detected before rename", async () => {
    const fileA = path.join(root, "a.ts");
    const fileB = path.join(root, "b.ts");
    writeFileSync(fileA, "a = 1\n", "utf8");
    writeFileSync(fileB, "b = 1\n", "utf8");

    // Reads go through untouched; the pre-commit re-check of b.ts sees a
    // newer mtime, as if an editor saved it while temps were being staged.
    const realStat = fs.stat.bind(fs);
    const statCalls = new Map<string, number>();
    mock.method(fs, "stat", async (p: string) => {
      const stats = await realStat(p);
      const n = (statCalls.get(p) ?? 0) + 1;
      statCalls.set(p, n);
      if (p === fileB && n > 1) return Object.assign(stats, { mtimeMs: stats.mtimeMs + 5_000 });
      return stats;
    });

    const result = await surgicalTransaction([
      { file_path: fileA, replacements: [{ find: "a = 1", replace: "a = 2" }] },
      { file_path: fileB, replacements: [{ find: "b = 1", replace: "b = 2" }] },
    ]);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, `Concurrent modification detected on ${fileB}. Transaction aborted for safety.`);
    assert.equal(readFileSync(fileA, "utf8"), "a = 1\n");
    assert.equal(readFileSync(fileB, "utf8"), "b = 1\n");
    assert.deepEqual(readdirSync(root).sort(), ["a.ts", "b.ts"]);
  });
});
