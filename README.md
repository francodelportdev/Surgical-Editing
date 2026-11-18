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
2. Each new version is written to a temp file next to its target. Most I/O failures (permissions, a full disk) happen at this step, while the originals are still untouched. If one fails, all temp files are removed.
3. The temp files replace the originals via `rename()`, which is atomic per file on POSIX. If a rename still fails, files that were already replaced are restored to their original content.

## Installation

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

## Safety guarantees

- **Symlinks:** edits are applied to the file the link points to, and the link stays intact.
- **Permissions:** the exact permission bits, setuid/setgid/sticky included, are restored on the new file regardless of the server's umask.
- **Encoding:** invalid UTF-8 and binary files (with NUL bytes) are rejected before anything is written. A UTF-8 BOM is preserved.
- **Concurrent changes:** if a file's mtime or size changes between the read and the commit, the whole transaction is aborted.

### Secrets in responses

Everything the server returns is redacted line by line before it reaches the agent: near-miss hints, the numbered context of applied edits, the `find`/`replace` previews and dry-run diffs (removed, added and context lines alike). Only responses are redacted; the file on disk always receives the exact text the agent sent.

- **Credential files** (`.env*`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, `.netrc`, `credentials`, anything under `.ssh/`, `.aws/`, `.gnupg/`…): keys and structure stay visible, values never do. `API_KEY=sk-live-…` is shown as `API_KEY=[REDACTED]`; lines that aren't `key = value` / `key: value` (such as PEM bodies) become `[REDACTED]`. Near-miss errors report only the line number.
- **Other files:** only likely secrets are replaced with `[REDACTED]`: values of keys like `password`, `token`, `api_key`, `secret`; bearer/basic credentials; passwords in URLs; PEM headers; and long opaque tokens mixing letters and digits (24+ characters). Ordinary code stays verbatim.

Redaction is pattern-based and best-effort: it can miss secrets that look like ordinary text (a short password with no telling key name) and can hide harmless long identifiers such as hashes.

## Library API

`surgicalTransaction(operations, options)` and `surgicalReplace(path, replacements, options)` can be imported from `dist/surgical.js`. They have no sandbox unless you ask for one, so a sandbox choice is required:

- `rootDir`: restrict edits to this directory. It is canonicalized with `realpath`, so a root reached through a symlink (for example `/var` → `/private/var` on macOS) works with paths written either way.
- `unsafeNoRoot: true`: edit anywhere the process can write.

Passing neither, or both, fails with an error and writes nothing.

`limits` accepts any subset of the [resource limits](#resource-limits). Omitted or `undefined` fields use the default; `0` means nothing is allowed; any other value that isn't a non-negative integer (`NaN`, `Infinity`, negatives, fractions, strings) rejects the call without touching files.

### Known limitations

These come from Node.js and POSIX file semantics. They are documented on purpose rather than patched with non-portable workarounds.

- **Residual race window:** the concurrent-modification check runs right before the renames, but a write that lands between that check and the `rename()` can still be lost. Closing that gap needs advisory locks (`flock`), which Node.js does not expose portably.
- **Hard links:** a file is replaced through temp file + `rename()`, so a file with several hard links is split. The edited path gets the new content and the other links keep the old content.
- **File ownership:** permission bits are preserved, but the owner and group are not. If the server runs as a different user than the file's owner, the edited file will belong to the server's user.

## Development

```bash
npm run dev        # run from source with tsx
npm run build      # compile to dist/
npm run typecheck  # type-check src/ and tests/
npm test           # typecheck, then run the node:test suite
```

## License

MIT
