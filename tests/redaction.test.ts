import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSecretKey, redactLine } from "../src/redact.js";
import { formatTransaction, surgicalTransaction } from "../src/surgical.js";

const REDACT_MODULE = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/redact.ts")).href;
const TSX = import.meta.resolve("tsx");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "surgical-redaction-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("R1: secrets that used to slip through", () => {
  const cases: [string, string, string][] = [
    ['password = "correct horse battery staple"', "horse", 'password = "[REDACTED]"'],
    ["password: my secret pass", "secret pass", "password: [REDACTED]"],
    ["PASS=hunter2", "hunter2", "PASS=[REDACTED]"],
    ["DB_PASS=hunter2", "hunter2", "DB_PASS=[REDACTED]"],
    ["Authorization: Token abc123def456", "abc123def456", "Authorization: [REDACTED]"],
    ["aws_key = AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE", "aws_key = [REDACTED]"],
    ['stripe = "sk_test_4eC39HqLyjWDarjtT1"', "4eC39Hq", 'stripe = "[REDACTED]"'],
    ["jdbc:mysql://db?user=app&password=hunter2", "hunter2", "jdbc:mysql://db?user=app&password=[REDACTED]"],
    ['{ "clientSecret": "s3cr3t value", "id": 1 }', "s3cr3t", '{ "clientSecret": "[REDACTED]", "id": 1 }'],
    ["if (token === 'abc def') {", "abc def", "if (token === '[REDACTED]') {"],
    ["db.password := s3cr3t value // load", "s3cr3t", "db.password := [REDACTED] // load"],
    ["url = https://admin:hunter2@example.com/x", "hunter2", "url = https://admin:[REDACTED]@example.com/x"],
    ["headers: { auth: 'Bearer abcdefgh12345678' }", "abcdefgh", "headers: { auth: '[REDACTED]' }"],
    ["key: ghp_9fK2mQ7xL4pR8sT1vW3yZ6aB5cD0eF2gH4iJ", "9fK2mQ7x", "key: [REDACTED]"],
    ["x = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N", "eyJhbGci", "x = [REDACTED]"],
    ['const t = "9fK2mQ7xL4pR8sT1vW3yZ6aB5cD0eF2gH4iJ";', "9fK2mQ7x", 'const t = "[REDACTED]";'],
    ["token = \"unterminated secret", "unterminated", 'token = "[REDACTED]'],
  ];
  for (const [line, secret, expected] of cases) {
    test(JSON.stringify(line), () => {
      const out = redactLine(line);
      assert.ok(!out.includes(secret), out);
      assert.equal(out, expected);
    });
  }
});

describe("R2: ordinary code is left alone", () => {
  for (const line of [
    "commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    'id = "550e8400-e29b-41d4-a716-446655440000"',
    'import { format } from "../../utils/helpers/v2/format.js";',
    'const author = "Franco";',
    "sessionTimeout = 30",
    "const tokenizer = new Tokenizer();",
    "integrity sha512-Xo1zEvwmT7hp9vY0R1aT5wxQ4mF7dH2nU3P6cK8bL0sA",
    "export function parseHttp2ConnectionHeaders123()",
    'const passport = require("passport");',
    "const keyboard = { primaryKey: id };",
    "if (a == b) return c;",
    "const retries = 3; const host = \"localhost\";",
    "background: url(data:image/png;base64,iVBORw0KGgo);",
  ]) {
    test(JSON.stringify(line), () => assert.equal(redactLine(line), line));
  }

  test("secret keys are matched by whole words", () => {
    for (const key of ["password", "API_KEY", "apiKey", "dbPass", "OAuthToken", "client_secret", "AWS_SECRET_ACCESS_KEY", "pw"]) {
      assert.equal(isSecretKey(key), true, key);
    }
    for (const key of ["author", "tokenizer", "sessionTimeout", "passport", "bypass", "keyboard", "primaryKey", "authorId"]) {
      assert.equal(isSecretKey(key), false, key);
    }
  });
});

describe("redaction stays linear on long lines", () => {
  test("adversarial 200 KB lines are redacted quickly", () => {
    const shapes = `[
      "x".repeat(200_000),
      "a=".repeat(100_000),
      "a:b ".repeat(50_000),
      'token="' + "a".repeat(200_000),
      "password= x" + " ".repeat(200_000) + "y",
      "http" + "a".repeat(200_000),
    ]`;
    // Child process with a deadline: a quadratic regex blocks the thread and can't be interrupted in-process.
    const script = `const { redactLine } = await import(${JSON.stringify(REDACT_MODULE)}); for (const line of ${shapes}) redactLine(line);`;
    const child = spawnSync(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(child.signal, null, "redaction did not finish within 30 s");
    assert.equal(child.status, 0, child.stderr);
  });
});

describe("R3: the agent's own find is not echoed with secrets", () => {
  test("ambiguity on a sensitive file hides the values in the echoed find", async () => {
    writeFileSync(path.join(dir, ".env"), "API_KEY=sk-live-ABCDEF123456\nAPI_KEY=sk-live-ABCDEF123456\n");
    const r = await surgicalTransaction([{ file_path: ".env", replacements: [{ find: "API_KEY=sk-live-ABCDEF123456", replace: "x" }] }], { rootDir: dir });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.doesNotMatch(r.error, /sk-live/);
      assert.match(r.error, /"API_KEY=\[REDACTED\]" is ambiguous — it appears 2 times \(lines 1, 2\)/);
    }
  });

  test("a miss on a regular file redacts secrets in the echoed find and keeps the rest", async () => {
    writeFileSync(path.join(dir, "a.ts"), "const x = 1;\n");
    const r = await surgicalTransaction([{ file_path: "a.ts", replacements: [{ find: 'const password = "hunter2";', replace: "x" }] }], { rootDir: dir });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.doesNotMatch(r.error, /hunter2/);
      assert.match(r.error, /const password = \\"\[REDACTED\]\\";/);
    }
  });

  test("success output redacts the find/replace previews too", async () => {
    writeFileSync(path.join(dir, "a.ts"), "const password = null;\n");
    const r = await surgicalTransaction([{ file_path: "a.ts", replacements: [{ find: "password = null", replace: 'password = "hunter2"' }] }], { rootDir: dir });
    assert.equal(r.ok, true);
    if (r.ok) assert.doesNotMatch(formatTransaction(r), /hunter2/);
  });

  test("the library result object keeps the caller's own find/replace verbatim (documented)", async () => {
    writeFileSync(path.join(dir, "a.ts"), "const password = null;\n");
    const r = await surgicalTransaction([{ file_path: "a.ts", replacements: [{ find: "password = null", replace: 'password = "hunter2"' }] }], { rootDir: dir, dryRun: true });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.files[0]!.applied[0]!.replace, 'password = "hunter2"');
  });
});

describe("redaction marker guard", () => {
  for (const field of ["find", "replace"] as const) {
    test(`rejects a ${field} containing [REDACTED] before touching any file`, async () => {
      writeFileSync(path.join(dir, "a.ts"), 'const apiKey = "real";\n');
      const replacement =
        field === "find"
          ? { find: 'const apiKey = "[REDACTED]";', replace: "x" }
          : { find: 'const apiKey = "real";', replace: 'const apiKey = "[REDACTED]";' };
      const r = await surgicalTransaction(
        [
          { file_path: "a.ts", replacements: [replacement] },
          { file_path: "missing.ts", replacements: [{ find: "a", replace: "b" }] },
        ],
        { rootDir: dir },
      );
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.match(r.error, new RegExp(`Operation #0, Replacement #0: "${field}" contains \\[REDACTED\\], the marker this server uses`));
        assert.match(r.error, /No files were written\.$/);
      }
      assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), 'const apiKey = "real";\n');
      assert.deepEqual(readdirSync(dir), ["a.ts"]);
    });
  }

  test("text that only resembles the marker is still allowed", async () => {
    writeFileSync(path.join(dir, "a.ts"), "x = 1\n");
    const r = await surgicalTransaction([{ file_path: "a.ts", replacements: [{ find: "x = 1", replace: "x = [redacted]" }] }], { rootDir: dir });
    assert.equal(r.ok, true);
  });
});
