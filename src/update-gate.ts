import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { UPDATE_LOCK_FILE, VENV_DIR } from "./config.ts";

export const UPDATE_GATE_MARKER_FILE = join(dirname(VENV_DIR), ".headroom-compatibility.json");

export interface UpdateGatePaths {
  lockFile?: string;
  markerFile?: string;
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Shared by every factory and process using the same Headroom installation. */
export function isUpdateGateBlocked({
  lockFile = UPDATE_LOCK_FILE,
  markerFile = UPDATE_GATE_MARKER_FILE,
}: UpdateGatePaths = {}): boolean {
  try {
    // lstat also notices dangling symlinks: an unsafe lock never permits use.
    lstatSync(lockFile);
    return true;
  } catch (error) {
    if (!absent(error)) return true;
  }
  try {
    const info = lstatSync(markerFile);
    if (!info.isFile() || info.isSymbolicLink()) return true;
    const marker: unknown = JSON.parse(readFileSync(markerFile, "utf8"));
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return true;
    const blocked = (marker as { blocked?: unknown }).blocked;
    return typeof blocked === "boolean" ? blocked : true;
  } catch (error) {
    return !absent(error);
  }
}

/** Persist before mutation; an unsuccessful write must abort the update. */
export function setUpdateGateBlocked(blocked: boolean, markerFile = UPDATE_GATE_MARKER_FILE): void {
  if (typeof blocked !== "boolean") throw new Error("Update gate requires a boolean state");
  try {
    const info = lstatSync(markerFile);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Update gate marker must be a regular file, not a symlink or directory");
    }
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const directory = dirname(markerFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${basename(markerFile)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, JSON.stringify({ blocked }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    // Rename publishes a complete marker without following its destination.
    renameSync(temporary, markerFile);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve a publication failure; a leftover private temp file is inert.
    }
  }
}
