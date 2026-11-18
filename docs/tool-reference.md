# `surgical_replace` tool reference

Surgical Editing exposes a single MCP tool, `surgical_replace`. Every capability (single edits, multi-file transactions, dry runs) goes through it. This page describes its input, what it returns, and every error it can produce, with what the agent should do about each one.

For installation, configuration and the guarantees behind the tool, see the [README](../README.md).

- [Input](#input)
- [Rules for `find` and `replace`](#rules-for-find-and-replace)
- [What happens during a call](#what-happens-during-a-call)
- [Output](#output)
- [Errors](#errors)
- [Recommended workflow for agents](#recommended-workflow-for-agents)
- [Server messages on stderr](#server-messages-on-stderr)

## Input

```json
{
  "operations": [
    {
      "file_path": "src/config.ts",
      "replacements": [
        { "find": "port = 3000", "replace": "port = 8080" },
        { "find": "retries = 3", "replace": "retries = 5" }
      ]
    },
    {
      "file_path": "src/server.ts",
      "replacements": [{ "find": "listen(port);", "replace": "listen(port, host);" }]
    }
  ],
  "dry_run": false
}
```

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `operations` | array of operations | Yes (or the legacy form) | | Edits to apply as one transaction: all of them are written, or none. At least 1, at most the operations limit (default 100). |
| `operations[].file_path` | string | Yes | | File to edit. Relative paths resolve against the sandbox root; absolute paths must lie inside it. |
| `operations[].replacements` | array of replacements | Yes | | Replacements for this file, applied in order. At least 1. |
| `replacements[].find` | string | Yes | | Exact text to replace. Must occur **exactly once** in the file at the moment it is applied. Not empty; at most 100,000 characters by default. |
| `replacements[].replace` | string | Yes | | Text that takes its place. May be empty (deletes `find`). At most 1,000,000 characters by default. |
| `dry_run` | boolean | No | `false` | Validate everything and return a diff without writing any file. |

**Legacy form.** Version 1 accepted a single file at the top level, and it still works:

```json
{ "file_path": "src/config.ts", "replacements": [{ "find": "port = 3000", "replace": "port = 8080" }] }
```

`operations` and the legacy `file_path` + `replacements` can't be combined in one call.

**Limits.** All limits are configurable with `SURGICAL_MAX_*` environment variables; see [Resource limits](../README.md#resource-limits). Requests above **twice** a limit are rejected by the tool schema before they reach the server; between the limit and twice the limit the server rejects them with a detailed message.

## Rules for `find` and `replace`

- **Exact match, exactly once.** `find` is compared character by character, including whitespace, indentation and line endings. If it appears zero times or more than once, the call fails. Overlapping occurrences count: `"aa"` appears twice in `"aaa"`.
- **Order matters.** Replacements in an operation run in order, each on the result of the previous one. Several operations on the same file (even through different paths or a symlink) also compose in order, on the same content.
- **Literal replacement.** `$&`, `$1` and similar sequences in `replace` are inserted as written; they are never regex patterns.
- **No redaction markers.** A `find` or `replace` containing `[REDACTED]` is rejected: that marker is how the server hides secrets in its responses, so it is never the file's real text.
- **Text files only.** Files must be valid UTF-8 without NUL bytes. A UTF-8 BOM is kept.

## What happens during a call

1. **Request checks**: shape of the input, limits, redaction markers. Nothing is read yet.
2. **Path resolution**: every `file_path` is resolved, symlinks followed, and checked against the sandbox.
3. **Locking**: transactions on the same file within the server run one at a time.
4. **Reading**: each file is read once and checked (regular file, size, single hard link, encoding).
5. **Applying in memory**: every replacement is validated and applied to the in-memory content. Any failure stops the call here, before anything is written.
6. **Dry run** stops here and returns the diff.
7. **Commit**: new versions are written to temp files and flushed to disk; every file is checked again for changes by others; multi-file transactions write a crash-recovery journal; then each temp file replaces its original with an atomic rename. If a rename fails, files already replaced are rolled back.

Steps 1 to 6 never write anything. Errors from them always end with **"No files were written."**

## Output

### Successful edit

Each replacement comes back with its final line number and a numbered excerpt of the result, so the agent can verify it without reading the file again:

```
Applied 3 replacement(s) across 2 file(s):
  /repo/src/config.ts
    op #0 #0 (line 2): "port = 3000" → "port = 8080"
      1 | import { env } from "./env";
      2 | export const port = 8080;
      3 | export const host = env.HOST;
    op #0 #1 (line 4): "retries = 3" → "retries = 5"
      3 | export const host = env.HOST;
      4 | export const retries = 5;
      5 |
  /repo/src/server.ts
    op #1 #0 (line 1): "listen(port);" → "listen(port, host);"
      1 | listen(port, host);
      2 | log("ready");
```

`op #N #M` is the operation index and the replacement index within it, both from 0. Large edited regions show only their first and last lines.

### Dry run

A unified diff per file; nothing is written:

```
Dry run: 1 replacement(s) across 1 file(s) validated. No files were written.

--- /repo/src/config.ts
+++ /repo/src/config.ts
@@ -1,5 +1,5 @@
 import { env } from "./env";
-export const port = 3000;
+export const port = 8080;
 export const host = env.HOST;
 export const retries = 3;
```

The diff is for review, not for `patch` or `git apply`: lines may be redacted or clipped, as below.

### What responses never show

Responses go through the same filters, whether they report success or failure:

- **Secrets are redacted.** Likely secrets become `[REDACTED]`. In credential files (`.env`, keys, `.ssh/`, `.aws/`…) only keys and structure are shown, never values. See [Secrets in responses](../README.md#secrets-in-responses).
- **Long lines are clipped** to 400 characters at a word boundary and marked `…[+N chars]`.
- **Strict mode.** With `SURGICAL_RESPONSE_CONTENT=none` every line of file content shows as `[REDACTED]`: only line numbers, counts and the diff's shape remain.

The file on disk always receives exactly the text that was sent; only responses are filtered.

## Errors

Errors come back as an MCP tool result with `isError: true` and a single text message. Messages name the operation and replacement (`Operation #0, Replacement #1`) and the file, so the agent knows exactly which part failed.

**Was anything written?** Every error ends with **"No files were written."**, except those raised during the commit (the last group below). Those either changed nothing or rolled back what they changed, and say so; a `WARNING` marks the rare case where something could not be undone.

### Request

| Message | Meaning | What to do |
|---|---|---|
| `Missing input: provide operations (or the legacy file_path + replacements).` | Neither form was sent. | Send `operations`. |
| `Provide either operations or the legacy file_path + replacements, not both.` | Both forms in one call. | Use only `operations`. |
| `No operations provided.` | Empty `operations` (library calls only; the schema rejects it over MCP). | Add at least one operation. |
| `... no replacements provided.` | An operation with an empty `replacements` list (library calls only). | Add replacements or drop the operation. |
| `"find" must not be empty.` | Empty `find` (library calls only). | Send the text to replace. |
| `"find"` or `"replace" contains [REDACTED], the marker this server uses to hide secrets...` | The text was copied from a redacted response. | Use the real text. If it is a secret you don't have, ask the user. |
| `MCP error -32602: Input validation error: ... Too big: expected array to have <=200 items at operations` | Rejected by the tool schema: a value is over twice its limit, or has the wrong type. | Split the change into smaller calls. |

### Limits

| Message | What to do |
|---|---|
| `Too many operations: N, limit is L (SURGICAL_MAX_OPERATIONS).` | Split into several transactions. |
| `Too many replacements: more than L in one transaction (SURGICAL_MAX_REPLACEMENTS).` | Split into several transactions. |
| `"find" is N characters, limit is L (SURGICAL_MAX_FIND_CHARS).` | Use a shorter, still unique, snippet. |
| `"replace" is N characters, limit is L (SURGICAL_MAX_REPLACE_CHARS).` | Split the change into smaller replacements. |
| `File is N bytes, above the L-byte limit (SURGICAL_MAX_FILE_BYTES).` | The file is too large for this tool; use another tool or ask the user to raise the limit. |
| `the edited file would be N bytes, above the L-byte limit` | The result would exceed the size limit. Same as above. |
| `Transaction too expensive: ... ~N characters of work, above the budget of L (SURGICAL_MAX_WORK_CHARS).` | Each replacement scans its whole file. Use fewer, larger replacements on big files, or several transactions. |

### Paths and sandbox

| Message | Meaning | What to do |
|---|---|---|
| `Path traversal blocked: P is outside SURGICAL_ROOT_DIR (R)` | The path is outside the sandbox root. The answer is the same whether or not the file exists. | Don't look for another way in. If the edit is really needed, ask the user. |
| `Path traversal blocked: P is a symlink that resolves outside SURGICAL_ROOT_DIR (R)` | A symlink inside the root points outside it. | Same as above. |
| `Path blocked: P is inside the crash-recovery journal, which only the server may change` | The target is in `.surgical-journal/`. | Never edit the journal. |
| `File not found: P` | Nothing at that path inside the root. | Check the path. This tool doesn't create files; use another tool for that. |
| `Not a regular file: P` / `Path is a directory, not a file: P` | The path is a directory or a special file. | Target a file. |
| `Permission denied while trying to read/write P` / `Read-only file system, cannot write P` | The server's user can't access the file. | Ask the user. |
| `Sandbox root is not accessible: R` | The configured root disappeared or can't be read. | Ask the user to check the server configuration. |

### File checks

| Message | Meaning | What to do |
|---|---|---|
| `File is not valid UTF-8 or is binary. Surgical editing aborted to prevent corruption.` | Not a UTF-8 text file. | Don't edit it with this tool. |
| `P has N hard links. Editing replaces the file, which would split them...` | Replacing the file would leave its other hard links with the old content. | Ask the user; the extra links must be removed first, or another tool used. |

### Matching

The most common errors. Each carries what the agent needs to fix its snippet, often without reading the file again.

**Ambiguous: `find` appears more than once.**

```
Operation #0, Replacement #0 (/repo/src/server.ts): "find" text "log(\"ready\");" is ambiguous — it appears 2 times (lines 2, 3). Include more surrounding context so it matches exactly once. No files were written.
```

Add neighbouring text (the previous or next line) until the snippet is unique, or use one replacement per occurrence, each with its own context. Lists over ten lines end with `… +N more`.

**Near miss: no exact match, but a similar region exists** (at least 80% similar):

```
Operation #0, Replacement #0 (/repo/src/config.ts): No exact match found. Line 3 contains (93% similar): 'export const host = env.HOST;'. No files were written.
```

Copy the reported text exactly into `find`. When the only difference is whitespace or line endings, a hint says so:

```
... No exact match found. Line 1 contains (100% similar): 'const x = 1
const y = 2'. Hint: File uses CRLF line endings. No files were written.
```

Other hint: `Only whitespace differs (indentation, spaces or tabs).` In credential files and in strict mode the line's content is hidden (`Line 3 is 93% similar (content hidden: sensitive file)`); read the line before retrying.

**Not found: nothing similar.**

```
... "find" text "completely unrelated text here" was not found. It must match the file exactly (whitespace, indentation and line endings included). Re-read the file and retry. No files were written.
```

The snippet is stale or wrong. Read the relevant part of the file again before retrying. The similarity search has a work budget, so on very large inputs this message can also appear when a similar region exists.

### During the commit

These are raised after the edits were validated, while the files are being written.

| Message | Meaning | What to do |
|---|---|---|
| `Concurrent modification detected on P. Transaction aborted for safety.` | Another program changed the file after it was read. Nothing was overwritten. | Read the file again and redo the edit on its current content. |
| `Path changed during the transaction: P (detail). Transaction aborted for safety.` | A file, directory or the root was swapped while the transaction ran, for example a symlink was replaced. | Read again and retry. If it happens again, ask the user: something is changing the project. |
| `Could not write the crash-recovery journal (...). Transaction aborted for safety.` | The journal couldn't be written (disk full, permissions). Nothing was changed. | Ask the user. |
| `Permission denied while trying to write P` and other write errors | A file couldn't be replaced. | Ask the user. |

When a failure happens after some files were already replaced, the message adds what happened to them:

| Addition | Meaning |
|---|---|
| `Files already updated were restored to their original content.` | Full rollback: no file changed. |
| `WARNING: P changed again after being replaced, so they were left as they are instead of being restored; check them.` | Someone edited those files in the meantime; their edit was kept. Check those files before continuing. |
| `WARNING: could not restore P; these files contain the new content.` | Rollback failed for those files. Tell the user. |
| `The crash-recovery journal was kept; the next server start will retry the restore.` | Recovery will be attempted again at the next start. |
| `Temp files were left in place because their directory was moved: ...` | A directory was swapped during the transaction; leftover temp files were not deleted through the changed path. |

## Recommended workflow for agents

1. **Read the region you will change.** Copy `find` text from the file, never from memory or from a redacted response.
2. **Use the smallest unique snippet.** One or two distinctive lines are usually enough.
3. **Group related edits in one call.** A rename across several files is one transaction: it succeeds as a whole or not at all.
4. **Dry run first** when changing several files, configuration or anything sensitive, and check the diff.
5. **Verify with the returned context** instead of reading the file again.
6. **Retry at most twice** using what the error says (lines of the ambiguity, near-miss text, hints). After that, read the file.
7. **Stop and ask the user** when a path is blocked by the sandbox, a file has hard links, permissions are denied, or a `WARNING` appears.

## Server messages on stderr

Messages for whoever runs the server, written to stderr; agents don't see them.

| Message | When |
|---|---|
| `surgical-editing-server MCP server running on stdio (sandbox: R)` | Normal start. |
| `WARNING: surgical-editing is running with --unsafe-no-root. The sandbox is DISABLED...` | Started with `--unsafe-no-root`. |
| `surgical-editing: <error>` followed by the usage, exit code 2 | Invalid configuration: arguments, root or environment variables. |
| `surgical-editing: Rolled back an interrupted transaction (...)`, `Recovered an interrupted transaction (...)` or `Discarded an incomplete journal (...)` | A transaction was interrupted by a crash; recovery ran at startup, before serving any request. |
| `WARNING: found N temp file(s) left by interrupted transactions: ...` | Leftover temp files under the root. They are never deleted automatically; review and delete them. |
