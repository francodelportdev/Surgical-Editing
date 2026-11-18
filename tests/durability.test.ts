import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findOrphanTemps, orphanWarning } from "../src/orphans.js";
import { surgicalTransaction, type Operation } from "../src/surgical.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
const TSX = import.meta.resolve("tsx");
const TEMP = /\.[0-9a-f]{12}\.tmp$/;

let dir: string;
const realOpen = fs.open.bind(fs);
const realRename = fs.rename.bind(fs);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "surgical-durability-")));
});
afterEach(() => {
  mock.restoreAll();
  rmSync(dir, { recursive: true, force: true });
});

const edit = (name: string): Operation => ({ file_path: name, replacements: [{ find: "v = 1", replace: "v = 2" }] });

/** Records "sync <path>" for every fsync and "rename <from> -> <to>" for every rename, in order. */
function traceSyncsAndRenames(failRename?: (to: string) => boolean): string[] {
  const events: string[] = [];
  mock.method(fs, "open", async (p: string, ...rest: unknown[]) => {
    const handle = await (realOpen as (...a: unknown[]) => Promise<fs.FileHandle>)(p, ...rest);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      events.push(`sync ${p}`);
      return sync();
    };
    return handle;
  });
  mock.method(fs, "rename", async (from: string, to: string) => {
    events.push(`rename ${from} -> ${to}`);
    if (failRename?.(to)) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    return realRename(from, to);
  });
  return events;
}

describe("H5: durability", () => {
  test("the temp file is flushed before its rename, and the directory after it", async () => {
    writeFileSync(path.join(dir, "a.txt"), "v = 1\n");
    const events = traceSyncsAndRenames();
    const r = await surgicalTransaction([edit("a.txt")], { rootDir: dir });
    assert.equal(r.ok, true);

    const rename = events.findIndex((e) => e.startsWith("rename "));
    const tmp = events[rename]!.split(" ")[1]!;
    assert.match(tmp, TEMP);
    assert.ok(events.indexOf(`sync ${tmp}`) !== -1 && events.indexOf(`sync ${tmp}`) < rename, events.join("\n"));
    assert.ok(events.indexOf(`sync ${dir}`) > rename, events.join("\n"));
  });

  test("every file of a multi-file transaction is flushed before the first rename", async () => {
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "a.txt"), "v = 1\n");
    writeFileSync(path.join(dir, "sub", "b.txt"), "v = 1\n");
    const events = traceSyncsAndRenames();
    const r = await surgicalTransaction([edit("a.txt"), edit("sub/b.txt")], { rootDir: dir });
    assert.equal(r.ok, true);
    const firstRename = events.findIndex((e) => e.startsWith("rename "));
    assert.equal(events.slice(0, firstRename).filter((e) => TEMP.test(e)).length, 2, events.join("\n"));
    for (const directory of [dir, path.join(dir, "sub")]) assert.ok(events.includes(`sync ${directory}`), directory);
  });

  test("a rollback restore is flushed before its rename as well", async () => {
    writeFileSync(path.join(dir, "a.txt"), "v = 1\n");
    writeFileSync(path.join(dir, "b.txt"), "v = 1\n");
    const events = traceSyncsAndRenames((to) => to === path.join(dir, "b.txt"));
    const r = await surgicalTransaction([edit("a.txt"), edit("b.txt")], { rootDir: dir });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /restored to their original content/);
    const restore = events.filter((e) => e.startsWith(`rename `) && e.endsWith(`-> ${path.join(dir, "a.txt")}`))[1]!;
    const restoreTmp = restore.split(" ")[1]!;
    assert.ok(events.indexOf(`sync ${restoreTmp}`) < events.indexOf(restore), events.join("\n"));
    assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "v = 1\n");
  });

  test("a directory that can't be flushed doesn't fail an applied transaction", async () => {
    writeFileSync(path.join(dir, "a.txt"), "v = 1\n");
    mock.method(fs, "open", async (p: string, ...rest: unknown[]) => {
      if (p === dir) throw Object.assign(new Error("not supported"), { code: "EISDIR" });
      return (realOpen as (...a: unknown[]) => Promise<fs.FileHandle>)(p, ...rest);
    });
    const r = await surgicalTransaction([edit("a.txt")], { rootDir: dir });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "v = 2\n");
  });
});

describe("H5: leftover temp files", () => {
  test("finds temp files anywhere under the root, skipping node_modules and .git", async () => {
    mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(dir, ".git"));
    const orphans = [path.join(dir, ".a.txt.0123456789ab.tmp"), path.join(dir, "src", "deep", ".b.ts.abcdefabcdef.tmp")];
    for (const p of orphans) writeFileSync(p, "x");
    writeFileSync(path.join(dir, "node_modules", "pkg", ".c.js.0123456789ab.tmp"), "x");
    writeFileSync(path.join(dir, ".git", ".d.0123456789ab.tmp"), "x");
    for (const name of ["a.tmp", ".e.txt.XYZ.tmp", ".f.txt.0123456789abc.tmp", "g.txt.0123456789ab.tmp"]) writeFileSync(path.join(dir, name), "x");

    assert.deepEqual(await findOrphanTemps(dir), { found: orphans.sort(), truncated: false });
    assert.equal((await findOrphanTemps(dir, 3)).truncated, true);
    assert.match(orphanWarning({ found: orphans, truncated: false })!, /found 2 temp file\(s\) left by interrupted transactions/);
    assert.equal(orphanWarning({ found: [], truncated: false }), undefined);
  });

  test("the server warns about leftover temp files at startup and never deletes them", () => {
    const orphan = path.join(dir, ".a.txt.0123456789ab.tmp");
    writeFileSync(orphan, "x");
    const child = spawnSync(process.execPath, ["--import", TSX, SERVER], {
      cwd: dir,
      env: { ...process.env, SURGICAL_ROOT_DIR: "" },
      input: "",
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.match(child.stderr, /WARNING: found 1 temp file\(s\) left by interrupted transactions: .*\.a\.txt\.0123456789ab\.tmp/);
    assert.ok(existsSync(orphan));
  });
});

describe("P5: MCP schema backstop", () => {
  async function withClient(env: Record<string, string>, fn: (c: Client) => Promise<void>): Promise<void> {
    const base = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
    delete base.SURGICAL_ROOT_DIR;
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", TSX, SERVER], cwd: dir, env: { ...base, ...env }, stderr: "ignore" });
    const client = new Client({ name: "durability-test", version: "0" });
    await client.connect(transport);
    try {
      await fn(client);
    } finally {
      await client.close();
    }
  }

  /** Calls the tool and returns the error text, whether the SDK reports it as a result or as a rejected call. */
  async function errorText(client: Client, args: Record<string, unknown>): Promise<string> {
    try {
      const r = await client.callTool({ name: "surgical_replace", arguments: args });
      assert.equal(r.isError, true);
      return (r.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
    } catch (err) {
      return String(err);
    }
  }

  test("within twice the limit the engine answers with its detailed message; beyond it the schema rejects the call", async () => {
    writeFileSync(path.join(dir, "a.txt"), "v = 1\n");
    const ops = (n: number) => Array.from({ length: n }, () => edit("a.txt"));
    await withClient({ SURGICAL_MAX_OPERATIONS: "2", SURGICAL_MAX_FIND_CHARS: "10" }, async (c) => {
      assert.match(await errorText(c, { operations: ops(3) }), /Too many operations: 3, limit is 2/);
      const rejected = await errorText(c, { operations: ops(5) });
      assert.doesNotMatch(rejected, /Too many operations/);
      assert.match(rejected, /too_big|too big|Too big|Invalid/i);

      const find = (n: number) => ({ operations: [{ file_path: "a.txt", replacements: [{ find: "v".repeat(n), replace: "" }] }] });
      assert.match(await errorText(c, find(15)), /"find" is 15 characters, limit is 10/);
      assert.doesNotMatch(await errorText(c, find(25)), /"find" is 25 characters/);
    });
    assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "v = 1\n");
  });
});
