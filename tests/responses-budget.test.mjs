import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Run the production batcher and worker loop with only transport, persistence,
// and time mocked. No real 24-second waits or proxy installation are needed.
const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const start = source.indexOf("const RESPONSES_BATCH_MAX_ITEMS");
const end = source.indexOf("\nfunction recordCompression(", start);
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));

function fixture(outcomes, { batches = 0, items = 0, concurrency = 2 } = {}) {
  let now = 0;
  const requests = [];
  const accepted = [];
  const input = [
    ...Array.from({ length: batches * 8 }, (_, index) => ({
      call_id: `small-${index}`,
      output: "x".repeat(50),
    })),
    ...Array.from({ length: items }, (_, index) => ({
      call_id: `large-${index}`,
      output: "x".repeat(1000),
    })),
  ];
  const payload = { input };
  const bindings = {
    MIN_TOOL_TEXT_CHARS: 100,
    PROVIDER_MIN_TEXT_CHARS: 1,
    PROVIDER_TIMEOUT_MS: 12_000,
    RESPONSES_COMPRESS_CONCURRENCY: concurrency,
    COMPRESSED_MARKER: "Retrieve more:",
    RETRIEVED_MARKER: "retrieved",
    performance: { now: () => now },
    applyResponsesSessionArchive: async (value) => value,
    debugSizingStage() {},
    payloadHasRetrieveTool: () => true,
    adaptiveMinChars: (value) => value,
    contextUsageRatio: () => 0,
    responseOutputText: (item) => item.output,
    normalizeModel: () => "test-model",
    isRecord: (value) => value !== null && typeof value === "object",
    isBeneficialCompressionResult: (result) => result.beneficial,
    finishCompressionAttempt() {},
    persistCcrOriginalBatch: async (changes) => changes.length,
    persistCcrOriginal: async () => true,
    recordCompression: (_state, _kind, result) => accepted.push(result),
    async compressOpenAiMessages(messages, _model, _tokens, timeoutMs) {
      const outcome = outcomes[requests.length];
      requests.push({ timeoutMs });
      if (!outcome) throw new Error("unexpected proxy request");
      if (outcome.wait) await outcome.wait;
      const duration = outcome.duration ?? 0;
      now += Math.min(duration, timeoutMs);
      if (outcome.fail || duration >= timeoutMs) throw new Error("proxy unavailable");
      return {
        beneficial: !outcome.unchanged,
        messages: messages.map((message) =>
          message.role === "tool" && !outcome.unchanged
            ? { ...message, content: "Retrieve more: hash=fixture" }
            : message,
        ),
      };
    },
  };
  const compress = new Function(
    ...Object.keys(bindings),
    `${code.replace("export async function", "async function")}\nreturn compressResponsesPayload;`,
  )(...Object.values(bindings));
  return {
    requests,
    accepted,
    payload,
    elapsed: () => now,
    run: () => compress(payload, {}, {}),
  };
}

test("Responses caps each batch timeout by the remaining pass budget", async () => {
  const run = fixture([{ duration: 11_000 }, { duration: 11_000 }, { duration: 12_000 }, {}], {
    batches: 4,
    items: 2,
  });
  const result = await run.run();
  expect(run.requests.map((request) => request.timeoutMs)).toEqual([12_000, 12_000, 2_000]);
  expect(run.elapsed()).toBe(24_000);
  expect(run.accepted).toHaveLength(2);
  expect(result.input[0].output).toContain("Retrieve more:");
  expect(result.input[16]).toBe(run.payload.input[16]);
  expect(result.input.at(-1)).toBe(run.payload.input.at(-1));
});

test("Responses oversized workers inherit the time remaining after batches", async () => {
  const run = fixture([{ duration: 11_000 }, { duration: 11_000 }, { duration: 12_000 }], {
    batches: 2,
    items: 3,
    concurrency: 1,
  });
  await run.run();
  expect(run.requests.map((request) => request.timeoutMs)).toEqual([12_000, 12_000, 2_000]);
  expect(run.elapsed()).toBe(24_000);
});

test("Responses successes reset the consecutive batch failure count", async () => {
  for (const success of [{}, { unchanged: true }]) {
    const run = fixture([{ fail: true }, success, { fail: true }, {}], { batches: 4 });
    await run.run();
    expect(run.requests).toHaveLength(4);
  }
});

test("two batch failures also stop oversized requests and preserve originals", async () => {
  const run = fixture([{ fail: true }, { fail: true }], { batches: 3, items: 6 });
  expect(await run.run()).toBe(run.payload);
  expect(run.requests).toHaveLength(2);
});

test("oversized worker failures stop scheduling further requests", async () => {
  const run = fixture([{ fail: true }, { fail: true }], { items: 6 });
  expect(await run.run()).toBe(run.payload);
  expect(run.requests).toHaveLength(2);
});

test("a late in-flight success cannot reopen the Responses circuit", async () => {
  let finish;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const run = fixture([{ fail: true }, { fail: true }, { wait }], {
    items: 8,
    concurrency: 3,
  });
  const pending = run.run();
  for (let index = 0; index < 8; index++) await Promise.resolve();
  finish();
  const result = await pending;
  expect(run.requests).toHaveLength(3);
  expect(run.accepted).toHaveLength(1);
  expect(result.input[2].output).toContain("Retrieve more:");
  expect(result.input[3]).toBe(run.payload.input[3]);
});
