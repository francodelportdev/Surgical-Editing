import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { surgicalTransaction, type Operation } from "../src/surgical.js";

let dir: string;
const realWriteFile = fs.writeFile.bind(fs);
const realRename = fs.rename.bind(fs);

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "surgical-rollback-")));
});
afterEach(() => {
  mock.restoreAll();
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string) => path.join(dir, name);
const read = (name: string) => readFileSync(file(name), "utf8");
const edit = (name: string, from = "v = 1", to = "v = 2"): Operation => ({ file_path: name, replacements: [{ find: from, replace: to }] });
const run = (...ops: Operation[]) => surgicalTransaction(ops, { rootDir: dir });
const exdev = () => Object.assign(new Error("cross-device link"), { code: "EXDEV" });

function assertNoTempFiles(): void {
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
  );
}

/** Runs `action` once, while the first temp file is being staged. */
function duringStaging(action: () => Promise<void>): void {
  let done = false;
  mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (!done) {
      done = true;
      await action();
    }
    return realWriteFile(...args);
  });
}

/** Lets the first rename through, then calls `after` and handles every later rename with `next`. */
function afterFirstRename(after: () => Promise<void>, next: (from: string, to: string) => Promise<void> = realRename): void {
  let calls = 0;
  mock.method(fs, "rename", async (from: string, to: string) => {
    if (++calls === 1) {
      await realRename(from, to);
      await after();
      return;
    }
    return next(from, to);
  });
}

describe("H6-b: changes that keep size and mtime", () => {
  test("an in-place rewrite with the same size and restored mtime is detected every time", async () => {
    for (let trial = 0; trial < 20; trial++) {
      writeFileSync(file("a.txt"), "v = 1\nother = 1\n");
      const before = await fs.stat(file("a.txt"), { bigint: true });
      duringStaging(async () => {
        await realWriteFile(file("a.txt"), "v = 1\nother = 9\n");
        await fs.utimes(file("a.txt"), Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
      });
      const r = await run(edit("a.txt"));
      mock.restoreAll();
      assert.equal(r.ok, false, `trial ${trial}`);
      if (!r.ok) assert.match(r.error, /Concurrent modification detected/);
      assert.equal(read("a.txt"), "v = 1\nother = 9\n", "the other writer's edit must survive");
      assertNoTempFiles();
    }
  });

  test("a change between two renames is caught before the second one, and the first is rolled back", async () => {
    writeFileSync(file("a.txt"), "v = 1\n");
    writeFileSync(file("b.txt"), "v = 1\n");
    afterFirstRename(() => realWriteFile(file("b.txt"), "v = 1 EXTERNAL\n"));
    const r = await run(edit("a.txt"), edit("b.txt"));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Concurrent modification detected on .*b\.txt/);
      assert.match(r.error, /restored to their original content/);
    }
    assert.equal(read("a.txt"), "v = 1\n");
    assert.equal(read("b.txt"), "v = 1 EXTERNAL\n");
    assertNoTempFiles();
  });
});

describe("H6-c: rollback never clobbers someone else's edit", () => {
  test("a file edited after being replaced is left as is and reported", async () => {
    writeFileSync(file("a.txt"), "v = 1\n");
    writeFileSync(file("b.txt"), "v = 1\n");
    afterFirstRename(
      () => realWriteFile(file("a.txt"), "USER EDIT\n"),
      async () => {
        throw exdev();
      },
    );
    const r = await run(edit("a.txt"), edit("b.txt"));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /WARNING: .*a\.txt changed again after being replaced, so they were left as they are instead of being restored/);
      assert.doesNotMatch(r.error, /restored to their original content/);
    }
    assert.equal(read("a.txt"), "USER EDIT\n");
    assert.equal(read("b.txt"), "v = 1\n");
    assertNoTempFiles();
  });

  test("a file replaced by another one after our rename is not restored either", async () => {
    writeFileSync(file("a.txt"), "v = 1\n");
    writeFileSync(file("b.txt"), "v = 1\n");
    afterFirstRename(
      async () => {
        writeFileSync(file("other.txt"), "v = 2\n");
        await realRename(file("other.txt"), file("a.txt"));
      },
      async () => {
        throw exdev();
      },
    );
    const r = await run(edit("a.txt"), edit("b.txt"));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /a\.txt changed again after being replaced/);
    assert.equal(read("a.txt"), "v = 2\n");
  });
});

describe("H6-d: atomic restore", () => {
  test("the original is restored by rename, with its exact mode, never by writing into the target", { skip: process.platform === "win32" }, async () => {
    writeFileSync(file("a.txt"), "v = 1\n");
    writeFileSync(file("b.txt"), "v = 1\n");
    chmodSync(file("a.txt"), 0o640);
    const directWrites: string[] = [];
    mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (args[0] === file("a.txt") || args[0] === file("b.txt")) directWrites.push(String(args[0]));
      return realWriteFile(...args);
    });
    afterFirstRename(
      async () => undefined,
      async (from, to) => {
        if (to === file("b.txt")) throw exdev();
        return realRename(from, to);
      },
    );
    const previous = process.umask(0o077);
    try {
      const r = await run(edit("a.txt"), edit("b.txt"));
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /restored to their original content/);
    } finally {
      process.umask(previous);
    }
    assert.equal(read("a.txt"), "v = 1\n");
    assert.equal(statSync(file("a.txt")).mode & 0o7777, 0o640);
    assert.deepEqual(directWrites, []);
    assertNoTempFiles();
  });

  test("a restore that fails is reported and leaves no temp files", async () => {
    writeFileSync(file("a.txt"), "v = 1\n");
    writeFileSync(file("b.txt"), "v = 1\n");
    afterFirstRename(
      async () => undefined,
      async () => {
        throw exdev();
      },
    );
    const r = await run(edit("a.txt"), edit("b.txt"));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /WARNING: could not restore .*a\.txt; these files contain the new content\./);
    assert.equal(read("a.txt"), "v = 2\n");
    assertNoTempFiles();
  });

  test("mixed outcomes name what was restored and what was left alone", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(file(name), "v = 1\n");
    let calls = 0;
    mock.method(fs, "rename", async (from: string, to: string) => {
      calls++;
      if (calls <= 2) {
        await realRename(from, to);
        if (calls === 2) await realWriteFile(file("b.txt"), "USER EDIT\n");
        return;
      }
      if (to === file("c.txt")) throw exdev();
      return realRename(from, to);
    });
    const r = await run(edit("a.txt"), edit("b.txt"), edit("c.txt"));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /b\.txt changed again after being replaced/);
      assert.match(r.error, /Restored: .*a\.txt\./);
    }
    assert.equal(read("a.txt"), "v = 1\n");
    assert.equal(read("b.txt"), "USER EDIT\n");
    assert.equal(read("c.txt"), "v = 1\n");
    assertNoTempFiles();
  });
});
