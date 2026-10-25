import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SESSION_A = "session-clear-A1";
const SESSION_B = "session-clear-B2";
const HASH = "abcdef0123456789abcdef01";

async function withTempDir(callback) {
  const root = mkdtempSync(join(tmpdir(), "headroom-ccr-lifecycle-"));
  try {
    return await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runIsolated(root, script) {
  const binPath = join(root, "venv", "bin", "headroom");
  mkdirSync(join(root, "venv", "bin"), { recursive: true });
  writeFileSync(binPath, "", "utf8");
  const result = Bun.spawnSync(["bun", "-e", script, binPath, `${import.meta.dir}/..`], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `child exited ${result.exitCode}\n--- stdout ---\n${result.stdout.toString()}\n--- stderr ---\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

describe("CCR archive lifecycle", () => {
  test("the fallback store never expires retrievable originals by wall-clock age", async () => {
    await withTempDir(async (root) => {
      const ccrDir = join(root, "headroom-ccr");
      const legacyFile = join(ccrDir, `${HASH}.txt`);
      mkdirSync(ccrDir, { recursive: true });
      writeFileSync(legacyFile, "still required by a resumable session", "utf8");
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
      utimesSync(legacyFile, old, old);

      const script = `
        process.env.OMP_HEADROOM_BIN = process.argv[1];
        const fs = await import("node:fs");
        const path = await import("node:path");
        const ccr = await import(process.argv[2] + "/src/ccr.ts");
        if (typeof ccr.cleanupCcrFallback === "function") await ccr.cleanupCcrFallback();
        const ccrDir = path.join(path.dirname(path.dirname(path.dirname(process.argv[1]))), "headroom-ccr");
        if (!fs.existsSync(path.join(ccrDir, "${HASH}.txt"))) process.exit(3);
        process.stdout.write("ok");
        process.exit(0);
      `;

      expect(runIsolated(root, script)).toBe("ok");
    });
  });

  test("clearCcrSession deletes only the selected session directory", async () => {
    await withTempDir(async (root) => {
      const ccr = await import("../src/ccr.ts");
      expect(typeof ccr.ccrSessionDir).toBe("function");
      expect(typeof ccr.clearCcrSession).toBe("function");
      if (typeof ccr.ccrSessionDir !== "function" || typeof ccr.clearCcrSession !== "function") {
        return;
      }

      const sessionAFile = ccr.ccrFallbackPath(HASH, root, SESSION_A);
      const sessionBFile = ccr.ccrFallbackPath(HASH, root, SESSION_B);
      const legacyFile = ccr.ccrFallbackPath(HASH, root);
      mkdirSync(ccr.ccrSessionDir(SESSION_A, root), { recursive: true });
      mkdirSync(ccr.ccrSessionDir(SESSION_B, root), { recursive: true });
      writeFileSync(sessionAFile, "same original", "utf8");
      writeFileSync(sessionBFile, "same original", "utf8");
      writeFileSync(legacyFile, "legacy original", "utf8");

      expect(await ccr.clearCcrSession(SESSION_A, root)).toEqual({
        cleared: true,
        deletedFiles: 1,
        retainedEntries: 0,
      });
      expect(existsSync(sessionAFile)).toBe(false);
      expect(existsSync(sessionBFile)).toBe(true);
      expect(existsSync(legacyFile)).toBe(true);
      expect(await ccr.readCcrFallback(HASH, root, SESSION_B)).toBe("same original");
      expect(await ccr.readCcrFallback(HASH, root, SESSION_A)).toBe("legacy original");
    });
  });

  test("/headroom clear session requires confirmation and clears current-session data", async () => {
    await withTempDir(async (root) => {
      const script = `
        process.env.OMP_HEADROOM_BIN = process.argv[1];
        process.env.OMP_HEADROOM_URL = "http://127.0.0.1:1";
        process.env.OMP_HEADROOM_AUTOUPDATE = "0";
        const fs = await import("node:fs");
        const path = await import("node:path");
        const repo = process.argv[2];
        const ccr = await import(repo + "/src/ccr.ts");
        const stats = await import(repo + "/src/archive-stats.ts");
        const mod = await import(repo + "/src/index.ts");
        if (typeof ccr.ccrSessionDir !== "function") process.exit(6);
        const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
        const handlers = new Map(), commands = new Map(), notices = [];
        mod.default({
          zod: fakeZod,
          setLabel(){},
          logger:{warn(){}},
          on:(event, handler)=>handlers.set(event, handler),
          registerTool(){},
          registerCommand:(name, command)=>commands.set(name, command),
          registerFlag(){},
        });
        const ctx = {
          hasUI: true,
          ui: { setWidget(){}, setStatus(){}, notify:(text, level)=>notices.push({text, level}) },
          sessionManager: { getSessionId: () => "${SESSION_A}", getBranch: () => [] },
        };
        await handlers.get("session_start")({}, ctx);
        const ccrRoot = path.join(path.dirname(path.dirname(path.dirname(process.argv[1]))), "headroom-ccr");
        const sessionDir = ccr.ccrSessionDir("${SESSION_A}", ccrRoot);
        const ccrFile = ccr.ccrFallbackPath("${HASH}", ccrRoot, "${SESSION_A}");
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(ccrFile, "session original", "utf8");
        await stats.writeArchiveTotals("${SESSION_A}", { count: 2, charsBefore: 1000, charsAfter: 200, charsSaved: 800 });
        const statsFile = stats.archiveStatsPath("${SESSION_A}");

        await commands.get("headroom").handler("clear session", ctx);
        if (!fs.existsSync(ccrFile) || !fs.existsSync(statsFile)) process.exit(2);
        if (!notices.some(n => n.text.includes("clear session confirm") && n.level === "warn")) process.exit(3);

        await commands.get("headroom").handler("clear session confirm", ctx);
        if (fs.existsSync(ccrFile) || fs.existsSync(statsFile)) process.exit(4);
        if (!notices.some(n => n.text.includes("Cleared Headroom data") && n.level === "info")) process.exit(5);
        await handlers.get("session_shutdown")?.({}, ctx);
        process.stdout.write("ok");
        process.exit(0);
      `;

      expect(runIsolated(root, script)).toBe("ok");
    });
  });

  test("batch persistence rejects a hash collision without publishing counters", async () => {
    await withTempDir(async (root) => {
      const script = `
        process.env.OMP_HEADROOM_BIN = process.argv[1];
        const fs = await import("node:fs");
        const path = await import("node:path");
        const ccr = await import(process.argv[2] + "/src/ccr.ts");
        const state = { sessionId: "${SESSION_A}", ccrHashes: 0 };
        const ctx = {
          hasUI: true,
          sessionManager: { getSessionId: () => "${SESSION_A}" },
        };
        const marker = "[compressed. Retrieve more: hash=${HASH}]";
        const saved = await ccr.persistCcrOriginalBatch(
          [
            { originalText: "first original", compressedText: marker },
            { originalText: "different original", compressedText: marker },
          ],
          state,
          ctx,
        );
        const ccrRoot = path.join(path.dirname(path.dirname(path.dirname(process.argv[1]))), "headroom-ccr");
        const file = ccr.ccrFallbackPath("${HASH}", ccrRoot, "${SESSION_A}");
        if (saved !== 0 || state.ccrHashes !== 0 || fs.existsSync(file)) process.exit(2);
        process.stdout.write("ok");
      `;
      expect(runIsolated(root, script)).toBe("ok");
    });
  });
  test("old archive references cannot replace their originals or count as new compression", async () => {
    await withTempDir(async (root) => {
      const script = `
        process.env.OMP_HEADROOM_BIN = process.argv[1];
        const assert = (await import("node:assert/strict")).default;
        const ccr = await import(process.argv[2] + "/src/ccr.ts");
        const config = await import(process.argv[2] + "/src/config.ts");
        const state = { sessionId: "${SESSION_A}", ccrHashes: 0 };
        const ctx = { hasUI: true, sessionManager: { getSessionId: () => "${SESSION_A}" } };
        const fullPrefix = "Full original prefix: decisions and requirements before archival.";
        assert.equal(await ccr.persistCcrByHash("${HASH}", fullPrefix, state, ctx), 1);
        state.ccrHashes = 0;
        const original = "Existing archive hash=${HASH}; current tool output is detailed.";
        const compressed = "Existing archive hash=${HASH}; short tool output.";
        for (const ccrHashes of [[], ["${HASH}"]]) {
          assert.equal(await ccr.persistCcrOriginal({ ccrHashes }, original, compressed, state, ctx), 0);
        }
        assert.equal(await ccr.readCcrFallback("${HASH}", config.CCR_DIR, "${SESSION_A}"), fullPrefix);
        assert.equal(state.ccrHashes, 0);
        process.stdout.write("ok");
      `;
      expect(runIsolated(root, script)).toBe("ok");
    });
  });

  test("existing and concurrent hash collisions fail without replacing any original", async () => {
    await withTempDir(async (root) => {
      const script = `
        process.env.OMP_HEADROOM_BIN = process.argv[1];
        const assert = (await import("node:assert/strict")).default;
        const fs = await import("node:fs");
        const ccr = await import(process.argv[2] + "/src/ccr.ts");
        const config = await import(process.argv[2] + "/src/config.ts");
        const state = { sessionId: "${SESSION_A}", ccrHashes: 0 };
        const ctx = { hasUI: true, sessionManager: { getSessionId: () => "${SESSION_A}" } };
        const marker = "[compressed. Retrieve more: hash=${HASH}]";
        assert.equal(await ccr.persistCcrByHash("${HASH}", "first original", state, ctx), 1);
        state.ccrHashes = 0;
        assert.equal(await ccr.persistCcrOriginal({ ccrHashes: ["${HASH}"] }, "different original", marker, state, ctx), 0);
        assert.equal(await ccr.persistCcrOriginalBatch([{ originalText: "different original", compressedText: marker }], state, ctx), 0);
        assert.equal(await ccr.persistCcrByHash("${HASH}", "different original", state, ctx), 0);
        assert.equal(await ccr.readCcrFallback("${HASH}", config.CCR_DIR, "${SESSION_A}"), "first original");
        assert.equal(state.ccrHashes, 0);
        const otherHash = "123456789abcdef012345678";
        const attempts = await Promise.all([
          ccr.persistCcrByHash(otherHash, "concurrent first", state, ctx),
          ccr.persistCcrByHash(otherHash, "concurrent second", state, ctx),
        ]);
        assert.equal(attempts.reduce((a, b) => a + b, 0), 1);
        const winner = attempts[0] ? "concurrent first" : "concurrent second";
        assert.equal(await ccr.readCcrFallback(otherHash, config.CCR_DIR, "${SESSION_A}"), winner);
        assert.equal(await ccr.persistCcrByHash(otherHash, winner, state, ctx), 1);
        const files = fs.readdirSync(ccr.ccrSessionDir("${SESSION_A}", config.CCR_DIR));
        assert.equal(files.some(name => name.includes(".tmp.")), false);
        process.stdout.write("ok");
      `;
      expect(runIsolated(root, script)).toBe("ok");
    });
  });
});
