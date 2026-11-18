import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { formatTransaction, surgicalTransaction, type Operation, type TransactionResult } from "../src/surgical.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
const TSX = import.meta.resolve("tsx");
const FILE = "const host = 'db.internal';\nconst retries = 3;\nconst owner = 'franco';\n";
const FILE_WORDS = ["db.internal", "retries", "franco", "const"];

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "surgical-strict-")));
  writeFileSync(path.join(dir, "a.ts"), FILE);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const strict = (ops: Operation[], dryRun = false) => surgicalTransaction(ops, { rootDir: dir, dryRun, responseContent: "none" });
const edit = (find: string, replace: string): Operation[] => [{ file_path: "a.ts", replacements: [{ find, replace }] }];

function everythingReturned(r: TransactionResult): string {
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return "";
  return [formatTransaction(r, { responseContent: "none" }), ...r.files.flatMap((f) => [f.diff, ...f.applied.map((a) => a.context)])].join("\n");
}

function assertNoFileContent(text: string): void {
  for (const word of FILE_WORDS) assert.ok(!text.includes(word), `"${word}" leaked:\n${text}`);
}

describe("strict mode: SURGICAL_RESPONSE_CONTENT=none", () => {
  for (const dryRun of [true, false]) {
    test(`${dryRun ? "dry run" : "applied edit"} returns line numbers and structure but no file content`, async () => {
      const out = everythingReturned(await strict(edit("retries = 3", "retries = 5"), dryRun));
      assertNoFileContent(out);
      if (dryRun) {
        assert.match(out, /^@@ -1,4 \+1,4 @@$/m);
        assert.match(out, /^-\[REDACTED\]$/m);
        assert.match(out, /^\+\[REDACTED\]$/m);
      } else {
        assert.match(out, /op #0 #0 \(line 2\): "\[REDACTED\]" → "\[REDACTED\]"/);
        assert.match(out, /2 \| \[REDACTED\]/);
      }
      assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), dryRun ? FILE : FILE.replace("retries = 3", "retries = 5"));
    });
  }

  test("a near miss reports the line and similarity without content", async () => {
    const r = await strict(edit("const retires = 3;", "x"));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Line 2 is \d+% similar \(content hidden: SURGICAL_RESPONSE_CONTENT=none\)/);
      assertNoFileContent(r.error);
    }
  });

  test("an ambiguity lists the lines without echoing the find", async () => {
    const r = await strict(edit("const", "let"));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /"\[REDACTED\]" is ambiguous — it appears 3 times \(lines 1, 2, 3\)/);
      assertNoFileContent(r.error);
    }
  });

  test("sensitive files in strict mode hide keys too, not just values", async () => {
    writeFileSync(path.join(dir, ".env"), "DEBUG=1\nAPI_KEY=sk-live-ABCDEF123456\n");
    const r = await surgicalTransaction([{ file_path: ".env", replacements: [{ find: "DEBUG=1", replace: "DEBUG=0" }] }], {
      rootDir: dir,
      dryRun: true,
      responseContent: "none",
    });
    const out = everythingReturned(r);
    for (const word of ["API_KEY", "sk-live", "DEBUG"]) assert.ok(!out.includes(word), word);
  });

  test("the default mode is unchanged", async () => {
    const r = await surgicalTransaction(edit("retries = 3", "retries = 5"), { rootDir: dir, dryRun: true });
    assert.equal(r.ok, true);
    if (r.ok) assert.match(formatTransaction(r), /\+const retries = 5;/);
  });

  test("an invalid mode is rejected by the library and by the configuration", async () => {
    const r = await surgicalTransaction(edit("retries = 3", "retries = 5"), { rootDir: dir, responseContent: "some" as never });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Invalid responseContent: some/);
    assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), FILE);

    assert.equal(parseConfig([], {}, dir).responseContent, "full");
    assert.equal(parseConfig([], { SURGICAL_RESPONSE_CONTENT: "none" }, dir).responseContent, "none");
    assert.throws(() => parseConfig([], { SURGICAL_RESPONSE_CONTENT: "hidden" }, dir), ConfigError);
  });

  test("the MCP server honours SURGICAL_RESPONSE_CONTENT=none end to end", async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
    delete env.SURGICAL_ROOT_DIR;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", TSX, SERVER],
      cwd: dir,
      env: { ...env, SURGICAL_RESPONSE_CONTENT: "none" },
      stderr: "ignore",
    });
    const client = new Client({ name: "strict-test", version: "0" });
    await client.connect(transport);
    try {
      const texts: string[] = [];
      for (const args of [
        { operations: edit("retries = 3", "retries = 5"), dry_run: true },
        { operations: edit("const retires = 3;", "x") },
        { operations: edit("retries = 3", "retries = 5") },
      ]) {
        const r = await client.callTool({ name: "surgical_replace", arguments: args });
        texts.push((r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n"));
      }
      assertNoFileContent(texts.join("\n"));
      assert.match(texts[2]!, /Applied 1 replacement/);
    } finally {
      await client.close();
    }
  });
});
