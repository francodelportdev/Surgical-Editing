# Surgical Editing

A transactional, exact-match file editing engine for any MCP client (Cline, Claude Desktop, Python agents, CI/CD pipelines…), exposed as a single tool: `surgical_replace`.

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

Ambiguous matches report how many times the snippet appears. File system errors (missing files, permission denied, read-only file systems) are returned as structured MCP errors (`isError: true`).

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

Relative `file_path` values resolve against the server's working directory. Use absolute paths when that is ambiguous.

## Development

```bash
npm run dev        # run from source with tsx
npm run build      # compile to dist/
npm run typecheck  # type-check src/ and tests/
npm test           # typecheck, then run the node:test suite
```

## License

MIT
