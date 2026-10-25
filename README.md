# Surgical Editing

An MCP server that gives coding agents one tool, `surgical_replace`, for **Surgical Editing** (Edición Quirúrgica).

## What is Surgical Editing?

Agents often rewrite whole lines or blocks just to change one word. That costs output tokens and time, and every retyped character is another chance to break something. With Surgical Editing (also called Delta Generation) the model sends only the exact snippet to find and its replacement.

`surgical_replace` enforces three rules:

- **Exact and unique:** every `find` must appear **exactly once** in the file. If it appears 0 times or more than once, the call fails with a clear error asking for more context. There's no fuzzy matching and no guessing.
- **Atomic:** if any replacement in a call fails, nothing is written.
- **One read, one write:** the file is read once, edited in memory and written back atomically (temp file + `rename`).

## Tool schema

```json
{
  "file_path": "src/app.ts",
  "replacements": [
    { "find": "const retries = 3", "replace": "const retries = 5" }
  ]
}
```

Replacements run in order against the in-memory content. A `$` in `replace` is inserted as-is and is never read as a regex pattern.

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

Or add it to `.mcp.json` in your project (or `claude_desktop_config.json` for Claude Desktop):

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
npm run dev     # run from source with tsx
npm run build   # compile to dist/
```

## License

MIT
