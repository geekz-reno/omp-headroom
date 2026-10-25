import type { Stats } from "node:fs";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type CcrClearResult, ccrFallbackPath } from "./ccr.ts";
import { CCR_DIR } from "./config.ts";
import { safeSessionId } from "./util.ts";

export interface ArchiveSessionInventory {
  sessionId: string;
  files: number;
  bytes: number;
  modifiedAt: number;
  retainedEntries: number;
}

export interface ArchiveInventory {
  sessions: ArchiveSessionInventory[];
  legacyFiles: number;
  legacyBytes: number;
  /** Unknown files, directories, symlinks, or entries that could not be read. */
  retainedEntries: number;
}

function archiveFilename(name: string): boolean {
  return name.endsWith(".txt") && Boolean(ccrFallbackPath(name.slice(0, -4)));
}

async function directoryInfo(path: string): Promise<Stats | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Archive directory must be a regular directory, not a symlink: ${path}`);
    }
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function unchangedDirectory(path: string, expected: Stats): Promise<boolean> {
  const current = await directoryInfo(path);
  return current !== undefined && current.dev === expected.dev && current.ino === expected.ino;
}

/** Inspect only recognized CCR files; never read originals or follow links. */
export async function listArchiveInventory(dir = CCR_DIR): Promise<ArchiveInventory> {
  const inventory: ArchiveInventory = {
    sessions: [],
    legacyFiles: 0,
    legacyBytes: 0,
    retainedEntries: 0,
  };
  const root = await directoryInfo(dir);
  if (!root) return inventory;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!(await unchangedDirectory(dir, root))) throw new Error("Archive directory changed");
    const path = join(dir, entry.name);
    let info: Stats;
    try {
      info = await lstat(path);
    } catch {
      inventory.retainedEntries += 1;
      continue;
    }
    if (info.isFile() && archiveFilename(entry.name)) {
      inventory.legacyFiles += 1;
      inventory.legacyBytes += info.size;
      continue;
    }
    const id = safeSessionId(entry.name);
    if (!id || !info.isDirectory() || info.isSymbolicLink()) {
      inventory.retainedEntries += 1;
      continue;
    }
    const session: ArchiveSessionInventory = {
      sessionId: id,
      files: 0,
      bytes: 0,
      modifiedAt: info.mtimeMs,
      retainedEntries: 0,
    };
    try {
      if (!(await unchangedDirectory(path, info))) throw new Error("Archive session changed");
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children) {
        if (!(await unchangedDirectory(path, info))) throw new Error("Archive session changed");
        if (!archiveFilename(child.name)) {
          session.retainedEntries += 1;
          continue;
        }
        try {
          const file = await lstat(join(path, child.name));
          if (!file.isFile() || file.isSymbolicLink()) {
            session.retainedEntries += 1;
            continue;
          }
          session.files += 1;
          session.bytes += file.size;
          session.modifiedAt = Math.max(session.modifiedAt, file.mtimeMs);
        } catch {
          session.retainedEntries += 1;
        }
      }
    } catch {
      session.retainedEntries += 1;
    }
    inventory.sessions.push(session);
    inventory.retainedEntries += session.retainedEntries;
  }
  inventory.sessions.sort(
    (left, right) =>
      right.modifiedAt - left.modifiedAt || left.sessionId.localeCompare(right.sessionId),
  );
  return inventory;
}

/** Explicit cleanup of one full session ID; legacy and unknown files remain. */
export async function deleteArchiveSession(
  sessionId: unknown,
  dir = CCR_DIR,
): Promise<CcrClearResult> {
  const id = safeSessionId(sessionId);
  if (!id) throw new Error("Archive cleanup requires a valid full session ID");
  const root = await directoryInfo(dir);
  if (!root) return { cleared: true, deletedFiles: 0, retainedEntries: 0 };
  const sessionDir = join(dir, id);
  const session = await directoryInfo(sessionDir);
  if (!session) return { cleared: true, deletedFiles: 0, retainedEntries: 0 };
  const entries = await readdir(sessionDir, { withFileTypes: true });
  let deletedFiles = 0;
  let retainedEntries = 0;
  for (const entry of entries) {
    if (
      !(await unchangedDirectory(dir, root)) ||
      !(await unchangedDirectory(sessionDir, session))
    ) {
      throw new Error("Archive directory changed during cleanup");
    }
    const file = join(sessionDir, entry.name);
    if (!archiveFilename(entry.name)) {
      retainedEntries += 1;
      continue;
    }
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) {
        retainedEntries += 1;
        continue;
      }
      await unlink(file);
      deletedFiles += 1;
    } catch {
      retainedEntries += 1;
    }
  }
  if (retainedEntries === 0) {
    if (
      !(await unchangedDirectory(dir, root)) ||
      !(await unchangedDirectory(sessionDir, session))
    ) {
      throw new Error("Archive directory changed during cleanup");
    }
    try {
      await rmdir(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") retainedEntries += 1;
    }
  }
  return { cleared: retainedEntries === 0, deletedFiles, retainedEntries };
}
