import fs from "node:fs/promises";
import path from "node:path";
import { JOURNAL_DIR } from "./journal.js";

// Name given by tempPathFor: ".<file>.<12 hex>.tmp".
const TEMP_NAME = /^\..+\.[0-9a-f]{12}\.tmp$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", JOURNAL_DIR]);

export interface OrphanScan {
  found: string[];
  /** True when the scan stopped at `maxEntries` before covering the whole tree. */
  truncated: boolean;
}

/** Lists temp files left by interrupted transactions under `root`; reads only, never deletes. */
export async function findOrphanTemps(root: string, maxEntries = 100_000): Promise<OrphanScan> {
  const found: string[] = [];
  const pending = [root];
  let seen = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > maxEntries) return { found, truncated: true };
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) pending.push(full);
      else if (entry.isFile() && TEMP_NAME.test(entry.name)) found.push(full);
    }
  }
  return { found: found.sort(), truncated: false };
}

export function orphanWarning({ found, truncated }: OrphanScan, maxListed = 10): string | undefined {
  if (found.length === 0) return undefined;
  const listed = found.slice(0, maxListed).join(", ");
  const more = found.length > maxListed ? ` and ${found.length - maxListed} more` : "";
  return (
    `WARNING: found ${found.length}${truncated ? "+" : ""} temp file(s) left by interrupted transactions: ${listed}${more}. ` +
    "They hold edits that were never applied; review them and delete them. Surgical Editing does not remove them."
  );
}
