import { expect, test } from "bun:test";
import { checkProxyCapabilities, runVerifiedUpdate } from "../src/update-safety.ts";

const hash = "capability_test_hash_001";

async function withProxy(overrides, run) {
  const previous = globalThis.fetch;
  const requests = [];
  let original;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, body, options });
    if (path === "/livez") {
      return overrides.health?.() ?? Response.json({ alive: true, status: "healthy" });
    }
    if (path === "/v1/compress") {
      original = body.messages.at(-1).content;
      const data = {
        messages: body.messages.map((message, index) =>
          index === body.messages.length - 1
            ? { ...message, content: `Compressed diagnostic. Retrieve more: hash=${hash}` }
            : message,
        ),
        tokens_before: 8_000,
        tokens_after: 80,
        tokens_saved: 7_920,
        ccr_hashes: [hash],
      };
      return overrides.compress?.(data, body) ?? Response.json(data);
    }
    if (path === "/v1/retrieve") {
      return overrides.retrieve?.(original, body) ?? Response.json({ original_content: original });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await run(requests);
  } finally {
    globalThis.fetch = previous;
  }
}

test("capability probe checks targeted CCR compression and complete retrieval", async () => {
  await withProxy({}, async (requests) => {
    const result = await checkProxyCapabilities("http://127.0.0.1:8787/");
    expect(result.ready).toBe(true);
    expect(result.compatible).toBe(true);
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ["readiness", true],
      ["compression", true],
      ["retrieval", true],
    ]);
    expect(requests.map((request) => request.path)).toEqual([
      "/livez",
      "/v1/compress",
      "/v1/retrieve",
    ]);
    expect(requests[1].body.config).toEqual({
      mode: "ccr",
      compress_user_messages: false,
      protect_recent: 0,
      protect_analysis_context: false,
    });
    expect(requests[2].body).toEqual({ hash });
  });
});

test("capability probe accepts full originals serialized as message JSON", async () => {
  await withProxy(
    {
      retrieve: (original) =>
        Response.json({ original_content: JSON.stringify([{ content: original }]) }),
    },
    async () =>
      expect((await checkProxyCapabilities("http://localhost:8787")).compatible).toBe(true),
  );
});

test("capability probe accepts reordered JSON keys without changing protected content", async () => {
  await withProxy(
    {
      compress: (data) => {
        data.messages[0] = { content: data.messages[0].content, role: "user" };
        return Response.json(data);
      },
    },
    async () =>
      expect((await checkProxyCapabilities("http://localhost:8787")).compatible).toBe(true),
  );
});

test("capability probe preserves the complete marker slug when it ends with a hyphen", async () => {
  await withProxy(
    {
      compress: (data) => {
        data.ccr_hashes = [];
        data.messages[2].content = "Compressed. Retrieve more: hash=capability-hash-]";
        return Response.json(data);
      },
      retrieve: (original, body) => {
        expect(body.hash).toBe("capability-hash-");
        return Response.json({ original_content: original });
      },
    },
    async () =>
      expect((await checkProxyCapabilities("http://localhost:8787")).compatible).toBe(true),
  );
});

test("unready proxies stop before compression", async () => {
  await withProxy(
    { health: () => Response.json({ alive: true, status: "unhealthy" }) },
    async (requests) => {
      const result = await checkProxyCapabilities("http://localhost:8787");
      expect(result.ready).toBe(false);
      expect(result.compatible).toBe(false);
      expect(result.checks[0].detail).toContain("not ready");
      expect(requests).toHaveLength(1);
    },
  );
});

for (const [name, mutate] of [
  [
    "fractional metrics",
    (data) => {
      data.tokens_before = 8_000.5;
    },
  ],
  [
    "token growth",
    (data) => {
      data.tokens_after = 8_001;
    },
  ],
  [
    "contradictory savings",
    (data) => {
      data.tokens_saved = 2;
    },
  ],
  [
    "mutated user message",
    (data) => {
      data.messages[0].content = "rewritten";
    },
  ],
  [
    "missing call pairing",
    (data) => {
      data.messages[2].tool_call_id = "different_call";
    },
  ],
  [
    "missing retrieval hash",
    (data) => {
      data.ccr_hashes = [];
      data.messages[2].content = "compressed";
    },
  ],
]) {
  test(`capability probe rejects ${name}`, async () => {
    await withProxy(
      {
        compress: (data) => {
          mutate(data);
          return Response.json(data);
        },
      },
      async (requests) => {
        const result = await checkProxyCapabilities("http://localhost:8787");
        expect(result.ready).toBe(true);
        expect(result.compatible).toBe(false);
        expect(result.checks.at(-1).name).toBe("compression");
        expect(requests).toHaveLength(2);
      },
    );
  });
}

test("capability probe rejects incomplete retrieval", async () => {
  await withProxy(
    { retrieve: () => Response.json({ original_content: "only an excerpt" }) },
    async () => {
      const result = await checkProxyCapabilities("http://localhost:8787");
      expect(result.compatible).toBe(false);
      expect(result.checks.at(-1)).toEqual({
        name: "retrieval",
        ok: false,
        detail: "CCR retrieval did not return the complete diagnostic original",
      });
    },
  );
});

test("capability probe combines caller cancellation with its deadline", async () => {
  const previous = globalThis.fetch;
  const caller = new AbortController();
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      const signal = options.signal;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  try {
    const deadline = await checkProxyCapabilities("http://localhost:8787", caller.signal, 10);
    expect(deadline.compatible).toBe(false);
    expect(deadline.checks[0].detail).toContain("timed out");
    expect(caller.signal.aborted).toBe(false);
    caller.abort(new Error("caller stopped probe"));
    const cancelled = await checkProxyCapabilities("http://localhost:8787", caller.signal);
    expect(cancelled.checks[0].detail).toBe("caller stopped probe");
  } finally {
    globalThis.fetch = previous;
  }
});

function updateFixture(options = {}) {
  const calls = [];
  const snapshot = { version: "previous", packages: "headroom-ai==0.1" };
  return {
    calls,
    callbacks: {
      snapshot() {
        calls.push("snapshot");
        if (options.snapshotError) throw new Error("snapshot failed");
        return snapshot;
      },
      upgrade() {
        calls.push("upgrade");
        if (options.upgradeError) throw new Error("upgrade failed");
      },
      verify() {
        calls.push("verify");
        if (options.verifyError) throw new Error("probe failed");
        return options.verified ?? { compatible: true };
      },
      rollback(value) {
        expect(value).toBe(snapshot);
        calls.push("rollback");
        if (options.rollbackError) throw new Error("restore failed");
      },
      recover() {
        calls.push("recover");
        if (options.recoverError) throw new Error("restart failed");
      },
    },
  };
}

test("verified update commits only after snapshot, upgrade, and capabilities pass", async () => {
  const fixture = updateFixture();
  expect(await runVerifiedUpdate(fixture.callbacks)).toEqual({ updated: true, rolledBack: false });
  expect(fixture.calls).toEqual(["snapshot", "upgrade", "verify"]);
});

test("snapshot failure never starts an update", async () => {
  const fixture = updateFixture({ snapshotError: true });
  const result = await runVerifiedUpdate(fixture.callbacks);
  expect(result.updated).toBe(false);
  expect(result.rolledBack).toBe(false);
  expect(result.error).toContain("snapshot failed");
  expect(fixture.calls).toEqual(["snapshot"]);
});

for (const [name, options] of [
  ["failed upgrade", { upgradeError: true }],
  ["incompatible proxy", { verified: { compatible: false } }],
  ["failed capability probe", { verifyError: true }],
]) {
  test(`verified update restores the snapshot after ${name}`, async () => {
    const fixture = updateFixture(options);
    const result = await runVerifiedUpdate(fixture.callbacks);
    expect(result.updated).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toBeTruthy();
    expect(result.rollbackError).toBeUndefined();
    expect(fixture.calls.slice(-2)).toEqual(["rollback", "recover"]);
  });
}

test("rollback failure preserves the original error and exposes recovery failure", async () => {
  const fixture = updateFixture({ upgradeError: true, rollbackError: true });
  expect(await runVerifiedUpdate(fixture.callbacks)).toEqual({
    updated: false,
    rolledBack: false,
    error: "upgrade failed",
    rollbackError: "restore failed",
  });
  expect(fixture.calls).not.toContain("recover");
});

test("restart failure after rollback is not reported as a recovered update", async () => {
  const fixture = updateFixture({ verified: false, recoverError: true });
  const result = await runVerifiedUpdate(fixture.callbacks);
  expect(result.updated).toBe(false);
  expect(result.rolledBack).toBe(false);
  expect(result.rollbackError).toBe("restart failed");
});
