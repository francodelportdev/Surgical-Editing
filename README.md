# Surgical Editing

**Transactional file editing for AI agents: atomic multi-file changes that protect your code, and self-correcting errors that save tokens.**

An exact-match editing engine for any MCP client (Cline, Claude Desktop, Python agents, CI/CD pipelines…), exposed as a single tool: `surgical_replace`.

## What is Surgical Editing?

Agents often rewrite whole lines or blocks just to change one word. That costs output tokens and time, and every retyped character is another chance to break something. With Surgical Editing (Edición Quirúrgica, also called Delta Generation) the model sends only the exact snippet to find and its replacement.

`surgical_replace` guarantees:

- **Exact and unique:** every `find` must appear **exactly once** in its file. If it appears 0 times or more than once, the call fails. Edits never use fuzzy matching and never guess.
- **Transactional:** one call can edit many files. If any replacement fails, **no file is written**.
- **Self-correcting errors:** on a miss, the error points to the most similar region of the file, so the agent can fix its snippet without re-reading the file.
- **Dry run:** validate everything and get a unified diff without touching the disk.
- **Efficient I/O:** each file is read once, edited in memory and written once.

## Usage

### Multi-file transaction

```json
{
  "operations": [
    {
      "file_path": "src/config.ts",
      "replacements": [{ "find": "port = 3000", "replace": "port = 8080" }]
    },
    {
      "file_path": "src/server.ts",
      "replacements": [{ "find": "listen(port)", "replace": "listen(port, host)" }]
    }
  ],
  "dry_run": false
}
```

- Replacements run in order. Operations that target the same file are applied one after another on the same in-memory content.
- A `$` in `replace` is inserted as-is and is never read as a regex pattern (`$&`, `$1`…).
- The legacy v1 form `{ "file_path": "...", "replacements": [...] }` is still accepted. Don't combine it with `operations` in the same call.

### Error diagnostics

When a `find` has no exact match, the tool looks for a region at least 80% similar and reports it. If the only difference is whitespace or line endings, the error adds a hint:

```
Operation #0, Replacement #0 (/repo/src/app.ts): No exact match found. Line 12 contains (96% similar): 'const x = 1'. Hint: File uses CRLF line endings. No files were written.
```

Ambiguous matches report how many times the snippet appears and on which lines (`appears 3 times (lines 4, 18, 52)`), so the agent knows which context to add.

The similarity search has a fixed work budget. When a file or snippet is too large for it to finish quickly (for example a 2000-character snippet against a file with very long lines), the suggestion is skipped and only the main "not found" error is returned.

### Verifiable results

On success, each replacement comes back with its final line number and a numbered excerpt of the result, so the agent can check its edit without re-reading the file:

```
Applied 1 replacement(s) across 1 file(s):
  /repo/src/config.ts
    op #0 #0 (line 4): "retries = 3" → "retries = 5"
      3 | const host = "localhost";
      4 | const retries = 5;
      5 | export { port, host, retries };
``` File system errors (missing files, permission denied, read-only file systems) are returned as structured MCP errors (`isError: true`).

### Dry run

With `"dry_run": true`, the tool runs every validation and returns a unified diff per file, without writing anything:

```diff
--- /repo/src/config.ts
+++ /repo/src/config.ts
@@ -1,3 +1,3 @@
 import { env } from "./env";
-export const port = 3000;
+export const port = 8080;
 export const host = env.HOST;
```

The diff is meant for review, not for `patch`/`git apply`: lines are redacted as described in [Secrets in responses](#secrets-in-responses), so it is not guaranteed to apply as a patch.

## How atomicity works

1. Every file is read and every replacement is validated in memory. Any failure aborts the call before anything is written.
2. Each new version is written to a temp file next to its target and flushed to disk (`fsync`). Most I/O failures (permissions, a full disk) happen at this step, while the originals are still untouched. If one fails, all temp files are removed.
3. Before the first rename, every file is checked against what was read: same file (inode), same mtime and size, and the same bytes. Right before each rename the cheap checks run again.
4. The temp files replace the originals via `rename()`, which is atomic per file on POSIX. If a rename still fails, files that were already replaced are rolled back, again through a temp file and `rename()`, so a restore is atomic too. A file is only restored if it still holds exactly what this transaction wrote; if someone edited it in the meantime, their edit is kept and the error names the file.
5. After the renames, each affected directory is flushed too, so the renames survive a power loss. This step is best-effort: Windows and some filesystems can't flush a directory, and a failure there doesn't undo an applied transaction.

**What survives a crash.** If the server process is killed or the machine loses power, each file is either entirely old or entirely new: never empty, truncated or mixed. A multi-file transaction is also all-or-nothing across a crash, through a journal:

- Before its first rename, the transaction writes and flushes a copy of every original and a manifest (with SHA-256 hashes of the old and new content) to `<root>/.surgical-journal/<id>/`. The journal is deleted as soon as the transaction finishes. Single-file transactions don't need one, because one rename is already atomic.
- At startup, before serving any request, the server looks for journals left by a crash. If every file already has its new content, the transaction is kept as complete. Otherwise each file that has its new content is restored from its copy, atomically. A file that someone changed after the crash is left as it is and reported. A journal whose manifest was never completely written means no file had been touched yet, so it is just discarded. Every outcome is printed on stderr.
- The journal can't be edited through the tool, and a manifest that points outside the root is ignored.
- Add `.surgical-journal/` to your `.gitignore`. It only exists while a transaction is running or after a crash. While it exists it holds copies of the original files, which may include secrets; it is readable only by the server's user (directories `0700`, files `0600`), and recovery deletes it.
- The journal needs a sandbox root to live in: with `--unsafe-no-root` there is no journal, and multi-file transactions are atomic per file only across a crash.

Temp files (`.<name>.<12 hex digits>.tmp`) that a crash leaves behind outside any journal are reported too. At startup the server scans the sandbox root (skipping `node_modules`, `.git` and the journal, up to 100,000 entries) and prints a warning listing them. It never deletes them: review them and delete them yourself.

## Installation

Requires Node.js 22 or later.

```bash
git clone <repo> surgical-editing
cd surgical-editing
npm install
npm run build
```

Once the package is on npm, you can run it with `npx -y surgical-editing` instead.

## Configuration

### Claude Code

```bash
claude mcp add surgical-editing-server -- node /absolute/path/to/surgical-editing/dist/index.js
# or, once it is on npm:
claude mcp add surgical-editing-server -- npx -y surgical-editing
```

### Other MCP clients

Most clients (Cline, Claude Desktop via `claude_desktop_config.json`, project `.mcp.json`) accept this shape:

```json
{
  "mcpServers": {
    "surgical-editing-server": {
      "command": "node",
      "args": ["/absolute/path/to/surgical-editing/dist/index.js"]
    }
  }
}
```

### Sandbox (on by default)

Edits are restricted to one directory tree. The root is, in order of precedence:

1. `--root <dir>` or `--root=<dir>`
2. the `SURGICAL_ROOT_DIR` environment variable
3. the server's current working directory

Relative `file_path` values resolve against the root. Any target outside it fails with `Path traversal blocked`, including through a symlink that points outside the root (the error does not reveal where the link points).

```json
{
  "mcpServers": {
    "surgical-editing-server": {
      "command": "node",
      "args": ["/absolute/path/to/surgical-editing/dist/index.js", "--root", "/path/to/project"]
    }
  }
}
```

Invalid configuration is fatal (exit code 2) and never falls back to running unsandboxed: `--root` without a value, a root that doesn't exist or isn't a directory, a repeated `--root`, and any unknown argument are all rejected.

To disable the sandbox you must pass `--unsafe-no-root` explicitly. The server then prints a warning on stderr and the tool description tells the agent that the sandbox is disabled. In this mode the agent can edit any file the server's user can write.

### Resource limits

Every request is checked against these limits before any file is touched. Exceeding one returns a clear error and writes nothing. Override them with environment variables (positive integers; an invalid value stops the server):

| Limit | Default | Variable |
|---|---|---|
| File size (read, and size of the edited result) | 10 MiB (10485760 bytes) | `SURGICAL_MAX_FILE_BYTES` |
| Operations per transaction | 100 | `SURGICAL_MAX_OPERATIONS` |
| Replacements per transaction (all files) | 1000 | `SURGICAL_MAX_REPLACEMENTS` |
| Characters in one `find` | 100000 | `SURGICAL_MAX_FIND_CHARS` |
| Characters in one `replace` | 1000000 | `SURGICAL_MAX_REPLACE_CHARS` |
| Characters in an error message | 2000 | `SURGICAL_MAX_DIAGNOSTIC_CHARS` |
| Work per transaction, in characters scanned | 1000000000 | `SURGICAL_MAX_WORK_CHARS` |

The MCP tool schema also rejects requests above **twice** these limits, as a backstop that stops absurdly large requests before they reach the engine. Between the limit and twice the limit the engine answers, with the detailed messages above; beyond it the client gets a schema validation error such as `Too big: expected array to have <=200 items at operations`.

Each replacement scans its whole file once, so the work of a transaction is roughly the sum, over every replacement, of the size of its file. A transaction above the budget (for example 1000 replacements on a 10 MB file) is rejected before any edit is applied, with a message that suggests fewer, larger replacements or several smaller transactions. The default keeps the worst accepted transaction at a few seconds on a typical machine.

## Safety guarantees

- **Symlinks:** edits are applied to the file the link points to, and the link stays intact.
- **Paths swapped during a transaction:** the sandbox root is resolved once per transaction. The file is opened without following a symlink in its last component, and after reading, its directory must still resolve to itself inside the root. Before any rename, and again right before each one, the server checks that the root, the directory and the file are the very same objects it read (same device and inode, not a symlink). If anything was swapped, the transaction is aborted and files already replaced are restored. This applies to dry runs too, so a diff never shows content read through a swapped path. Temp files are created exclusively (`O_EXCL`) and are only deleted when the path still names the temp file the server created; one that ended up in a directory that was moved away is left there, and the error names it.
- **Permissions:** the exact permission bits, setuid/setgid/sticky included, are restored on the new file regardless of the server's umask.
- **Encoding:** invalid UTF-8 and binary files (with NUL bytes) are rejected before anything is written. A UTF-8 BOM is preserved.
- **Concurrent changes:** transactions handled by the same server process never run at the same time on the same physical file (symlinks and different relative paths included): the second one waits, then reads the result of the first. Files are locked in a fixed order, so multi-file transactions can't deadlock. Against other processes (an editor, another server, a build tool) protection is optimistic: if a file's content, mtime, size or identity changes between the read and the commit, the whole transaction is aborted. Comparing the bytes catches tools that rewrite a file while preserving its size and mtime (`rsync -t`, `cp -p`, `tar`).

### Secrets in responses

Everything the server returns is redacted line by line before it reaches the agent: near-miss hints, the numbered context of applied edits, the `find`/`replace` previews and dry-run diffs (removed, added and context lines alike). Only responses are redacted; the file on disk always receives the exact text the agent sent.

- **Credential files** (`.env*`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, `.netrc`, `credentials`, anything under `.ssh/`, `.aws/`, `.gnupg/`…): keys and structure stay visible, values never do. `API_KEY=sk-live-…` is shown as `API_KEY=[REDACTED]`; lines that aren't `key = value` / `key: value` (such as PEM bodies) become `[REDACTED]`. Near-miss errors report only the line number.
- **Other files:** only likely secrets are replaced with `[REDACTED]`:
  - the whole value (quoted, or bare up to `,` `;` `#` `)` `//` or the end of the line) assigned to a key whose words include `password`, `pass`, `pw`, `token`, `secret`, `auth`, `authorization`, `credential`, `bearer`, or the pairs `api key`, `access key`, `private key`, `secret key`, `client secret`. Keys are split into words, so `apiKey`, `API_KEY` and `db.password` match while `author`, `tokenizer`, `passport` or `sessionTimeout` don't;
  - well-known token formats (AWS `AKIA…`, GitHub `ghp_…`, GitLab `glpat-…`, Slack `xox…`, Stripe `sk_live_…`, `sk-…` API keys, Google `AIza…`, npm `npm_…`, JWTs), bearer/basic credentials, passwords in URLs and PEM headers;
  - long random-looking strings: 24+ characters mixing upper case, lower case and at least three separate runs of digits. Hex hashes (git SHAs, checksums), UUIDs, `sha512-…` integrity hashes, paths and ordinary identifiers stay verbatim.

The same redaction applies to the `find` text echoed in "ambiguous" and "not found" errors. It runs in linear time, so long minified lines can't stall a response.

**Long lines.** Each line a response shows is cut to 400 characters, at a word boundary so no piece of a long token appears, and marked `…[+N chars]`. This keeps responses small for minified files and data blobs.

**Strict mode.** Set `SURGICAL_RESPONSE_CONTENT=none` (or pass `responseContent: "none"` to the library) to keep file content out of every response: diffs, context excerpts, `find`/`replace` previews and near-miss hints show only `[REDACTED]` lines, line numbers and counts. Use it when files may hold secrets that no pattern recognises. The default, `full`, returns redacted content as described above.

Redaction is pattern-based and best-effort. It still misses secrets with no telling key name (`const p = "hunter2"`, `mysql -phunter2`), values on a different line from their key, and short tokens of unknown formats; occasionally it may hide a harmless random-looking string.

**Redacted text can't be written back.** Any `find` or `replace` containing `[REDACTED]` is rejected before any file is touched, so an agent can't copy a redacted response into a file. The literal text `[REDACTED]` therefore can't be written with this tool.

The library result object (`files[].applied[].find` / `.replace`) is not redacted: it holds the caller's own input verbatim. Only the formatted response, the `context` and the `diff` are redacted.

## Library API

`surgicalTransaction(operations, options)` and `surgicalReplace(path, replacements, options)` can be imported from `dist/surgical.js`. They have no sandbox unless you ask for one, so a sandbox choice is required:

- `rootDir`: restrict edits to this directory. It is canonicalized with `realpath`, so a root reached through a symlink (for example `/var` → `/private/var` on macOS) works with paths written either way.
- `unsafeNoRoot: true`: edit anywhere the process can write.

Passing neither, or both, fails with an error and writes nothing.

With a `rootDir`, multi-file transactions keep a crash-recovery journal. The MCP server recovers it at startup; a program that uses the library directly should do the same once, before its first transaction: `await recoverJournals(rootDir)` from `dist/journal.js`, which returns one line per journal it handled.

`limits` accepts any subset of the [resource limits](#resource-limits). Omitted or `undefined` fields use the default; `0` means nothing is allowed; any other value that isn't a non-negative integer (`NaN`, `Infinity`, negatives, fractions, strings) rejects the call without touching files.

### Known limitations

These come from Node.js and POSIX file semantics. They are documented on purpose rather than patched with non-portable workarounds.

- **Residual race window:** the checks run right before each `rename()`, but a write by another process that lands in the microseconds between the last check and the `rename()` can still be lost; the same applies to a rollback restore. Closing that gap needs advisory locks (`flock`), which Node.js does not expose portably, and which other programs would also have to honour.
- **Swaps by a concurrent local process:** the checks above shrink the window to the time between the last check and the `rename()` call (microseconds), but can't close it: that needs `openat`/`renameat`-style calls, which Node.js doesn't expose. The sandbox is meant to contain the paths an agent sends, not a hostile process that already has write access inside the root and races the server.
- **Windows:** there is no `O_NOFOLLOW`, so the "last component is not a symlink" protection on open is missing there; the identity checks before rename still apply. Creating symlinks on Windows requires extra privileges by default, which makes this attack harder.
- **Hard links:** a file is replaced through temp file + `rename()`, which would split a file with several hard links (the other links would keep the old content). Such files are therefore rejected with a clear error and nothing is written; remove the extra links first, or edit the file with another tool.
- **A busy server answers late, not never:** the engine runs on Node's single thread, so while one transaction computes, other requests wait. The resource limits bound that wait to a few seconds per transaction (see [Resource limits](#resource-limits)). Running the engine in worker threads would remove the wait but would split the per-file locks and the journal across threads, adding more risk than it removes.
- **File ownership:** permission bits are preserved, but the owner and group are not. If the server runs as a different user than the file's owner, the edited file will belong to the server's user.

## Development

CI runs the full test suite on Linux, macOS and Windows with Node 22, 24 and 26 (`.github/workflows/ci.yml`).


```bash
npm run dev        # run from source with tsx
npm run build      # compile to dist/
npm run typecheck  # type-check src/ and tests/
npm test           # typecheck, then run the node:test suite
npm run bench      # engine benchmark; pass another engine to compare: npm run bench -- path/to/surgical.ts
```

## Acknowledgements

The security audits and hardening of this project were carried out with the help of Claude (Anthropic), working under the owner's review and approval.

## License

MIT
