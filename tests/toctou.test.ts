import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { surgicalTransaction, type Operation } from "../src/surgical.js";

let base: string;
let root: string;
let outside: string;

const realRealpath = fs.realpath.bind(fs);
const realWriteFile = fs.writeFile.bind(fs);
const realRename = fs.rename.bind(fs);

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "surgical-toctou-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  mkdirSync(path.join(root, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "sub", "a.txt"), "v = 1\n");
});

afterEach(() => {
  mock.restoreAll();
  rmSync(base, { recursive: true, force: true });
});

const edit = (file: string): Operation => ({ file_path: file, replacements: [{ find: "v = 1", replace: "v = 2" }] });

/** Gives the decoy the same size and mtime as the real file, so only an identity check can tell them apart. */
async function matchDecoy(decoy: string, real: string): Promise<void> {
  const info = await fs.stat(real, { bigint: true });
  await fs.utimes(decoy, Number(info.atimeNs) / 1e9, Number(info.mtimeNs) / 1e9);
}

/** Replaces root/sub with a symlink to the outside directory, which holds a same-looking a.txt. */
async function swapSubdirectoryOutside(): Promise<void> {
  writeFileSync(path.join(outside, "a.txt"), "v = 1\n");
  await matchDecoy(path.join(outside, "a.txt"), path.join(root, "sub", "a.txt"));
  await fs.rename(path.join(root, "sub"), path.join(base, "sub.moved"));
  await fs.symlink(outside, path.join(root, "sub"));
}

/** Runs `swap` once, right after the given call number of fs.realpath (2 = the target's resolution). */
function swapAfterRealpathCall(call: number, swap: () => Promise<void>): void {
  let n = 0;
  mock.method(fs, "realpath", async (p: string) => {
    const result = await realRealpath(p);
    if (++n === call) await swap();
    return result;
  });
}

/** Runs `swap` once, while the first temp file is being staged. */
function swapDuringStaging(swap: () => Promise<void>): void {
  let done = false;
  mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (!done) {
      done = true;
      await swap();
    }
    return realWriteFile(...args);
  });
}

function assertNothingOutside(expected = "v = 1\n"): void {
  if (readdirSync(outside).length === 0) return;
  assert.deepEqual(readdirSync(outside), ["a.txt"], "no temp file may be left outside the root");
  assert.equal(readFileSync(path.join(outside, "a.txt"), "utf8"), expected);
}

function assertNoTempFiles(dir: string): void {
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
  );
}

describe("H8: symlink swaps during a transaction", { skip: process.platform === "win32" }, () => {
  test("a directory swapped for a symlink after validation is detected when the file is read", async () => {
    swapAfterRealpathCall(2, swapSubdirectoryOutside);
    const r = await surgicalTransaction([edit("sub/a.txt")], { rootDir: root });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Path changed during the transaction/);
    assertNothingOutside();
  });

  test("a dry run never shows content read through a swapped directory", async () => {
    swapAfterRealpathCall(2, async () => {
      await swapSubdirectoryOutside();
      writeFileSync(path.join(outside, "a.txt"), "v = 1\nOUTSIDE-ONLY\n");
    });
    const r = await surgicalTransaction([edit("sub/a.txt")], { rootDir: root, dryRun: true });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Path changed during the transaction: .*a directory in its path was replaced/);
      assert.doesNotMatch(r.error, /OUTSIDE-ONLY/);
    }
  });

  test("a file swapped for a symlink after validation is never read or copied into the root", async () => {
    const secret = path.join(outside, "secret.txt");
    writeFileSync(secret, "secret v = 1 data\n");
    swapAfterRealpathCall(2, async () => {
      await fs.rm(path.join(root, "sub", "a.txt"));
      await fs.symlink(secret, path.join(root, "sub", "a.txt"));
    });
    const r = await surgicalTransaction([edit("sub/a.txt")], { rootDir: root });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Path changed during the transaction: .*replaced by a symlink/);
      assert.doesNotMatch(r.error, /secret/);
    }
    assert.ok((await fs.lstat(path.join(root, "sub", "a.txt"))).isSymbolicLink(), "the link must not be replaced by a copy");
    assert.equal(readFileSync(secret, "utf8"), "secret v = 1 data\n");
  });

  test("a dry run never shows content read through a file swapped for a symlink", async () => {
    const secret = path.join(outside, "secret.txt");
    writeFileSync(secret, "secret v = 1 OUTSIDE-ONLY\n");
    swapAfterRealpathCall(2, async () => {
      await fs.rm(path.join(root, "sub", "a.txt"));
      await fs.symlink(secret, path.join(root, "sub", "a.txt"));
    });
    const r = await surgicalTransaction([edit("sub/a.txt")], { rootDir: root, dryRun: true });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /replaced by a symlink/);
      assert.doesNotMatch(r.error, /OUTSIDE-ONLY/);
    }
  });

  test("a directory swapped after the read, while staging, is detected before any rename", async () => {
    swapDuringStaging(swapSubdirectoryOutside);
    const r = await surgicalTransaction([edit("sub/a.txt")], { rootDir: root });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Path changed during the transaction/);
    assertNothingOutside();
    assertNoTempFiles(path.join(base, "sub.moved"));
    assert.equal(readFileSync(path.join(base, "sub.moved", "a.txt"), "utf8"), "v = 1\n");
  });

  test("a file replaced by another one with identical size and mtime is detected", async () => {
    swapDuringStaging(async () => {
      const decoy = path.join(root, "sub", "decoy.txt");
      writeFileSync(decoy, "v = 1\n");
      await matchDecoy(decoy, path.join(root, "sub", "a.txt"));
      await fs.rename(decoy, path.join(root, "sub", "a.txt"));
    });
    const r = await surgicalTransaction([edit("sub/a.txt")], { rootDir: root });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Path changed during the transaction: .*replaced by another file/);
    assert.equal(readFileSync(path.join(root, "sub", "a.txt"), "utf8"), "v = 1\n");
    assertNoTempFiles(path.join(root, "sub"));
  });

  test("a symlinked root retargeted mid-transaction is detected", async () => {
    const alias = path.join(base, "alias");
    symlinkSync(root, alias);
    mkdirSync(path.join(outside, "sub"));
    writeFileSync(path.join(outside, "sub", "a.txt"), "v = 1\n");
    swapDuringStaging(async () => {
      await fs.rm(alias);
      await fs.symlink(outside, alias);
    });
    const r = await surgicalTransaction([edit("sub/a.txt")], { rootDir: alias });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Path changed during the transaction: .*the sandbox root moved/);
    assert.equal(readFileSync(path.join(root, "sub", "a.txt"), "utf8"), "v = 1\n");
    assert.equal(readFileSync(path.join(outside, "sub", "a.txt"), "utf8"), "v = 1\n");
  });

  test("a swap between two renames aborts the second and restores the first", async () => {
    mkdirSync(path.join(root, "other"));
    writeFileSync(path.join(root, "first.txt"), "v = 1\n");
    writeFileSync(path.join(root, "other", "b.txt"), "v = 1\n");
    let renames = 0;
    mock.method(fs, "rename", async (from: string, to: string) => {
      await realRename(from, to);
      if (++renames === 1) {
        writeFileSync(path.join(outside, "b.txt"), "v = 1\n");
        await matchDecoy(path.join(outside, "b.txt"), path.join(root, "other", "b.txt"));
        await realRename(path.join(root, "other"), path.join(base, "other.moved"));
        await fs.symlink(outside, path.join(root, "other"));
      }
    });
    const r = await surgicalTransaction([edit("first.txt"), edit("other/b.txt")], { rootDir: root });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Path changed during the transaction/);
      assert.match(r.error, /restored to their original content/);
      assert.match(r.error, /Temp files were left in place because their directory was moved: \.b\.txt\.[0-9a-f]{12}\.tmp\./);
    }
    assert.equal(readFileSync(path.join(root, "first.txt"), "utf8"), "v = 1\n");
    assert.equal(readFileSync(path.join(outside, "b.txt"), "utf8"), "v = 1\n");
    assertNoTempFiles(outside);
    // The orphan stays in the directory that was moved away, never unlinked through the swapped path.
    assert.equal(readdirSync(path.join(base, "other.moved")).filter((n) => n.endsWith(".tmp")).length, 1);
  });

  test("temp files are created exclusively, never through an existing path", async () => {
    const flags: unknown[] = [];
    mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      flags.push((args[2] as { flag?: string } | undefined)?.flag);
      return realWriteFile(...args);
    });
    const r = await surgicalTransaction([edit("sub/a.txt")], { rootDir: root });
    assert.equal(r.ok, true);
    assert.deepEqual(flags, ["wx"]);
  });

  test("legitimate symlinks keep working: a link to a file inside the root edits its target", async () => {
    symlinkSync(path.join(root, "sub", "a.txt"), path.join(root, "link.txt"));
    const r = await surgicalTransaction([edit("link.txt")], { rootDir: root });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(path.join(root, "sub", "a.txt"), "utf8"), "v = 2\n");
    assert.ok((await fs.lstat(path.join(root, "link.txt"))).isSymbolicLink());
    assert.ok(statSync(path.join(root, "sub", "a.txt")).isFile());
  });
});
