#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatSuccess, surgicalReplace } from "./surgical.js";

const server = new McpServer({ name: "surgical-editing-server", version: "0.1.0" });

server.registerTool(
  "surgical_replace",
  {
    title: "Surgical replace",
    description:
      "Edit a file by sending ONLY the minimal exact snippets to change. Each `find` must appear exactly once " +
      "in the file (add a little surrounding context if needed). All replacements are applied atomically: " +
      "if any fails, the file is not modified. Prefer the smallest unique snippet over rewriting whole lines or blocks.",
    inputSchema: {
      file_path: z.string().min(1).describe("Absolute or relative path to the target file."),
      replacements: z
        .array(
          z.object({
            find: z.string().min(1).describe("Exact text to find. Must occur exactly once in the file."),
            replace: z.string().describe("Exact text that replaces it."),
          }),
        )
        .min(1)
        .describe("Ordered list of replacements, applied sequentially in memory."),
    },
  },
  async ({ file_path, replacements }) => {
    const result = await surgicalReplace(file_path, replacements);
    if (!result.ok) {
      return { isError: true, content: [{ type: "text", text: result.error }] };
    }
    return { content: [{ type: "text", text: formatSuccess(result) }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the MCP protocol; log to stderr only.
  console.error("surgical-editing-server MCP server running on stdio");
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
