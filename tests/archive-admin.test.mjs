import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteArchiveSession, listArchiveInventory } from "../src/archive-admin.ts";

const SESSION_A = "archive-session-A";
const SESSION_B = "archive-session-B";
const HASH = "abcdef0123456789abcdef01";

async function isolated(run) {
  const root = mkdtempSync(join(tmpdir(), "headroom-archive-admin-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function save(dir, sessionId, hash, value) {
  const directory = join(dir, sessionId);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${hash}.txt`);
  writeFileSync(file, value, "utf8");
  return file;
}

describe("archive inventory and selective cleanup", () => {
  test("lists full sessions and legacy byte totals without traversing unknown entries", async () => {
    await isolated(async (root) => {
      const a = save(root, SESSION_A, HASH, "original A");
      save(root, SESSION_A, "second_original", "original B");
      save(root, SESSION_B, HASH, "é");
      writeFileSync(join(root, `${HASH}.txt`), "legacy", "utf8");
      writeFileSync(join(root, "unowned.txt"), "untouched");
      mkdirSync(join(root, "unknown.directory"));
      writeFileSync(join(root, "unknown.directory", `${HASH}.txt`), "never enumerated");
      mkdirSync(join(root, SESSION_A, "nested"));
      writeFileSync(join(root, SESSION_A, "notes.json"), "{}");
      const future = new Date(Date.now() + 10_000);
      utimesSync(a, future, future);

      const inventory = await listArchiveInventory(root);
      expect(inventory.sessions.map((session) => session.sessionId)).toEqual([
        SESSION_A,
        SESSION_B,
      ]);
      expect(inventory.sessions[0]).toMatchObject({ files: 2, bytes: 20, retainedEntries: 2 });
      expect(inventory.sessions[0].modifiedAt).toBeGreaterThanOrEqual(future.getTime() - 1);
      expect(inventory.sessions[1]).toMatchObject({ files: 1, bytes: 2, retainedEntries: 0 });
      expect(inventory.legacyFiles).toBe(1);
      expect(inventory.legacyBytes).toBe(6);
      expect(inventory.retainedEntries).toBe(4);
    });
  });

  test("deletes only the selected session's recognized originals", async () => {
    await isolated(async (root) => {
      const a = save(root, SESSION_A, HASH, "owned A");
      const b = save(root, SESSION_B, HASH, "owned B");
      const legacy = join(root, `${HASH}.txt`);
      writeFileSync(legacy, "unowned legacy");
      expect(await deleteArchiveSession(SESSION_A, root)).toEqual({
        cleared: true,
        deletedFiles: 1,
        retainedEntries: 0,
      });
      expect(existsSync(a)).toBe(false);
      expect(existsSync(join(root, SESSION_A))).toBe(false);
      expect(readFileSync(b, "utf8")).toBe("owned B");
      expect(readFileSync(legacy, "utf8")).toBe("unowned legacy");
    });
  });

  test("retains unknown files, nested directories, and archive symlinks", async () => {
    await isolated(async (root) => {
      const a = save(root, SESSION_A, HASH, "owned A");
      const other = save(root, SESSION_B, HASH, "owned B");
      const unknown = join(root, SESSION_A, "readme.txt");
      writeFileSync(unknown, "unowned");
      mkdirSync(join(root, SESSION_A, "nested"));
      const link = join(root, SESSION_A, "linked_archive.txt");
      symlinkSync(other, link);
      expect((await listArchiveInventory(root)).retainedEntries).toBe(3);
      expect(await deleteArchiveSession(SESSION_A, root)).toEqual({
        cleared: false,
        deletedFiles: 1,
        retainedEntries: 3,
      });
      expect(existsSync(a)).toBe(false);
      expect(existsSync(link)).toBe(true);
      expect(existsSync(unknown)).toBe(true);
      expect(readFileSync(other, "utf8")).toBe("owned B");
    });
  });

  test("rejects traversal and full-ID validation failures", async () => {
    await isolated(async (root) => {
      save(root, SESSION_A, HASH, "owned");
      for (const id of ["../archive-session-A", "archive/session-A", "short", "", null]) {
        await expect(deleteArchiveSession(id, root)).rejects.toThrow(/full session ID/);
      }
      expect(existsSync(join(root, SESSION_A, `${HASH}.txt`))).toBe(true);
    });
  });

  test("does not follow symlink roots or session directories", async () => {
    await isolated(async (base) => {
      const real = join(base, "real");
      const original = save(real, SESSION_A, HASH, "owned elsewhere");
      const rootLink = join(base, "root-link");
      symlinkSync(real, rootLink, "dir");
      await expect(listArchiveInventory(rootLink)).rejects.toThrow(/not a symlink/);
      await expect(deleteArchiveSession(SESSION_A, rootLink)).rejects.toThrow(/not a symlink/);

      const inventoryRoot = join(base, "inventory");
      mkdirSync(inventoryRoot);
      symlinkSync(join(real, SESSION_A), join(inventoryRoot, SESSION_A), "dir");
      expect(await listArchiveInventory(inventoryRoot)).toEqual({
        sessions: [],
        legacyFiles: 0,
        legacyBytes: 0,
        retainedEntries: 1,
      });
      await expect(deleteArchiveSession(SESSION_A, inventoryRoot)).rejects.toThrow(/not a symlink/);
      expect(readFileSync(original, "utf8")).toBe("owned elsewhere");
    });
  });

  test("missing archives are empty and cleanup is idempotent", async () => {
    await isolated(async (base) => {
      const absent = join(base, "absent");
      expect(await listArchiveInventory(absent)).toEqual({
        sessions: [],
        legacyFiles: 0,
        legacyBytes: 0,
        retainedEntries: 0,
      });
      expect(await deleteArchiveSession(SESSION_A, absent)).toEqual({
        cleared: true,
        deletedFiles: 0,
        retainedEntries: 0,
      });
      save(base, SESSION_A, HASH, "original");
      await deleteArchiveSession(SESSION_A, base);
      expect((await deleteArchiveSession(SESSION_A, base)).cleared).toBe(true);
    });
  });
});
