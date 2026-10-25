import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run the real updater and its subprocess boundary in a fresh module graph.
// The only executable posing as Python is a strict fixture that edits JSON.
// No installer, package index, service manager, GPU, or proxy server is used.
function updateFixture(scenario) {
  const root = mkdtempSync(join(tmpdir(), "headroom-update-integration-"));
  const script = `
    import assert from "node:assert/strict";
    import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
    import { join } from "node:path";
    const root = process.argv[1], repo = process.argv[2], scenario = process.argv[3];
    const bin = join(root, "venv", "bin");
    mkdirSync(bin, { recursive: true });
    const manifest = join(root, "packages.json"), log = join(root, "installs.jsonl");
    writeFileSync(manifest, JSON.stringify({ "headroom-ai": "1.0.0", "fixture-dependency": "1.1.0" }));
    const fakePython = [
      "#!" + process.execPath,
      'import { readFileSync, writeFileSync, appendFileSync } from "node:fs";',
      'const args = process.argv.slice(2), file = process.env.HEADROOM_TEST_MANIFEST;',
      'const packages = JSON.parse(readFileSync(file, "utf8"));',
      'if (args[0] === "-c") {',
      '  const code = args[1] || "";',
      '  if (code.includes("distributions")) { if (process.env.HEADROOM_TEST_SCENARIO === "snapshot-failure") { process.stderr.write("snapshot unavailable"); process.exit(7); } process.stdout.write(JSON.stringify(packages)); }',
      '  else if (code.includes("import torch")) process.exit(1);',
      '  else if (code.includes("version(")) process.stdout.write(packages["headroom-ai"]);',
      '  else { process.stderr.write("unexpected fake Python code"); process.exit(92); }',
      '  process.exit(0);',
      '}',
      'if (args[0] !== "-m" || args[1] !== "pip" || args[2] !== "install") { process.stderr.write("real installer boundary rejected"); process.exit(93); }',
      'appendFileSync(process.env.HEADROOM_TEST_INSTALL_LOG, JSON.stringify(args) + "\\\\n");',
      'if (args.includes("--upgrade")) {',
      '  packages["headroom-ai"] = "2.0.0"; packages["fixture-dependency"] = "2.1.0";',
      '  writeFileSync(file, JSON.stringify(packages));',
      '  if (process.env.HEADROOM_TEST_SCENARIO === "upgrade-failure") { process.stderr.write("simulated partial upgrade failure"); process.exit(8); }',
      '} else if (args.includes("--force-reinstall") && args.includes("--no-deps")) {',
      '  if (process.env.HEADROOM_TEST_SCENARIO === "rollback-failure") { process.stderr.write("simulated rollback failure"); process.exit(9); }',
      '  for (const pin of args) { const match = pin.match(/^([A-Za-z0-9._-]+)==(.+)$/); if (match) packages[match[1]] = match[2]; }',
      '  writeFileSync(file, JSON.stringify(packages));',
      '} else { process.stderr.write("unexpected fake pip invocation"); process.exit(94); }',
    ].join("\\n");
    writeFileSync(join(bin, "python"), fakePython, { mode: 0o755 });
    writeFileSync(join(bin, "headroom"), "#!/bin/sh\\nexit 95\\n", { mode: 0o755 });
    process.env.OMP_HEADROOM_BIN = join(bin, "headroom");
    process.env.OMP_HEADROOM_AUTOUPDATE = "0";
    process.env.OMP_HEADROOM_SYSTEMD_UNIT = "";
    process.env.OMP_HEADROOM_UV = join(root, "no-uv-executable");
    process.env.OMP_HEADROOM_URL = "http://127.0.0.1:8787";
    process.env.HEADROOM_TEST_MANIFEST = manifest;
    process.env.HEADROOM_TEST_INSTALL_LOG = log;
    process.env.HEADROOM_TEST_SCENARIO = scenario;
    const { doMaintainInstall } = await import(repo + "/src/index.ts");
    const { createHeadroomState } = await import(repo + "/src/state.ts");
    const { UPDATE_LOCK_FILE } = await import(repo + "/src/config.ts");
    const { isUpdateGateBlocked, UPDATE_GATE_MARKER_FILE } = await import(repo + "/src/update-gate.ts");
    const state = createHeadroomState(), notices = [], probes = [];
    let kills = 0, probeOriginal;
    const ownedProcess = { kill(signal) { assert.equal(signal, "SIGTERM"); kills++; } };
    if (scenario !== "unowned") state.proxyProcess = ownedProcess;
    const ctx = { hasUI: true, ui: { setWidget() {}, setStatus() {}, notify(text) { notices.push(String(text)); } }, sessionManager: { getSessionId: () => "update-integration-session" } };
    const packages = () => JSON.parse(readFileSync(manifest, "utf8"));
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url), path = parsed.pathname;
      if (parsed.hostname === "pypi.org") return Response.json({ info: { version: "2.0.0" } });
      if (path === "/livez") {
        // The mocked service is tracked as a new owned child after each
        // restart. A real restart reaches this state via spawn().
        if (scenario !== "unowned") state.proxyProcess = ownedProcess;
        return Response.json({ alive: true, status: "healthy", version: packages()["headroom-ai"] });
      }
      if (path === "/v1/compress") {
        assert.equal(existsSync(UPDATE_LOCK_FILE), true, "the compatibility probe must run under the update lock");
        assert.equal(isUpdateGateBlocked(), true, "requests remain blocked until verification commits");
        const body = JSON.parse(options.body);
        probeOriginal = body.messages.at(-1).content;
        const version = packages()["headroom-ai"];
        probes.push(version);
        const compatible = scenario === "success" || version === "1.0.0";
        return Response.json({
          messages: body.messages.map((message, index) => index === body.messages.length - 1 ? { ...message, content: "short diagnostic. Retrieve more: hash=update_fixture_hash_001" } : message),
          tokens_before: 1000, tokens_after: compatible ? 100 : 1000,
          tokens_saved: compatible ? 900 : 0, ccr_hashes: ["update_fixture_hash_001"],
        });
      }
      if (path === "/v1/retrieve") return Response.json({ original_content: probeOriginal });
      if (path.endsWith("/stats")) return Response.json({});
      throw new Error("Unexpected fake transport: " + String(url));
    };
    await doMaintainInstall(ctx, state, true);
    const installs = existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").map(line => JSON.parse(line)) : [];
    const snapshotFile = join(root, ".headroom-rollback.json");
    assert.equal(existsSync(UPDATE_LOCK_FILE), false, "the installer lock must always be released");
    assert.equal(state.installState, "", "the updating indicator must settle");
    if (scenario === "unowned" || scenario === "snapshot-failure") {
      assert.equal(packages()["headroom-ai"], "1.0.0");
      assert.equal(installs.length, 0);
      assert.equal(existsSync(snapshotFile), false);
      assert.match(state.lastError, scenario === "unowned" ? /owned.*No packages were changed/ : /Update snapshot failed/);
      assert.equal(kills, 0);
    } else {
      const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
      assert.equal(snapshot.version, "1.0.0");
      assert.equal(snapshot.packages["fixture-dependency"], "1.1.0");
      assert.equal(installs[0].includes("--upgrade"), true);
      assert.equal(existsSync(UPDATE_GATE_MARKER_FILE), true);
      if (scenario === "success") {
        assert.equal(packages()["headroom-ai"], "2.0.0");
        assert.equal(state.version, "2.0.0");
        assert.equal(state.lastError, "");
        assert.equal(installs.length, 1);
        assert.deepEqual(probes, ["2.0.0"]);
        assert.equal(isUpdateGateBlocked(), false);
        assert.ok(notices.some(text => text.includes("compression and retrieval verified")));
      } else if (scenario === "rollback-failure") {
        assert.equal(packages()["headroom-ai"], "2.0.0");
        assert.equal(state.version, "2.0.0");
        assert.match(state.lastError, /rollback incomplete.*simulated rollback failure/);
        assert.equal(isUpdateGateBlocked(), true);
        assert.deepEqual(probes, ["2.0.0"]);
      } else {
        assert.equal(packages()["headroom-ai"], "1.0.0");
        assert.equal(packages()["fixture-dependency"], "1.1.0");
        assert.equal(state.version, "1.0.0");
        assert.match(state.lastError, /previous package versions restored and verified/);
        assert.ok(installs[1].includes("--force-reinstall") && installs[1].includes("--no-deps"));
        assert.ok(installs[1].includes("headroom-ai==1.0.0"));
        assert.ok(installs[1].includes("fixture-dependency==1.1.0"));
        assert.equal(isUpdateGateBlocked(), false);
        assert.deepEqual(probes, scenario === "upgrade-failure" ? ["1.0.0"] : ["2.0.0", "1.0.0"]);
      }
    }
    process.stdout.write("ok");
  `;
  try {
    const child = Bun.spawnSync(["bun", "-e", script, root, `${import.meta.dir}/..`, scenario], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    if (child.exitCode !== 0) {
      throw new Error(
        child.stderr.toString() || child.stdout.toString() || `child exit ${child.exitCode}`,
      );
    }
    expect(child.stdout.toString()).toBe("ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [scenario, title] of [
  ["success", "commits a package upgrade only after compression and retrieval verification"],
  ["capability-failure", "restores recorded packages when an upgraded proxy is incompatible"],
  ["upgrade-failure", "restores recorded packages after a partially failed installer"],
  ["rollback-failure", "keeps compression blocked and reports incomplete rollback"],
  ["unowned", "refuses package mutation for an unowned proxy"],
  ["snapshot-failure", "does not mutate packages when the environment snapshot cannot be captured"],
]) {
  test(title, () => updateFixture(scenario), 15_000);
}
