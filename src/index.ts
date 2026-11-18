#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConfigError, parseConfig, USAGE, type ServerConfig } from "./config.js";
import { formatTransaction, surgicalTransaction, type Operation } from "./surgical.js";

/**
 * Sandbox root: `--root <dir>` / `--root=<dir>`, else SURGICAL_ROOT_DIR, else
 * the current directory. Any invalid configuration is fatal; only the explicit
 * `--unsafe-no-root` flag disables the sandbox.
 */
function loadConfig(): ServerConfig {
  try {
    return parseConfig(process.argv.slice(2), process.env, process.cwd());
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`surgical-editing: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
}

const config = loadConfig();
const { rootDir, limits } = config;

const server = new McpServer({ name: "surgical-editing-server", version: "0.3.0" });

const replacementsSchema = z
  .array(
    z.object({
      find: z.string().min(1).describe("Exact text to find. Must occur exactly once in the file."),
      replace: z.string().describe("Exact text that replaces it."),
    }),
  )
  .min(1);

server.registerTool(
  "surgical_replace",
  {
    title: "Surgical replace",
    description:
      "Transactional exact-match editor. Send ONLY the minimal snippets to change, across one or more files. " +
      "Each `find` must appear exactly once in its file. All operations are atomic: if any replacement fails, " +
      "no file is written. On a miss, the error points to the most similar line so you can retry without re-reading. " +
      "Set dry_run to get a unified diff without writing. " +
      (config.unsafe
        ? "WARNING: sandbox disabled (--unsafe-no-root); any file this user can write is editable."
        : `Edits are restricted to ${rootDir}; relative paths resolve against it.`),
    inputSchema: {
      operations: z
        .array(
          z.object({
            file_path: z.string().min(1).describe("Absolute or relative path to the target file."),
            replacements: replacementsSchema.describe("Replacements for this file, applied in order."),
          }),
        )
        .min(1)
        .optional()
        .describe("Edits to apply as one transaction. Operations on the same file compose in order."),
      file_path: z.string().min(1).optional().describe("Legacy single-file form; prefer `operations`."),
      replacements: replacementsSchema.optional().describe("Legacy single-file form; used with `file_path`."),
      dry_run: z.boolean().optional().describe("Validate and return a unified diff without writing. Default false."),
    },
  },
  async ({ operations, file_path, replacements, dry_run }) => {
    // Accept the v1 shape so existing clients keep working, but never both at
    // once: mixing them would leave it unclear which edits the caller intended.
    let ops: Operation[];
    if (operations !== undefined && (file_path !== undefined || replacements !== undefined)) {
      return errorResult("Provide either `operations` or the legacy `file_path` + `replacements`, not both.");
    } else if (operations !== undefined) {
      ops = operations;
    } else if (file_path !== undefined && replacements !== undefined) {
      ops = [{ file_path, replacements }];
    } else {
      return errorResult("Missing input: provide `operations` (or the legacy `file_path` + `replacements`).");
    }

    const result = await surgicalTransaction(ops, { dryRun: dry_run ?? false, rootDir, unsafeNoRoot: config.unsafe, limits });
    if (!result.ok) return errorResult(result.error);
    return { content: [{ type: "text" as const, text: formatTransaction(result) }] };
  },
);

function errorResult(text: string): { isError: true; content: { type: "text"; text: string }[] } {
  return { isError: true, content: [{ type: "text", text }] };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the MCP protocol; log to stderr only.
  if (config.unsafe) {
    console.error(
      "WARNING: surgical-editing is running with --unsafe-no-root. The sandbox is DISABLED: " +
        "the agent can edit any file this user can write.",
    );
    console.error("surgical-editing-server MCP server running on stdio (sandbox: DISABLED)");
  } else {
    console.error(`surgical-editing-server MCP server running on stdio (sandbox: ${rootDir})`);
  }
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
