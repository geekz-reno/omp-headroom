import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateLock } from "../src/update-lock.ts";

function fixture(run) {
  const root = fs.mkdtempSync(join(tmpdir(), "headroom-update-lock-"));
  try {
    run(join(root, "update.lock"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function stale(path, record = "2147483647") {
  fs.writeFileSync(path, record);
  fs.utimesSync(path, new Date(0), new Date(0));
}

test("update lock excludes reentrant and separate factory acquisitions", () => {
  fixture((path) => {
    const first = createUpdateLock(path);
    const second = createUpdateLock(path);
    expect(first.acquire()).toBe(true);
    expect(first.acquire()).toBe(false);
    expect(second.acquire()).toBe(false);
    second.release();
    expect(fs.existsSync(path)).toBe(true);
    first.release();
    expect(second.acquire()).toBe(true);
    second.release();
    expect(fs.readdirSync(join(path, ".."))).toEqual([]);
  });
});

test("only old locks with a dead owner may be reclaimed", () => {
  fixture((path) => {
    const lock = createUpdateLock(path);
    stale(path, String(process.pid));
    expect(lock.acquire()).toBe(false);
    expect(fs.readFileSync(path, "utf8")).toBe(String(process.pid));
    fs.writeFileSync(path, "2147483647");
    expect(lock.acquire()).toBe(false);
    stale(path);
    expect(lock.acquire()).toBe(true);
    lock.release();
    expect(fs.existsSync(path)).toBe(false);
  });
});

test("stale-lock reclaimers cannot delete one another's replacement", () => {
  fixture((path) => {
    stale(path);
    let contenderAcquired;
    const contender = createUpdateLock(path);
    // Pause the first reclaimer after it observes stale metadata, at precisely
    // the interleaving that let the old unlink+wx implementation admit both.
    const source = fs.readFileSync(new URL("../src/update-lock.ts", import.meta.url), "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      source.replace(/^import .*;\n/gm, "").replace("export function", "function"),
    );
    const bindings = {
      mkdirSync: fs.mkdirSync,
      readFileSync: fs.readFileSync,
      rmdirSync: fs.rmdirSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync: fs.writeFileSync,
      randomUUID,
      statSync(file) {
        const info = fs.statSync(file);
        contenderAcquired = contender.acquire();
        return info;
      },
    };
    const create = new Function(...Object.keys(bindings), `${code}\nreturn createUpdateLock;`)(
      ...Object.values(bindings),
    );
    const first = create(path);
    expect(first.acquire()).toBe(true);
    expect(contenderAcquired).toBe(false);
    expect(contender.acquire()).toBe(false);
    first.release();
    expect(contender.acquire()).toBe(true);
    contender.release();
  });
});

test("release never removes a replacement lock record", () => {
  fixture((path) => {
    const lock = createUpdateLock(path);
    expect(lock.acquire()).toBe(true);
    fs.writeFileSync(path, "replacement-owner");
    lock.release();
    expect(fs.readFileSync(path, "utf8")).toBe("replacement-owner");
  });
});

test("a held recovery guard blocks acquisition without changing the lock", () => {
  fixture((path) => {
    stale(path);
    fs.mkdirSync(`${path}.guard`);
    const lock = createUpdateLock(path);
    expect(lock.acquire()).toBe(false);
    expect(fs.readFileSync(path, "utf8")).toBe("2147483647");
    fs.rmdirSync(`${path}.guard`);
    expect(lock.acquire()).toBe(true);
    lock.release();
  });
});
