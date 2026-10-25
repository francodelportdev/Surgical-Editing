#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { formatTransaction, surgicalTransaction, type Operation } from "./surgical.js";

/**
 * Sandbox root from `--root <dir>` or SURGICAL_ROOT_DIR (the flag wins).
 * Resolved once at startup with realpath so comparisons against resolved
 * target paths are reliable; a bad root is fatal rather than silently
 * running unsandboxed.
 */
function resolveRootDir(): string | undefined {
  const flagIndex = process.argv.indexOf("--root");
  const raw = flagIndex !== -1 ? process.argv[flagIndex + 1] : process.env.SURGICAL_ROOT_DIR;
  if (raw === undefined || raw === "") return undefined;
  try {
    return realpathSync(raw);
  } catch {
    console.error(`Invalid sandbox root (SURGICAL_ROOT_DIR / --root): ${raw}`);
    process.exit(1);
  }
}

const rootDir = resolveRootDir();

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
      "Set dry_run to get a unified diff without writing.",
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

    const result = await surgicalTransaction(ops, { dryRun: dry_run ?? false, rootDir });
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
  console.error(`surgical-editing-server MCP server running on stdio${rootDir ? ` (sandbox: ${rootDir})` : ""}`);
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
