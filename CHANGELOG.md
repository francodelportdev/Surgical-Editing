# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/); while the version is 0.x, a minor bump may contain breaking changes.

## [0.4.0] - 2026-11-18

First release published to npm. It is the result of two security audits; see the README for every guarantee and known limitation.

### Breaking changes

- **The sandbox is on by default**, rooted at the server's working directory (or `--root` / `SURGICAL_ROOT_DIR`). Editing outside it requires the explicit `--unsafe-no-root` flag. Point `--root` at your project in your MCP client configuration.
- **Invalid configuration stops the server** with exit code 2 instead of being ignored: `--root` without a value, a missing root, a repeated `--root`, unknown arguments and invalid limit values.
- **Requires Node.js 22 or later** (was 18).
- **Files with several hard links are rejected**: replacing them would split the links.
- **`find` or `replace` containing `[REDACTED]` is rejected**, so redacted responses can't be written back into files.
- **Responses are redacted**: likely secrets in diffs, context excerpts and errors are replaced with `[REDACTED]`, and dry-run diffs are for review, not for `patch`.
- **Library API**: `surgicalTransaction` and `surgicalReplace` require either `rootDir` or `unsafeNoRoot: true`, and reject invalid `limits`.
- **Resource limits**: oversized files, requests and transactions are rejected (see "Resource limits" in the README).

### Security

- Sandbox escapes through `../`, absolute paths and symlinks are blocked, including symlinks swapped while a transaction runs: files are opened without following symlinks and checked by device and inode before every rename.
- Errors never reveal content from files outside the sandbox, nor where an escaping symlink points; outside paths get the same error whether or not they exist.
- Credential files (`.env`, keys, `.ssh/`, `.aws/`…) never show their values in responses.
- Exact file permissions are kept regardless of the umask, including setuid, setgid and sticky bits.

### Added

- `SURGICAL_RESPONSE_CONTENT=none`: strict mode that keeps file content out of every response.
- Crash-recovery journal: multi-file transactions are all-or-nothing across a crash, and the server recovers interrupted ones at startup.
- Startup warning for temp files left by interrupted transactions (never deleted automatically).
- Configurable resource limits via `SURGICAL_MAX_*` environment variables, and a defensive cap in the MCP tool schema.
- CI on Linux, macOS and Windows with Node 22, 24 and 26; `npm run bench` engine benchmark.

### Fixed

- Concurrent transactions on the same file could silently lose an edit; they now run one at a time per file.
- Changes made by other programs between the read and the commit are detected, including rewrites that keep size and mtime; a rollback never overwrites someone else's edit, and restores atomically.
- Temp files and directories are flushed to disk (`fsync`), so a power loss can't leave a file empty or truncated.
- Ambiguous `find` text on large files and many replacements on a large file could block the server for hours; both are now linear and bounded by a work budget, as is the similarity search.
- Files with multi-megabyte lines could not be edited, and responses included whole lines; displayed lines are now clipped to 400 characters.
- Paths that name a file inside the sandbox in another spelling (macOS `/var` vs `/private/var`, Windows 8.3 short names) were wrongly blocked.
- The version advertised over MCP is read from `package.json`.

## [0.3.0] - 2026-10-25

### Added

- Optional sandbox with `--root` or `SURGICAL_ROOT_DIR`, including protection against symlinks that point outside it.
- Known limitations documented in the README.

## [0.2.0] - 2026-10-25

### Added

- Multi-file transactions: all operations succeed or no file is written.
- Dry run with a unified diff.
- Near-miss diagnostics that point to the most similar line when `find` has no exact match.

[0.4.0]: https://github.com/francodelportdev/Surgical-Editing/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/francodelportdev/Surgical-Editing/releases/tag/v0.3.0
