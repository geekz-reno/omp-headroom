import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const STALE_MS = 45 * 60_000;

function ownerIsAlive(record: string): boolean {
  // Accept the legacy PID-only format as well as PID:token records.
  const pid = Number(record.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function createUpdateLock(path: string) {
  let ownedRecord: string | undefined;
  const guard = `${path}.guard`;
  return {
    acquire(): boolean {
      if (ownedRecord) return false;
      // Serialize the entire stale-check/remove/create sequence. A contender
      // cannot unlink a replacement created by another stale-lock reclaimer.
      // Never reap this guard: that would recreate the same unlink race. It is
      // held only while these synchronous filesystem operations run.
      try {
        mkdirSync(guard, { mode: 0o700 });
      } catch {
        return false;
      }
      try {
        try {
          const record = readFileSync(path, "utf8").trim();
          if (ownerIsAlive(record) || Date.now() - statSync(path).mtimeMs <= STALE_MS) {
            return false;
          }
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        }
        const record = `${process.pid}:${randomUUID()}`;
        writeFileSync(path, record, { flag: "wx", mode: 0o600 });
        ownedRecord = record;
        return true;
      } catch {
        return false;
      } finally {
        try {
          rmdirSync(guard);
        } catch {
          // An abandoned guard fails closed rather than permitting two owners.
        }
      }
    },
    release(): void {
      if (!ownedRecord) return;
      try {
        // Live owners are never reaped, so another cooperating acquirer cannot
        // replace this record between the comparison and unlink.
        if (readFileSync(path, "utf8").trim() === ownedRecord) unlinkSync(path);
      } catch {
        // Already gone or replaced; never remove another owner's lock.
      } finally {
        ownedRecord = undefined;
      }
    },
  };
}
