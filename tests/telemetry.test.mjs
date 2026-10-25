import { expect, test } from "bun:test";
import {
  createCompressionTelemetry,
  recordCompressionAttempt,
  recordRetrievalCost,
  telemetrySummary,
} from "../src/telemetry.ts";

test("telemetry starts empty and remains session-local", () => {
  const first = {};
  const second = {};
  expect(createCompressionTelemetry()).toEqual({
    attempts: 0,
    accepted: 0,
    rejected: 0,
    compressionDurationMs: 0,
    compressionTokensSaved: 0,
    retrievals: 0,
    retrievalChars: 0,
    retrievalDurationMs: 0,
    retrievalEstimatedTokens: 0,
    rejections: {},
  });
  recordCompressionAttempt(first, { durationMs: 12, accepted: true, tokensSaved: 1_000 });
  expect(first.telemetry.accepted).toBe(1);
  expect(second.telemetry).toBeUndefined();
  expect(telemetrySummary(second)).toContain("0 attempts");
  expect(second.telemetry).toBeUndefined();
});

test("attempt totals include accepted and rejected latency, with savings only on acceptance", () => {
  const state = {};
  recordCompressionAttempt(state, { durationMs: 20, accepted: true, tokensSaved: 200 });
  recordCompressionAttempt(state, {
    durationMs: 10,
    accepted: false,
    tokensSaved: 1_000,
    reason: "metrics",
  });
  expect(state.telemetry.attempts).toBe(2);
  expect(state.telemetry.accepted).toBe(1);
  expect(state.telemetry.rejected).toBe(1);
  expect(state.telemetry.compressionTokensSaved).toBe(200);
  expect(state.telemetry.compressionDurationMs).toBe(30);
  expect(telemetrySummary(state)).toContain("avg 15.0 ms");
});

test("known rejection categories are counted without retaining arbitrary provider errors", () => {
  const state = {};
  for (const reason of ["error", "metrics", "nonbeneficial", "persistence", "missing-hash"]) {
    recordCompressionAttempt(state, { durationMs: 1, accepted: false, reason });
  }
  const privateError = "provider error contained a prompt and secret token";
  recordCompressionAttempt(state, { durationMs: 1, accepted: false, reason: privateError });
  expect(state.telemetry.rejections).toEqual({
    error: 1,
    metrics: 1,
    nonbeneficial: 1,
    persistence: 1,
    "missing-hash": 1,
    other: 1,
  });
  expect(JSON.stringify(state.telemetry)).not.toContain(privateError);
  expect(telemetrySummary(state)).not.toContain(privateError);
  expect(telemetrySummary(state)).toContain("other=1");
});

test("retrieval estimates are explicit and can make net savings negative", () => {
  const state = {};
  recordCompressionAttempt(state, { durationMs: 5, accepted: true, tokensSaved: 100 });
  recordRetrievalCost(state, { chars: 800, durationMs: 10 });
  recordRetrievalCost(state, { chars: 1, durationMs: 20 });
  expect(state.telemetry.retrievals).toBe(2);
  expect(state.telemetry.retrievalChars).toBe(801);
  expect(state.telemetry.retrievalEstimatedTokens).toBe(201);
  const summary = telemetrySummary(state, 10_000, 2_000);
  expect(summary).toContain("retrieval ≈201 · net ≈-101");
  expect(summary).toContain("avg 15.0 ms");
  expect(summary).toContain("read 10,000 · write 2,000");
  expect(summary).toContain("independent of the net estimate");
  expect(summary).toContain("approximately one token per four characters");
});

test("invalid and negative numeric inputs cannot create false savings or NaN counters", () => {
  const state = {};
  for (const invalid of [-1, NaN, Infinity, "100"]) {
    recordCompressionAttempt(state, { durationMs: invalid, accepted: true, tokensSaved: invalid });
    recordRetrievalCost(state, { chars: invalid, durationMs: invalid });
  }
  recordCompressionAttempt(state, { durationMs: 1.5, accepted: true, tokensSaved: 2.9 });
  expect(state.telemetry.compressionTokensSaved).toBe(2);
  expect(state.telemetry.compressionDurationMs).toBe(1.5);
  expect(state.telemetry.retrievalChars).toBe(0);
  expect(state.telemetry.retrievalEstimatedTokens).toBe(0);
  expect(JSON.stringify(state.telemetry)).not.toContain("null");
  expect(telemetrySummary(state, NaN, -1)).toContain("read 0 · write 0");
});

test("large numeric values saturate safely and malformed prior telemetry is normalized", () => {
  const state = {
    telemetry: {
      ...createCompressionTelemetry(),
      attempts: NaN,
      accepted: -1,
      rejected: 2,
      rejections: { metrics: 1, prompt_contents: 99 },
      compressionDurationMs: Infinity,
      retrievalChars: -2,
    },
  };
  recordCompressionAttempt(state, {
    durationMs: Number.MAX_VALUE,
    accepted: true,
    tokensSaved: Number.MAX_VALUE,
  });
  recordRetrievalCost(state, { chars: Number.MAX_VALUE, durationMs: Number.MAX_VALUE });
  expect(state.telemetry.attempts).toBe(3);
  expect(state.telemetry.accepted + state.telemetry.rejected).toBe(state.telemetry.attempts);
  expect(state.telemetry.compressionTokensSaved).toBe(Number.MAX_SAFE_INTEGER);
  expect(state.telemetry.compressionDurationMs).toBe(Number.MAX_SAFE_INTEGER);
  expect(state.telemetry.retrievalChars).toBe(Number.MAX_SAFE_INTEGER);
  expect(state.telemetry.rejections).toEqual({ metrics: 1, other: 1 });
  expect(telemetrySummary(state)).not.toContain("prompt_contents");
});
