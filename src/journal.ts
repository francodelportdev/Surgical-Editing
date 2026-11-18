// Crash recovery for multi-file transactions; see README "What survives a crash".
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isInside, syncDirectories, tempPathFor, writeDurably } from "./paths.js";

export const JOURNAL_DIR = ".surgical-journal";
const MANIFEST = "manifest.json";

interface JournalEntry {
  target: string;
  backup: string;
  tmp: string;
  mode: number;
  originalHash: string;
  newHash: string;
}

interface Manifest {
  version: 1;
  created: string;
  entries: JournalEntry[];
}

export interface JournalFile {
  target: string;
  tmp: string;
  mode: number;
  original: Uint8Array;
  next: Uint8Array;
}

export interface Journal {
  /** Removes the journal once the transaction is complete or fully rolled back. */
  finish(): Promise<void>;
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function journalRoot(realRoot: string): string {
  return path.join(realRoot, JOURNAL_DIR);
}

/** Writes and flushes a backup of every original plus the manifest; the transaction may only rename after this. */
export async function beginJournal(realRoot: string, files: readonly JournalFile[]): Promise<Journal> {
  const base = journalRoot(realRoot);
  const dir = path.join(base, `${Date.now()}-${randomBytes(6).toString("hex")}`);
  for (let attempt = 0; ; attempt++) {
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(dir, { mode: 0o700 });
      break;
    } catch (err) {
      // Another transaction's finish() may remove the empty base between the two mkdir calls.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 3) throw err;
    }
  }
  try {
    const entries: JournalEntry[] = [];
    for (const [i, file] of files.entries()) {
      const backup = path.join(dir, `${i}.orig`);
      await writeDurably(backup, file.original);
      entries.push({ target: file.target, backup, tmp: file.tmp, mode: file.mode, originalHash: sha256(file.original), newHash: sha256(file.next) });
    }
    const manifest: Manifest = { version: 1, created: new Date().toISOString(), entries };
    // Written last: a manifest that exists and parses means every backup is already on disk.
    await writeDurably(path.join(dir, MANIFEST), Buffer.from(JSON.stringify(manifest)));
    await syncDirectories([dir, base, realRoot]);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    async finish() {
      await fs.rm(dir, { recursive: true, force: true });
      // Removed only when empty, so the project isn't left with a stray folder; ENOTEMPTY means others are running.
      await fs.rmdir(base).catch(() => undefined);
      await syncDirectories([base, realRoot]);
    },
  };
}

function parseManifest(raw: string, realRoot: string, dir: string): Manifest | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const m = data as Manifest;
  if (m?.version !== 1 || !Array.isArray(m.entries)) return undefined;
  const journalDir = journalRoot(realRoot);
  for (const e of m.entries) {
    const strings = [e?.target, e?.backup, e?.tmp, e?.originalHash, e?.newHash];
    if (strings.some((v) => typeof v !== "string") || typeof e.mode !== "number") return undefined;
    // A tampered manifest must not make recovery write outside the root or into the journal itself.
    if (!isInside(realRoot, e.target) || isInside(journalDir, e.target) || !isInside(realRoot, e.tmp)) return undefined;
    if (path.dirname(e.backup) !== dir) return undefined;
  }
  return m;
}

async function hashOf(filePath: string): Promise<string | undefined> {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) return undefined;
    return sha256(await fs.readFile(filePath));
  } catch {
    return undefined;
  }
}

async function restoreFromBackup(entry: JournalEntry): Promise<void> {
  const original = await fs.readFile(entry.backup);
  if (sha256(original) !== entry.originalHash) throw new Error("backup does not match its recorded hash");
  const tmp = tempPathFor(entry.target);
  try {
    await writeDurably(tmp, original, entry.mode & 0o7777);
    await fs.chmod(tmp, entry.mode & 0o7777);
    await fs.rename(tmp, entry.target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** Finishes or undoes transactions interrupted by a crash; returns one human-readable line per journal handled. */
export async function recoverJournals(realRoot: string): Promise<string[]> {
  const base = journalRoot(realRoot);
  let names: string[];
  try {
    names = (await fs.readdir(base)).sort();
  } catch {
    return [];
  }
  const report: string[] = [];
  for (const name of names) {
    const dir = path.join(base, name);
    const raw = await fs.readFile(path.join(dir, MANIFEST), "utf8").catch(() => undefined);
    const manifest = raw === undefined ? undefined : parseManifest(raw, realRoot, dir);
    if (manifest === undefined) {
      // Without a complete manifest no rename had started, so the originals are intact.
      await fs.rm(dir, { recursive: true, force: true });
      report.push(`Discarded an incomplete journal (${name}); no file had been changed.`);
      continue;
    }

    const states = await Promise.all(
      manifest.entries.map(async (e) => {
        const hash = await hashOf(e.target);
        return hash === e.newHash ? "new" : hash === e.originalHash ? "old" : "other";
      }),
    );
    const restored: string[] = [];
    const leftAlone: string[] = [];
    const failed: string[] = [];
    const complete = states.every((s) => s === "new");
    for (const [i, entry] of manifest.entries.entries()) {
      if (!complete && states[i] === "new") {
        try {
          await restoreFromBackup(entry);
          restored.push(entry.target);
        } catch {
          failed.push(entry.target);
        }
      } else if (states[i] === "other") {
        leftAlone.push(entry.target);
      }
      // Only our own staged temp file is removed: it must still hold exactly the new content.
      if ((await hashOf(entry.tmp)) === entry.newHash) await fs.unlink(entry.tmp).catch(() => undefined);
    }
    await syncDirectories(manifest.entries.map((e) => path.dirname(e.target)));

    let line = complete
      ? `Recovered an interrupted transaction (${name}): all ${states.length} files already had their new content, so it was kept.`
      : `Rolled back an interrupted transaction (${name}): restored ${restored.length} file(s)${restored.length ? ` (${restored.join(", ")})` : ""}.`;
    if (leftAlone.length > 0) line += ` WARNING: ${leftAlone.join(", ")} changed after the crash and were left as they are; check them.`;
    if (failed.length > 0) {
      line += ` WARNING: could not restore ${failed.join(", ")}; the journal was kept and recovery will retry at the next start.`;
    } else {
      await fs.rm(dir, { recursive: true, force: true });
    }
    report.push(line);
  }
  await fs.rmdir(base).catch(() => undefined);
  return report;
}
