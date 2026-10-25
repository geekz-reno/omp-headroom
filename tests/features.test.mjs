import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function featureFixture(script) {
  const root = mkdtempSync(join(tmpdir(), "headroom-features-"));
  const setup = `
    import assert from "node:assert/strict";
    import { mkdirSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
    import { join } from "node:path";
    const root = process.argv[1], repo = process.argv[2];
    process.env.OMP_HEADROOM_BIN = join(root, "venv", "bin", "headroom");
    process.env.OMP_HEADROOM_AUTOUPDATE = "0";
    process.env.OMP_HEADROOM_URL = "http://127.0.0.1:8787";
    const { default: extension } = await import(repo + "/src/index.ts");
    const { CCR_DIR, UPDATE_LOCK_FILE } = await import(repo + "/src/config.ts");
    const fakeZod = new Proxy(function z() {}, { get: () => fakeZod, apply: () => fakeZod });
    const tools = new Map(), commands = new Map(), events = new Map(), notices = [];
    extension({
      zod: fakeZod, setLabel() {}, registerFlag() {}, logger: { warn() {} },
      on(name, handler) { events.set(name, handler); },
      registerCommand(name, command) { commands.set(name, command); },
      registerTool(tool) { tools.set(tool.name, tool); },
    });
    const sessionId = "feature-current-session";
    const ctx = {
      hasUI: true, model: { provider: "openai", id: "gpt-4o" },
      ui: { setWidget() {}, setStatus() {}, notify(text, level) { notices.push({ text: String(text), level }); } },
      sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    };
    const command = async args => commands.get("headroom").handler(args, ctx);
    const lastNotice = () => notices.at(-1).text;
    const hash = "feature_capability_hash_001";
  `;
  try {
    const child = Bun.spawnSync(
      [
        "bun",
        "-e",
        `${setup}\n${script}\nprocess.stdout.write("ok");`,
        root,
        `${import.meta.dir}/..`,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
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

test("doctor gates automatic and manual compression until the proxy contract recovers", () => {
  featureFixture(`
    let compatible = false, probeOriginal, compressionRequests = 0;
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path === "/livez") return Response.json({ alive: true, status: "healthy" });
      if (path.endsWith("/stats")) return Response.json({});
      if (path.endsWith("/v1/compress")) {
        compressionRequests++;
        const body = JSON.parse(options.body);
        probeOriginal = body.messages.at(-1).content;
        return Response.json({
          messages: body.messages.map((message, index) => index === body.messages.length - 1
            ? { ...message, content: "short result. Retrieve more: hash=" + hash }
            : message),
          tokens_before: 1000, tokens_after: compatible ? 100 : 1000,
          tokens_saved: compatible ? 900 : 0, ccr_hashes: [hash],
        });
      }
      if (path === "/v1/retrieve") return Response.json({ original_content: probeOriginal });
      throw new Error("Unexpected transport: " + path);
    };
    const payload = {
      model: "gpt-4o", tools: [{ type: "function", name: "headroom_retrieve" }],
      messages: [
        { role: "user", content: "inspect these records" },
        { role: "assistant", content: null, tool_calls: [{ id: "feature-call", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "feature-call", content: "diagnostic record ".repeat(2000) },
      ],
    };
    await command("doctor");
    assert.match(lastNotice(), /Compression is paused/);
    assert.equal(compressionRequests, 1);
    assert.equal(await events.get("before_provider_request")({ payload }, ctx), undefined);
    assert.equal(compressionRequests, 1, "paused automatic requests must not reach the compressor");
    const manual = await tools.get("headroom_compress").execute("manual", { content: "large content" }, undefined, undefined, ctx);
    assert.equal(manual.isError, true);
    assert.equal(compressionRequests, 1);
    const secondEvents = new Map(), secondTools = new Map();
    extension({
      zod: fakeZod, setLabel() {}, registerFlag() {}, logger: { warn() {} },
      on(name, handler) { secondEvents.set(name, handler); },
      registerCommand() {}, registerTool(tool) { secondTools.set(tool.name, tool); },
    });
    const secondCtx = { ...ctx, sessionManager: { getSessionId: () => "feature-second-session", getBranch: () => [] } };
    assert.equal(await secondEvents.get("before_provider_request")({ payload }, secondCtx), undefined);
    assert.equal((await secondTools.get("headroom_compress").execute("second", { content: "large content" }, undefined, undefined, secondCtx)).isError, true);
    assert.equal(compressionRequests, 1, "a separate factory must honor persisted compatibility blocking");
    const isolated = Bun.spawnSync(["bun", "-e", [
      'import assert from "node:assert/strict";',
      'const { default: extension } = await import(process.argv[1] + "/src/index.ts");',
      'const events = new Map(); let fetches = 0;',
      'const zod = new Proxy(function z() {}, { get: () => zod, apply: () => zod });',
      'globalThis.fetch = async () => { fetches++; throw new Error("blocked process contacted proxy"); };',
      'extension({ zod, on(name, handler) { events.set(name, handler); }, setLabel() {}, registerFlag() {}, registerCommand() {}, registerTool() {} });',
      'assert.equal(await events.get("before_provider_request")({ payload: { messages: [] } }, {}), undefined);',
      'assert.equal(fetches, 0);',
    ].join("\\n"), repo], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    assert.equal(isolated.exitCode, 0, isolated.stderr.toString());
    compatible = true;
    await command("doctor");
    assert.match(lastNotice(), /contract verified/);
    const compressed = await events.get("before_provider_request")({ payload }, ctx);
    assert.ok(compressed?.messages.at(-1).content.includes("hash=" + hash));
    assert.equal(compressionRequests, 3);
    await command("telemetry");
    assert.match(lastNotice(), /1 attempts.*1 accepted.*0 rejected/);
    assert.match(lastNotice(), /saved 900/);
    const { setUpdateGateBlocked, UPDATE_GATE_MARKER_FILE } = await import(repo + "/src/update-gate.ts");
    setUpdateGateBlocked(true);
    writeFileSync(UPDATE_LOCK_FILE, "synthetic-other-process");
    try {
      await command("doctor");
      assert.match(lastNotice(), /update|installation|running/i);
      assert.equal(JSON.parse(await Bun.file(UPDATE_GATE_MARKER_FILE).text()).blocked, true, "a concurrent doctor cannot clear the persisted update gate");
      assert.equal(await events.get("before_provider_request")({ payload }, ctx), undefined);
      assert.equal(await secondEvents.get("before_provider_request")({ payload }, secondCtx), undefined);
      assert.equal((await secondTools.get("headroom_compress").execute("locked", { content: "large content" }, undefined, undefined, secondCtx)).isError, true);
      assert.equal(compressionRequests, 3, "an active installation lock blocks all factories despite a verified marker");
    } finally { unlinkSync(UPDATE_LOCK_FILE); }
    assert.equal(await secondEvents.get("before_provider_request")({ payload }, secondCtx), undefined, "a blocked marker remains effective after the installation lock disappears");
    await command("doctor");
    assert.match(lastNotice(), /contract verified/);
    const secondCompressed = await secondEvents.get("before_provider_request")({ payload }, secondCtx);
    assert.ok(secondCompressed?.messages.at(-1).content.includes("hash=" + hash));
    assert.equal(compressionRequests, 5, "factories recover only after the proxy is verified again");
  `);
});

test("local retrieval is bounded and searchable without contacting an offline proxy", () => {
  featureFixture(`
    const localHash = "feature_local_hash_001";
    const source = "header\\nNEEDLE alpha " + "A".repeat(15000) + "\\nother line\\nNeedle beta " + "B".repeat(15000);
    const dir = join(CCR_DIR, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, localHash + ".txt"), source);
    const fetches = [];
    let allowNetwork = false;
    globalThis.fetch = async url => {
      fetches.push(String(url));
      if (!allowNetwork) throw new Error("offline proxy must not be contacted for local retrieval");
      return Response.json(new URL(url).pathname === "/livez" ? { alive: true, status: "healthy" } : {});
    };
    const retrieve = tools.get("headroom_retrieve");
    const first = await retrieve.execute("first", { hash: localHash, query: "needle", limit: 40 }, undefined, undefined, ctx);
    assert.equal(first.isError, false);
    assert.match(first.details.original_content, /^2: NEEDLE alpha /);
    assert.equal(first.details.original_content.length, 40);
    assert.equal(first.details.matched_lines, 2);
    assert.equal(first.details.truncated, true);
    assert.equal(first.details.next_offset, 40);
    assert.ok(first.content[0].text.length < 500, "the tool response must not carry the entire archive");
    const second = await retrieve.execute("second", { hash: localHash, query: "needle", offset: first.details.next_offset, limit: 40 }, undefined, undefined, ctx);
    assert.equal(second.details.offset, 40);
    assert.equal(second.details.original_content.length, 40);
    const wholeDefault = await retrieve.execute("default", { hash: localHash }, undefined, undefined, ctx);
    assert.equal(wholeDefault.details.original_content.length, 12000);
    assert.equal(wholeDefault.details.truncated, true);
    assert.ok(wholeDefault.content[0].text.length < 12500);
    assert.equal(fetches.length, 0, "local retrieval and its telemetry must not contact the proxy");
    await events.get("message_end")({ message: { role: "assistant", usage: { input: 100, cacheRead: 1000, cacheWrite: 50 } } }, ctx);
    await command("telemetry");
    assert.match(lastNotice(), /Retrieval: 3 calls/);
    assert.match(lastNotice(), /net ≈-/);
    assert.match(lastNotice(), /read 1,000.*write 50/);
    assert.match(lastNotice(), /independent of the net estimate/);
    assert.equal(fetches.length, 0);
    allowNetwork = true;
    const stats = await tools.get("headroom_stats").execute("stats", {}, undefined, undefined, ctx);
    assert.match(stats.content[0].text, /This process: provider=0, tool=0, ccr=0/);
    assert.match(stats.content[0].text, /Retrieval: 3 calls/);
  `);
});

test("archive commands preview selective cleanup and retain active, legacy, and unowned data", () => {
  featureFixture(`
    globalThis.fetch = async () => { throw new Error("archive management is offline"); };
    const { archiveStatsPath, writeArchiveTotals } = await import(repo + "/src/archive-stats.ts");
    const current = join(CCR_DIR, sessionId);
    const abandonedId = "feature-abandoned-session", abandoned = join(CCR_DIR, abandonedId);
    const retainedId = "feature-unknown-session", retained = join(CCR_DIR, retainedId);
    const outside = join(root, "outside"), linkedId = "feature-linked-session";
    for (const dir of [current, abandoned, retained, outside]) mkdirSync(dir, { recursive: true });
    const name = "feature_archive_hash_001.txt";
    writeFileSync(join(current, name), "current original");
    writeFileSync(join(abandoned, name), "abandoned original");
    writeFileSync(join(retained, name), "owned original");
    writeFileSync(join(retained, "notes.md"), "unknown retained content");
    writeFileSync(join(outside, name), "outside original");
    symlinkSync(outside, join(CCR_DIR, linkedId));
    const legacy = join(CCR_DIR, "feature_legacy_hash_001.txt");
    writeFileSync(legacy, "legacy original");
    await writeArchiveTotals(abandonedId, { count: 1, charsBefore: 100, charsAfter: 10, charsSaved: 90 });
    await command("archives");
    assert.ok(lastNotice().includes("feature-current-session (current)"));
    assert.match(lastNotice(), /feature-abandoned-session: 1 files/);
    assert.match(lastNotice(), /1 unowned legacy files/);
    await command("archives clear " + abandonedId);
    assert.match(lastNotice(), /append confirm|confirm to delete/);
    assert.equal(existsSync(join(abandoned, name)), true);
    assert.equal(existsSync(archiveStatsPath(abandonedId)), true);
    await command("archives clear " + sessionId + " confirm");
    assert.match(lastNotice(), /active session/);
    assert.equal(existsSync(join(current, name)), true);
    await command("archives clear " + linkedId + " confirm");
    assert.match(lastNotice(), /No owned archive directory/);
    assert.equal(existsSync(join(outside, name)), true);
    await command("archives clear ../../outside confirm");
    assert.match(lastNotice(), /Usage:/);
    await command("archives clear " + abandonedId + " confirm");
    assert.match(lastNotice(), /Removed 1 archive files/);
    assert.equal(existsSync(abandoned), false);
    assert.equal(existsSync(archiveStatsPath(abandonedId)), false);
    await command("archives clear " + retainedId + " confirm");
    assert.equal(existsSync(join(retained, name)), false);
    assert.equal(existsSync(join(retained, "notes.md")), true);
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(join(current, name)), true);
  `);
});

test("feature commands appear in help and command completion", () => {
  featureFixture(`
    const commandDefinition = commands.get("headroom");
    for (const [prefix, name] of [["doc", "doctor"], ["arch", "archives"], ["tele", "telemetry"], ["roll", "rollback"]]) {
      assert.ok(commandDefinition.getArgumentCompletions(prefix).some(item => item.value === name), name + " completion");
    }
    await command("help");
    for (const name of ["doctor", "archives", "telemetry", "rollback"]) assert.ok(lastNotice().includes("/headroom " + name));
  `);
});
