import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** True if `target` is `root` or below it; path.relative avoids the prefix bug where "/srv/app-evil" passes for "/srv/app". */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Hidden sibling ".<name>.<12 hex>.tmp"; the startup scan for leftovers relies on this exact shape. */
export function tempPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
}

/** Persists the entries of each directory; best-effort because Windows and some filesystems can't fsync one. */
export async function syncDirectories(paths: readonly string[]): Promise<void> {
  for (const directory of new Set(paths)) {
    try {
      const handle = await fs.open(directory, fs.constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Nothing to undo: the data is written, only this extra flush is skipped.
    }
  }
}

/** Creates `filePath` exclusively, writes `data` and flushes it before returning. */
export async function writeDurably(filePath: string, data: Uint8Array, mode = 0o600): Promise<void> {
  const handle = await fs.open(filePath, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
