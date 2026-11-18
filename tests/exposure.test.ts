import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DEFAULT_LIMITS } from "../src/config.js";
import { formatTransaction, normalizeLimits, surgicalTransaction, type Operation, type TransactionResult } from "../src/surgical.js";

const SECRETS = ["sk-live-ABCDEF123456", "hunter2", "ghp_9fK2mQ7xL4pR8sT1vW3yZ6aB5cD0eF2gH4iJ", "MIIEvQIBADANBg"];

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "surgical-exposure-")));
  root = path.join(base, "root");
  mkdirSync(root);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function everythingReturned(result: TransactionResult): string {
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) return "";
  const fields = result.files.flatMap((f) => [f.diff, ...f.applied.map((a) => a.context)]);
  return [formatTransaction(result), ...fields].join("\n");
}

function assertNoSecrets(text: string): void {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret}:\n${text}`);
}

describe("P1: secrets in successful and dry-run responses", () => {
  const ENV = "DEBUG=1\nAPI_KEY=sk-live-ABCDEF123456\nDB_PASSWORD=hunter2\n";
  const envEdit: Operation[] = [{ file_path: ".env", replacements: [{ find: "DEBUG=1", replace: "DEBUG=0" }] }];

  for (const dryRun of [true, false]) {
    test(`.env ${dryRun ? "dry run" : "applied edit"} shows keys and structure but no values`, async () => {
      writeFileSync(path.join(root, ".env"), ENV);
      const out = everythingReturned(await surgicalTransaction(envEdit, { rootDir: root, dryRun }));
      assertNoSecrets(out);
      assert.match(out, /API_KEY=\[REDACTED\]/);
      if (dryRun) {
        assert.match(out, /^-DEBUG=\[REDACTED\]$/m);
        assert.match(out, /^\+DEBUG=\[REDACTED\]$/m);
        assert.match(out, /^ DB_PASSWORD=\[REDACTED\]$/m);
        assert.match(out, /^@@ -1,4 \+1,4 @@$/m);
      } else {
        assert.match(out, /op #0 #0 \(line 1\): "DEBUG=\[REDACTED\]" → "DEBUG=\[REDACTED\]"/);
        assert.match(out, /1 \| DEBUG=\[REDACTED\]/);
      }
      assert.equal(readFileSync(path.join(root, ".env"), "utf8"), dryRun ? ENV : ENV.replace("DEBUG=1", "DEBUG=0"));
    });
  }

  test("a private key file never shows its body", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
    writeFileSync(path.join(root, "server.pem"), pem);
    const out = everythingReturned(
      await surgicalTransaction(
        [{ file_path: "server.pem", replacements: [{ find: "END PRIVATE KEY-----\n", replace: "END PRIVATE KEY-----\n\n" }] }],
        { rootDir: root, dryRun: true },
      ),
    );
    assertNoSecrets(out);
    assert.doesNotMatch(out, /BEGIN PRIVATE KEY/);
  });

  test("regular files keep non-sensitive lines and new lines verbatim, redacting only secrets", async () => {
    const token = "ghp_9fK2mQ7xL4pR8sT1vW3yZ6aB5cD0eF2gH4iJ";
    writeFileSync(path.join(root, "config.ts"), `const retries = 3;\nconst apiKey = "${token}";\nconst host = "localhost";\n`);
    const ops: Operation[] = [{ file_path: "config.ts", replacements: [{ find: "retries = 3", replace: "retries = 5" }] }];
    for (const dryRun of [true, false]) {
      writeFileSync(path.join(root, "config.ts"), `const retries = 3;\nconst apiKey = "${token}";\nconst host = "localhost";\n`);
      const out = everythingReturned(await surgicalTransaction(ops, { rootDir: root, dryRun }));
      assertNoSecrets(out);
      assert.match(out, /const apiKey = "\[REDACTED\]";/);
      assert.match(out, /const retries = 5;/);
      if (dryRun) {
        assert.match(out, /^-const retries = 3;$/m);
        assert.match(out, /^\+const retries = 5;$/m);
        assert.match(out, /^ const host = "localhost";$/m);
      }
    }
  });

  test("new lines that introduce a secret are redacted too", async () => {
    writeFileSync(path.join(root, "a.ts"), "const password = null;\n");
    const out = everythingReturned(
      await surgicalTransaction(
        [{ file_path: "a.ts", replacements: [{ find: "password = null", replace: 'password = "hunter2"' }] }],
        { rootDir: root, dryRun: true },
      ),
    );
    assertNoSecrets(out);
    assert.match(out, /^\+const password = "\[REDACTED\]";$/m);
  });

  test("the file on disk receives the real values, only responses are redacted", async () => {
    writeFileSync(path.join(root, ".env"), "TOKEN=old\n");
    const result = await surgicalTransaction(
      [{ file_path: ".env", replacements: [{ find: "TOKEN=old", replace: "TOKEN=sk-live-ABCDEF123456" }] }],
      { rootDir: root },
    );
    assertNoSecrets(everythingReturned(result));
    assert.equal(readFileSync(path.join(root, ".env"), "utf8"), "TOKEN=sk-live-ABCDEF123456\n");
  });
});

describe("P2: library API requires an explicit sandbox choice", () => {
  const edit = (file: string): Operation[] => [{ file_path: file, replacements: [{ find: "v = 1", replace: "v = 2" }] }];

  test("rejects calls with neither rootDir nor unsafeNoRoot, writing nothing", async () => {
    const file = path.join(root, "a.txt");
    writeFileSync(file, "v = 1\n");
    for (const options of [undefined, {}, { unsafeNoRoot: false }]) {
      const r = await surgicalTransaction(edit(file), options);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /No sandbox: pass rootDir, or unsafeNoRoot: true.*No files were written\./);
    }
    assert.equal(readFileSync(file, "utf8"), "v = 1\n");
  });

  test("rejects rootDir combined with unsafeNoRoot", async () => {
    writeFileSync(path.join(root, "a.txt"), "v = 1\n");
    const r = await surgicalTransaction(edit("a.txt"), { rootDir: root, unsafeNoRoot: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /mutually exclusive/);
    assert.equal(readFileSync(path.join(root, "a.txt"), "utf8"), "v = 1\n");
  });

  test("unsafeNoRoot: true edits outside any root", async () => {
    const file = path.join(base, "outside.txt");
    writeFileSync(file, "v = 1\n");
    const r = await surgicalTransaction(edit(file), { unsafeNoRoot: true });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(file, "utf8"), "v = 2\n");
  });
});

describe("P3: rootDir is canonicalized", () => {
  let alias: string;
  const edit = (file: string, from = "v = 1", to = "v = 2"): Operation[] => [
    { file_path: file, replacements: [{ find: from, replace: to }] },
  ];

  beforeEach(() => {
    alias = path.join(base, "alias");
    symlinkSync(root, alias);
    writeFileSync(path.join(root, "a.txt"), "v = 1\n");
    writeFileSync(path.join(base, "outside.txt"), "v = 1\n");
  });

  test("a symlinked rootDir accepts relative paths and absolute paths in either spelling", async () => {
    assert.equal((await surgicalTransaction(edit("a.txt"), { rootDir: alias })).ok, true);
    assert.equal((await surgicalTransaction(edit(path.join(alias, "a.txt"), "v = 2", "v = 3"), { rootDir: alias })).ok, true);
    assert.equal((await surgicalTransaction(edit(path.join(root, "a.txt"), "v = 3", "v = 4"), { rootDir: alias })).ok, true);
    assert.equal(readFileSync(path.join(root, "a.txt"), "utf8"), "v = 4\n");
  });

  test("a file inside the root is accepted even when the path names it through another spelling", async () => {
    // The alias plays the role of another spelling of the root, like /var vs /private/var or a Windows 8.3 name.
    const r = await surgicalTransaction(edit(path.join(alias, "a.txt")), { rootDir: root });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(readFileSync(path.join(root, "a.txt"), "utf8"), "v = 2\n");
  });

  test("outside paths get the same error whether or not they exist, so errors can't probe outside the root", async () => {
    const message = async (target: string) => {
      const r = await surgicalTransaction(edit(target), { rootDir: root });
      assert.equal(r.ok, false, target);
      return r.ok ? "" : r.error.replace(target, "<path>");
    };
    const existing = await message(path.join(base, "outside.txt"));
    const missing = await message(path.join(base, "missing.txt"));
    assert.match(existing, /Path traversal blocked: .* is outside SURGICAL_ROOT_DIR/);
    assert.equal(existing, missing);
  });

  test("containment still holds through a symlinked rootDir", async () => {
    symlinkSync(path.join(base, "outside.txt"), path.join(root, "escape.txt"));
    for (const target of ["../outside.txt", path.join(base, "outside.txt"), "escape.txt", path.join(alias, "..", "outside.txt")]) {
      const r = await surgicalTransaction(edit(target), { rootDir: alias });
      assert.equal(r.ok, false, target);
      if (!r.ok) assert.match(r.error, /Path traversal blocked/, target);
    }
    assert.equal(readFileSync(path.join(base, "outside.txt"), "utf8"), "v = 1\n");
  });

  test("a nonexistent rootDir is rejected", async () => {
    const r = await surgicalTransaction(edit("a.txt"), { rootDir: path.join(base, "missing") });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Sandbox root is not accessible/);
  });
});

describe("P4: limit normalization", () => {
  const manyOps = (n: number): Operation[] =>
    Array.from({ length: n }, () => ({ file_path: "a.txt", replacements: [{ find: "v = 1", replace: "v = 1" }] }));

  beforeEach(() => writeFileSync(path.join(root, "a.txt"), "v = 1\n"));

  test("undefined falls back to the default instead of disabling the limit", async () => {
    assert.deepEqual(normalizeLimits({ maxOperations: undefined }), DEFAULT_LIMITS);
    const r = await surgicalTransaction(manyOps(DEFAULT_LIMITS.maxOperations + 1), {
      rootDir: root,
      limits: { maxOperations: undefined },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Too many operations/);
  });

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, 2 ** 53, "5", null]) {
    test(`rejects ${String(bad)} without touching files`, async () => {
      for (const key of Object.keys(DEFAULT_LIMITS)) {
        const limits = { [key]: bad } as never;
        assert.equal(typeof normalizeLimits(limits), "string", key);
        const r = await surgicalTransaction(manyOps(1), { rootDir: root, limits });
        assert.equal(r.ok, false, key);
        if (!r.ok) assert.match(r.error, new RegExp(`Invalid limit ${key}.*No files were written\\.`), key);
      }
      assert.equal(readFileSync(path.join(root, "a.txt"), "utf8"), "v = 1\n");
    });
  }

  test("0 keeps its existing meaning: nothing is allowed", async () => {
    const r = await surgicalTransaction(manyOps(1), { rootDir: root, limits: { maxOperations: 0 } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Too many operations: 1, limit is 0/);
  });

  test("valid overrides still apply", async () => {
    assert.equal(normalizeLimits({ maxOperations: 2 }) instanceof Object, true);
    assert.equal((await surgicalTransaction(manyOps(2), { rootDir: root, limits: { maxOperations: 2 } })).ok, true);
  });
});
