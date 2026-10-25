import { expect, test } from "bun:test";
import headroomExtension from "../src/index.ts";
import { retrieveViaProxy } from "../src/tools.ts";

// A stalled transport must still return so headroom_retrieve can use its
// durable local fallback; cancellation and timeout are independent limits.
async function stalledRetrieval(signal, cancel) {
  const originalFetch = globalThis.fetch;
  const cleanup = new AbortController();
  let watchdog;
  globalThis.fetch = async (_url, options) => {
    const requestSignal = options.signal;
    return new Promise((_resolve, reject) => {
      const rejectOnAbort = () => reject(requestSignal.reason);
      if (requestSignal.aborted) rejectOnAbort();
      else requestSignal.addEventListener("abort", rejectOnAbort, { once: true });
      cleanup.signal.addEventListener("abort", () => reject(new Error("test cleanup")), {
        once: true,
      });
    });
  };
  try {
    const pending = retrieveViaProxy(
      "http://127.0.0.1:1",
      "abcdef0123456789",
      undefined,
      signal,
      20,
    );
    cancel?.();
    return await Promise.race([
      pending,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve({ error: "watchdog expired" }), 300);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
    cleanup.abort();
    globalThis.fetch = originalFetch;
  }
}

test("a caller cancellation signal does not bypass the retrieval timeout", async () => {
  const controller = new AbortController();
  const result = await stalledRetrieval(controller.signal);
  expect(result.error).toContain("TimeoutError");
  expect(controller.signal.aborted).toBe(false);
});

test("retrieval still times out without a caller signal", async () => {
  expect((await stalledRetrieval(undefined)).error).toContain("TimeoutError");
});

test("caller cancellation remains effective before the timeout", async () => {
  const controller = new AbortController();
  const result = await stalledRetrieval(controller.signal, () =>
    controller.abort(new Error("caller cancelled")),
  );
  expect(result.error).toContain("caller cancelled");
});

test("successful and failed retrievals do not create CCR artifacts", async () => {
  const originalFetch = globalThis.fetch;
  const fakeZod = new Proxy(function z() {}, {
    get: () => fakeZod,
    apply: () => fakeZod,
  });
  const tools = new Map();
  headroomExtension({
    zod: fakeZod,
    setLabel() {},
    logger: { warn() {} },
    on() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    registerCommand() {},
    registerFlag() {},
  });
  const ctx = {
    hasUI: true,
    ui: { setWidget() {}, setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "retrieval-counter-regression" },
  };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/v1/retrieve") {
      const { hash } = JSON.parse(options.body);
      return hash === "existing_counter_hash"
        ? Response.json({ original_content: "previously archived content" })
        : Response.json({ error: "hash not found" }, { status: 404 });
    }
    if (path === "/livez" || path.endsWith("/stats")) return Response.json({});
    throw new Error(`Unexpected proxy request: ${path}`);
  };
  try {
    const retrieve = tools.get("headroom_retrieve");
    const stats = tools.get("headroom_stats");
    for (const hash of [
      "existing_counter_hash",
      "missing_counter_hash",
      "existing_counter_hash",
      "missing_counter_hash",
    ]) {
      const result = await retrieve.execute("retrieve", { hash }, undefined, undefined, ctx);
      expect(result.isError).toBe(hash === "missing_counter_hash");
      const summary = await stats.execute("stats", {}, undefined, undefined, ctx);
      expect(summary.content[0].text).toContain("This process: provider=0, tool=0, ccr=0,");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
