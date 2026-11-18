import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConfigError, DEFAULT_LIMITS, parseConfig } from "../src/config.js";
import { surgicalTransaction, type Operation } from "../src/surgical.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "src", "index.ts");
const isWindows = process.platform === "win32";
// Resolved from the repo: the server runs with a temp dir as CWD, where a bare "tsx" can't be found.
const TSX = import.meta.resolve("tsx");

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "surgical-hardening-")));
  root = path.join(base, "root");
  mkdirSync(root);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Snapshot of every file under `dir` (names + bytes), to prove nothing was written. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const p = path.join(dir, name);
    if (statSync(p).isFile()) out[name] = readFileSync(p).toString("base64");
  }
  return out;
}

function runServer(args: string[], cwd = root, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", TSX, SERVER, ...args], {
    cwd,
    env: { ...process.env, SURGICAL_ROOT_DIR: "", ...env },
    input: "",
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("H1/H4: configuration parsing", () => {
  const parse = (args: string[], env: NodeJS.ProcessEnv = {}) => parseConfig(args, env, root);

  test("sandbox is on by default, rooted at the CWD", () => {
    const cfg = parse([]);
    assert.equal(cfg.unsafe, false);
    assert.equal(cfg.rootDir, root);
  });

  test("an empty SURGICAL_ROOT_DIR keeps the CWD sandbox, never disables it", () => {
    assert.equal(parse([], { SURGICAL_ROOT_DIR: "" }).rootDir, root);
  });

  test("--root <dir> and --root=<dir> both work", () => {
    const sub = path.join(root, "sub");
    mkdirSync(sub);
    assert.equal(parse(["--root", sub]).rootDir, sub);
    assert.equal(parse([`--root=${sub}`]).rootDir, sub);
  });

  test("--root wins over SURGICAL_ROOT_DIR, which wins over the CWD", () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    assert.equal(parse([], { SURGICAL_ROOT_DIR: a }).rootDir, a);
    assert.equal(parse(["--root", b], { SURGICAL_ROOT_DIR: a }).rootDir, b);
  });

  for (const [label, args] of [
    ["--root without value", ["--root"]],
    ["--root= with empty value", ["--root="]],
    ["--root followed by another flag", ["--root", "--unsafe-no-root"]],
    ["nonexistent root", ["--root", "/definitely/not/here"]],
    ["unknown argument", ["--rooot", "/tmp"]],
    ["positional argument", ["somewhere"]],
    ["duplicate --root", ["--root", "/tmp", "--root", "/tmp"]],
    ["--root combined with --unsafe-no-root", ["--root", "/tmp", "--unsafe-no-root"]],
  ] as const) {
    test(`rejects ${label}`, () => {
      assert.throws(() => parse([...args]), ConfigError);
    });
  }

  test("rejects a root that is a file", () => {
    const file = path.join(root, "f.txt");
    writeFileSync(file, "x");
    assert.throws(() => parse(["--root", file]), /not a directory/);
  });

  test("rejects an invalid SURGICAL_ROOT_DIR instead of falling back", () => {
    assert.throws(() => parse([], { SURGICAL_ROOT_DIR: "/definitely/not/here" }), ConfigError);
  });

  test("only --unsafe-no-root disables the sandbox", () => {
    const cfg = parse(["--unsafe-no-root"]);
    assert.equal(cfg.unsafe, true);
    assert.equal(cfg.rootDir, undefined);
  });

  test("limits default to documented values and are configurable via env", () => {
    assert.deepEqual(parse([]).limits, DEFAULT_LIMITS);
    assert.equal(parse([], { SURGICAL_MAX_OPERATIONS: "5" }).limits.maxOperations, 5);
    for (const bad of ["0", "-1", "abc", "1.5", "1e3"]) {
      assert.throws(() => parse([], { SURGICAL_MAX_FILE_BYTES: bad }), ConfigError, bad);
    }
  });
});

describe("H1/H4: server process", () => {
  for (const args of [["--root"], ["--root="], ["--bogus"], ["--root", path.join(tmpdir(), "nope-surgical-xyz")]]) {
    test(`exits with an error for ${JSON.stringify(args)}`, () => {
      const r = runServer(args);
      assert.equal(r.status, 2, r.stderr);
      assert.doesNotMatch(r.stderr, /running on stdio/);
    });
  }

  test("starts sandboxed in the CWD by default", () => {
    const r = runServer([]);
    assert.match(r.stderr, new RegExp(`sandbox: ${root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  });

  test("--root=<dir> starts sandboxed in that dir", () => {
    const r = runServer([`--root=${root}`], base);
    assert.match(r.stderr, /running on stdio \(sandbox: /);
    assert.ok(r.stderr.includes(root));
  });

  test("--unsafe-no-root prints a visible warning", () => {
    const r = runServer(["--unsafe-no-root"]);
    assert.match(r.stderr, /WARNING: .*--unsafe-no-root/);
    assert.match(r.stderr, /sandbox: DISABLED/);
  });
});

describe("H1/H4: end-to-end over MCP", () => {
  async function withClient(cwd: string, args: string[], fn: (c: Client) => Promise<void>): Promise<void> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<
      string,
      string
    >;
    delete env.SURGICAL_ROOT_DIR;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", TSX, SERVER, ...args],
      cwd,
      env,
      stderr: "ignore",
    });
    const client = new Client({ name: "hardening-test", version: "0" });
    await client.connect(transport);
    try {
      await fn(client);
    } finally {
      await client.close();
    }
  }

  const call = (c: Client, file_path: string) =>
    c.callTool({
      name: "surgical_replace",
      arguments: { operations: [{ file_path, replacements: [{ find: "v = 1", replace: "v = 2" }] }] },
    });

  test("default sandbox blocks every escape attempt and allows edits inside", async () => {
    const outside = path.join(base, "outside.txt");
    writeFileSync(outside, "v = 1\n");
    symlinkSync(outside, path.join(root, "link.txt"));
    writeFileSync(path.join(root, "inside.txt"), "v = 1\n");

    await withClient(root, [], async (c) => {
      for (const target of ["../outside.txt", outside, "link.txt", `sub/../../outside.txt`]) {
        const r = await call(c, target);
        assert.equal(r.isError, true, target);
        assert.match(JSON.stringify(r.content), /Path traversal blocked/, target);
      }
      const ok = await call(c, "inside.txt");
      assert.notEqual(ok.isError, true);
    });

    assert.equal(readFileSync(outside, "utf8"), "v = 1\n");
    assert.equal(readFileSync(path.join(root, "inside.txt"), "utf8"), "v = 2\n");
  });

  test("--unsafe-no-root allows edits outside the CWD", async () => {
    const outside = path.join(base, "outside.txt");
    writeFileSync(outside, "v = 1\n");
    await withClient(root, ["--unsafe-no-root"], async (c) => {
      const r = await call(c, outside);
      assert.notEqual(r.isError, true);
    });
    assert.equal(readFileSync(outside, "utf8"), "v = 2\n");
  });
});

describe("H3: content protection in errors", () => {
  const miss = (file: string, find: string) =>
    surgicalTransaction([{ file_path: file, replacements: [{ find, replace: "x" }] }], { rootDir: root });

  test("near-miss on a sensitive file reports the line but no content", async () => {
    writeFileSync(path.join(root, ".env"), "DEBUG=1\nAPI_KEY=sk-live-ABCDEF123456\n");
    const r = await miss(".env", "API_KEY=sk-live-ABCDEF12345X");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /Line 2 is \d+% similar \(content hidden: sensitive file\)/);
    assert.doesNotMatch(r.error, /ABCDEF123456/);
  });

  test("near-miss on a regular file redacts secrets but keeps useful context", async () => {
    const token = "ghp_9fK2mQ7xL4pR8sT1vW3yZ6aB5cD0eF2gH4iJ";
    writeFileSync(path.join(root, "config.ts"), `export const apiKey = "${token}"; // github token\n`);
    const r = await miss("config.ts", `export const apiKey = "${token.slice(0, -1)}Q"; // github token`);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.doesNotMatch(r.error, new RegExp(token.slice(4, 20)));
    assert.match(r.error, /Line 1 contains/);
    assert.match(r.error, /export const apiKey/);
    assert.match(r.error, /\[REDACTED\]/);
  });

  test("non-secret near-misses are still shown verbatim", async () => {
    writeFileSync(path.join(root, "a.ts"), "const retries = 3;\n");
    const r = await miss("a.ts", "const retires = 3;");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /'const retries = 3;'/);
  });

  test("a symlink escaping the root does not disclose its target", async () => {
    const hidden = path.join(base, "hidden-dir-name", "target.txt");
    mkdirSync(path.dirname(hidden));
    writeFileSync(hidden, "v = 1\n");
    symlinkSync(hidden, path.join(root, "l.txt"));
    const r = await miss("l.txt", "v = 1");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Path traversal blocked/);
      assert.doesNotMatch(r.error, /hidden-dir-name/);
    }
  });

  test("files outside the root are never read, so nothing about them leaks", async () => {
    writeFileSync(path.join(base, "secret.txt"), "password=hunter2\n");
    const r = await miss("../secret.txt", "password=hunter3");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Path traversal blocked/);
      assert.doesNotMatch(r.error, /hunter2|similar/);
    }
  });

  test("diagnostics are capped at maxDiagnosticChars and keep the no-write notice", async () => {
    writeFileSync(path.join(root, "a.ts"), "x\n");
    const r = await surgicalTransaction([{ file_path: "a.ts", replacements: [{ find: "z".repeat(5_000), replace: "" }] }], {
      rootDir: root,
      limits: { maxDiagnosticChars: 200 },
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.length <= 200, String(r.error.length));
      assert.match(r.error, /No files were written\.$/);
    }
  });
});

describe("H2: permission preservation", { skip: isWindows }, () => {
  async function editWithUmask(mask: number, mode: number): Promise<number> {
    const file = path.join(root, "f.sh");
    writeFileSync(file, "v = 1\n");
    chmodSync(file, mode);
    const previous = process.umask(mask);
    try {
      const r = await surgicalTransaction([{ file_path: file, replacements: [{ find: "v = 1", replace: "v = 2" }] }]);
      assert.equal(r.ok, true);
    } finally {
      process.umask(previous);
    }
    assert.equal(readFileSync(file, "utf8"), "v = 2\n");
    return statSync(file).mode & 0o7777;
  }

  for (const [mask, mode] of [
    [0o077, 0o664],
    [0o077, 0o755],
    [0o022, 0o666],
    [0o027, 0o640],
    [0o000, 0o600],
    [0o777, 0o644],
    [0o022, 0o4755],
    [0o022, 0o2755],
  ] as const) {
    test(`keeps mode ${mode.toString(8)} under umask ${mask.toString(8).padStart(3, "0")}`, async () => {
      assert.equal(await editWithUmask(mask, mode), mode);
    });
  }
});

describe("H7: resource limits", () => {
  let before: Record<string, string>;
  const write = (name: string, text: string) => writeFileSync(path.join(root, name), text);
  const run = (ops: Operation[], limits = {}) => surgicalTransaction(ops, { rootDir: root, limits });

  beforeEach(() => {
    write("a.txt", "v = 1\n");
    write("b.txt", "b = 1\n");
    before = snapshot(root);
  });

  async function expectRejected(ops: Operation[], limits: object, pattern: RegExp): Promise<void> {
    const r = await run(ops, limits);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, pattern);
      assert.match(r.error, /No files were written\./);
    }
    assert.deepEqual(snapshot(root), before, "no file may change and no temp file may remain");
  }

  const okOp = (file = "a.txt"): Operation => ({ file_path: file, replacements: [{ find: file === "b.txt" ? "b = 1" : "v = 1", replace: "x" }] });

  test("rejects files above maxFileBytes without reading them", async () => {
    write("big.txt", "v = 1\n" + "x".repeat(2_000));
    before = snapshot(root);
    await expectRejected([{ file_path: "big.txt", replacements: [{ find: "v = 1", replace: "v = 2" }] }], { maxFileBytes: 1_000 }, /above the 1000-byte limit/);
  });

  test("rejects an edit whose result would exceed maxFileBytes", async () => {
    await expectRejected([{ file_path: "a.txt", replacements: [{ find: "v = 1", replace: "y".repeat(500) }] }], { maxFileBytes: 100 }, /would be \d+ bytes/);
  });

  test("rejects too many operations", async () => {
    await expectRejected([okOp(), okOp("b.txt"), okOp()], { maxOperations: 2 }, /Too many operations: 3, limit is 2/);
  });

  test("rejects too many replacements across the transaction", async () => {
    const ops: Operation[] = [
      { file_path: "a.txt", replacements: [{ find: "v", replace: "v" }, { find: " = ", replace: " = " }] },
      { file_path: "b.txt", replacements: [{ find: "b", replace: "b" }, { find: " = ", replace: " = " }] },
    ];
    await expectRejected(ops, { maxReplacements: 3 }, /Too many replacements/);
  });

  test("rejects an over-long find", async () => {
    await expectRejected([{ file_path: "a.txt", replacements: [{ find: "v".repeat(11), replace: "" }] }], { maxFindChars: 10 }, /"find" is 11 characters, limit is 10/);
  });

  test("rejects an over-long replace", async () => {
    await expectRejected([{ file_path: "a.txt", replacements: [{ find: "v = 1", replace: "r".repeat(11) }] }], { maxReplaceChars: 10 }, /"replace" is 11 characters, limit is 10/);
  });

  test("limits are checked before any file is touched, even missing ones", async () => {
    await expectRejected([okOp("missing.txt"), okOp(), okOp()], { maxOperations: 2 }, /Too many operations/);
  });

  test("requests within the limits still succeed", async () => {
    const r = await run([okOp(), okOp("b.txt")], { maxOperations: 2, maxReplacements: 2, maxFindChars: 5, maxReplaceChars: 1 });
    assert.equal(r.ok, true);
  });
});
