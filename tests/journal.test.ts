import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JOURNAL_DIR, recoverJournals } from "../src/journal.js";
import { surgicalTransaction, type Operation } from "../src/surgical.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = pathToFileURL(path.resolve(HERE, "../src/surgical.ts")).href;
const SERVER = path.resolve(HERE, "../src/index.ts");
const TSX = import.meta.resolve("tsx");
// Spread over several directories, so recovery has to handle more than one parent.
const FILES = ["a.txt", "sub/b.txt", "deep/nested/c.txt"];

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "surgical-journal-")));
  for (const name of FILES) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), `${name} = 1\n`);
  }
});
afterEach(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

const read = (name: string) => readFileSync(path.join(root, name), "utf8");
const ops = (): Operation[] => FILES.map((name) => ({ file_path: name, replacements: [{ find: `${name} = 1`, replace: `${name} = 2` }] }));
const tempFiles = () => readdirSync(root, { recursive: true }).map(String).filter((n) => /\.[0-9a-f]{12}\.tmp$/.test(n));

/** Runs the 3-file transaction in a child process that SIGKILLs itself at the chosen point, like a real crash. */
function crash(point: "after-first-rename" | "after-second-rename" | "before-journal-removal" | "while-writing-manifest"): void {
  const killers = {
    "after-first-rename": `let n = 0; const rename = fs.rename.bind(fs);
      mock.method(fs, "rename", async (a, b) => { await rename(a, b); if (++n === 1) process.kill(process.pid, "SIGKILL"); });`,
    "after-second-rename": `let n = 0; const rename = fs.rename.bind(fs);
      mock.method(fs, "rename", async (a, b) => { await rename(a, b); if (++n === 2) process.kill(process.pid, "SIGKILL"); });`,
    "before-journal-removal": `mock.method(fs, "rm", async () => process.kill(process.pid, "SIGKILL"));`,
    "while-writing-manifest": `const open = fs.open.bind(fs);
      mock.method(fs, "open", async (p, ...rest) => { if (String(p).endsWith("manifest.json")) process.kill(process.pid, "SIGKILL"); return open(p, ...rest); });`,
  };
  const script = `
    import fs from "node:fs/promises";
    import { mock } from "node:test";
    const { surgicalTransaction } = await import(${JSON.stringify(ENGINE)});
    ${killers[point]}
    await surgicalTransaction(${JSON.stringify(ops())}, { rootDir: ${JSON.stringify(root)} });
    process.exit(3);`;
  const child = spawnSync(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", `the child must die mid-transaction: ${child.stderr}`);
}

describe("crash recovery journal", () => {
  test("a crash between renames is rolled back at recovery: every file returns to its original", async () => {
    crash("after-first-rename");
    assert.equal(read("a.txt"), "a.txt = 2\n", "precondition: the crash left the transaction half-applied");
    assert.equal(read("sub/b.txt"), "sub/b.txt = 1\n");

    const report = await recoverJournals(root);
    assert.equal(report.length, 1);
    assert.match(report[0]!, /Rolled back an interrupted transaction .*: restored 1 file\(s\)/);
    for (const name of FILES) assert.equal(read(name), `${name} = 1\n`);
    assert.deepEqual(tempFiles(), []);
    assert.equal(existsSync(path.join(root, JOURNAL_DIR)), false);
  });

  test("a crash after two of three renames rolls both back, across directories", async () => {
    crash("after-second-rename");
    assert.equal(read("sub/b.txt"), "sub/b.txt = 2\n", "precondition: two files were replaced");
    assert.equal(read("deep/nested/c.txt"), "deep/nested/c.txt = 1\n");

    const report = await recoverJournals(root);
    assert.match(report[0]!, /restored 2 file\(s\)/);
    for (const name of FILES) assert.equal(read(name), `${name} = 1\n`);
    assert.deepEqual(tempFiles(), []);
  });

  test("recovery is idempotent: a second run finds nothing and changes nothing", async () => {
    crash("after-first-rename");
    await recoverJournals(root);
    assert.deepEqual(await recoverJournals(root), []);
    for (const name of FILES) assert.equal(read(name), `${name} = 1\n`);
  });

  test("a restore that fails keeps the journal, and the next recovery finishes the job", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    crash("after-first-rename");
    const directory = root;
    chmodSync(directory, 0o555);
    let first: string[];
    try {
      first = await recoverJournals(root);
    } finally {
      chmodSync(directory, 0o755);
    }
    assert.match(first[0]!, /WARNING: could not restore .*a\.txt; the journal was kept and recovery will retry/);
    assert.equal(read("a.txt"), "a.txt = 2\n");
    assert.ok(existsSync(path.join(root, JOURNAL_DIR)));

    const second = await recoverJournals(root);
    assert.match(second[0]!, /Rolled back an interrupted transaction .*restored 1 file\(s\)/);
    for (const name of FILES) assert.equal(read(name), `${name} = 1\n`);
    assert.equal(existsSync(path.join(root, JOURNAL_DIR)), false);
  });

  test("a crash after every rename keeps the completed transaction", async () => {
    crash("before-journal-removal");
    const report = await recoverJournals(root);
    assert.match(report[0]!, /all 3 files already had their new content, so it was kept/);
    for (const name of FILES) assert.equal(read(name), `${name} = 2\n`);
    assert.equal(existsSync(path.join(root, JOURNAL_DIR)), false);
  });

  test("a file edited by someone after the crash is left alone and reported", async () => {
    crash("after-first-rename");
    writeFileSync(path.join(root, "a.txt"), "USER EDIT\n");
    const report = await recoverJournals(root);
    assert.match(report[0]!, /WARNING: .*a\.txt changed after the crash and were left as they are/);
    assert.equal(read("a.txt"), "USER EDIT\n");
    assert.equal(read("sub/b.txt"), "sub/b.txt = 1\n");
  });

  test("a crash while the journal is being written changed nothing and is discarded", async () => {
    crash("while-writing-manifest");
    const report = await recoverJournals(root);
    assert.match(report[0]!, /Discarded an incomplete journal .*no file had been changed/);
    for (const name of FILES) assert.equal(read(name), `${name} = 1\n`);
    assert.equal(existsSync(path.join(root, JOURNAL_DIR)), false);
  });

  test("a tampered manifest can't make recovery write outside the root", async () => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    writeFileSync(outside, "outside = 1\n");
    try {
      const dir = path.join(root, JOURNAL_DIR, "1-evil");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "0.orig"), "EVIL\n");
      const entry = { target: outside, backup: path.join(dir, "0.orig"), tmp: path.join(root, ".x.0123456789ab.tmp"), mode: 0o644, originalHash: "x", newHash: "y" };
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, created: "", entries: [entry] }));
      const report = await recoverJournals(root);
      assert.match(report[0]!, /Discarded an incomplete journal/);
      assert.equal(readFileSync(outside, "utf8"), "outside = 1\n");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("the journal can't be edited through the tool", async () => {
    const inside = path.join(root, JOURNAL_DIR, "1-x");
    mkdirSync(inside, { recursive: true });
    writeFileSync(path.join(inside, "manifest.json"), "v = 1\n");
    const r = await surgicalTransaction([{ file_path: `${JOURNAL_DIR}/1-x/manifest.json`, replacements: [{ find: "v = 1", replace: "v = 2" }] }], { rootDir: root });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Path blocked: .* is inside the crash-recovery journal/);
  });

  test("successful transactions leave no journal behind, and single-file ones never create one", async () => {
    const created: string[] = [];
    const mkdir = fs.mkdir.bind(fs);
    mock.method(fs, "mkdir", async (p: string, ...rest: unknown[]) => {
      created.push(String(p));
      return (mkdir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    });
    assert.equal((await surgicalTransaction([ops()[0]!], { rootDir: root })).ok, true);
    assert.equal(created.length, 0);
    assert.equal((await surgicalTransaction(ops().slice(1), { rootDir: root })).ok, true);
    assert.ok(created.some((p) => p.includes(JOURNAL_DIR)));
    assert.equal(existsSync(path.join(root, JOURNAL_DIR)), false);
  });

  test("the server recovers interrupted transactions at startup, before serving", () => {
    crash("after-first-rename");
    const child = spawnSync(process.execPath, ["--import", TSX, SERVER], {
      cwd: root,
      env: { ...process.env, SURGICAL_ROOT_DIR: "" },
      input: "",
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.match(child.stderr, /surgical-editing: Rolled back an interrupted transaction/);
    assert.ok(child.stderr.indexOf("Rolled back") < child.stderr.indexOf("running on stdio"));
    for (const name of FILES) assert.equal(read(name), `${name} = 1\n`);
  });
});
