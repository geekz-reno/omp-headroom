import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUpdateGateBlocked, setUpdateGateBlocked } from "../src/update-gate.ts";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "headroom-update-gate-"));
  const paths = { lockFile: join(root, "update.lock"), markerFile: join(root, "gate.json") };
  try {
    run(paths, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("absent state permits use and persisted blocking is visible to separate callers", () => {
  fixture((paths) => {
    expect(isUpdateGateBlocked(paths)).toBe(false);
    setUpdateGateBlocked(true, paths.markerFile);
    expect(isUpdateGateBlocked({ ...paths })).toBe(true);
    expect(isUpdateGateBlocked({ ...paths })).toBe(true);
    setUpdateGateBlocked(false, paths.markerFile);
    expect(isUpdateGateBlocked(paths)).toBe(false);
  });
});

test("the update lock blocks even a verified marker until mutation finishes", () => {
  fixture((paths) => {
    setUpdateGateBlocked(false, paths.markerFile);
    writeFileSync(paths.lockFile, "1234");
    expect(isUpdateGateBlocked(paths)).toBe(true);
    unlinkSync(paths.lockFile);
    expect(isUpdateGateBlocked(paths)).toBe(false);
    setUpdateGateBlocked(true, paths.markerFile);
    writeFileSync(paths.lockFile, "1234");
    unlinkSync(paths.lockFile);
    expect(isUpdateGateBlocked(paths)).toBe(true);
  });
});

test("malformed or non-boolean markers fail closed until explicit verification", () => {
  fixture((paths) => {
    for (const text of ["", "{bad", "null", "[]", "{}", '{"blocked":"false"}', '{"blocked":0}']) {
      writeFileSync(paths.markerFile, text);
      expect(isUpdateGateBlocked(paths)).toBe(true);
    }
    setUpdateGateBlocked(false, paths.markerFile);
    expect(isUpdateGateBlocked(paths)).toBe(false);
  });
});

test("markers publish atomically with private permissions and no temporary files", () => {
  fixture((paths, root) => {
    setUpdateGateBlocked(true, paths.markerFile);
    expect(JSON.parse(readFileSync(paths.markerFile, "utf8"))).toEqual({ blocked: true });
    expect(lstatSync(paths.markerFile).mode & 0o777).toBe(0o600);
    setUpdateGateBlocked(false, paths.markerFile);
    expect(JSON.parse(readFileSync(paths.markerFile, "utf8"))).toEqual({ blocked: false });
    expect(readdirSync(root)).toEqual(["gate.json"]);
  });
});

test("symlink markers remain blocked and cannot overwrite another file", () => {
  fixture((paths, root) => {
    const outside = join(root, "unrelated.json");
    writeFileSync(outside, '{"blocked":false}');
    symlinkSync(outside, paths.markerFile);
    expect(isUpdateGateBlocked(paths)).toBe(true);
    expect(() => setUpdateGateBlocked(false, paths.markerFile)).toThrow(/regular file/);
    expect(lstatSync(paths.markerFile).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe('{"blocked":false}');
    unlinkSync(paths.markerFile);
    symlinkSync(join(root, "missing"), paths.lockFile);
    expect(isUpdateGateBlocked(paths)).toBe(true);
  });
});

test("unreadable paths fail closed and failed writes throw without partial publication", () => {
  fixture((paths, root) => {
    const parentFile = join(root, "parent-file");
    writeFileSync(parentFile, "unrelated");
    const badMarker = join(parentFile, "gate.json");
    expect(isUpdateGateBlocked({ ...paths, markerFile: badMarker })).toBe(true);
    expect(() => setUpdateGateBlocked(true, badMarker)).toThrow();
    expect(readFileSync(parentFile, "utf8")).toBe("unrelated");
    expect(existsSync(paths.markerFile)).toBe(false);
  });
});
