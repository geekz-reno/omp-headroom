const REJECTION_REASONS = [
  "error",
  "metrics",
  "nonbeneficial",
  "persistence",
  "missing-hash",
  "unsupported",
  "cancelled",
  "other",
] as const;

export type CompressionRejectionReason = (typeof REJECTION_REASONS)[number];

export interface CompressionTelemetry {
  attempts: number;
  accepted: number;
  rejected: number;
  compressionDurationMs: number;
  compressionTokensSaved: number;
  retrievals: number;
  retrievalChars: number;
  retrievalDurationMs: number;
  retrievalEstimatedTokens: number;
  rejections: Partial<Record<CompressionRejectionReason, number>>;
}

export interface TelemetryState {
  telemetry?: CompressionTelemetry;
}

export function createCompressionTelemetry(): CompressionTelemetry {
  return {
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
  };
}

function nonnegative(value: unknown, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const positive = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
  return integer ? Math.floor(positive) : positive;
}

function add(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function normalized(state: TelemetryState): CompressionTelemetry {
  const previous = state.telemetry;
  if (!previous || typeof previous !== "object") return createCompressionTelemetry();
  const value = createCompressionTelemetry();
  value.accepted = nonnegative(previous.accepted, true);
  value.rejected = Math.min(
    Number.MAX_SAFE_INTEGER - value.accepted,
    nonnegative(previous.rejected, true),
  );
  value.attempts = value.accepted + value.rejected;
  value.compressionDurationMs = nonnegative(previous.compressionDurationMs);
  value.compressionTokensSaved = nonnegative(previous.compressionTokensSaved, true);
  value.retrievals = nonnegative(previous.retrievals, true);
  value.retrievalChars = nonnegative(previous.retrievalChars, true);
  value.retrievalDurationMs = nonnegative(previous.retrievalDurationMs);
  value.retrievalEstimatedTokens = nonnegative(previous.retrievalEstimatedTokens, true);
  let remaining = value.rejected;
  for (const reason of REJECTION_REASONS) {
    const count = Math.min(remaining, nonnegative(previous.rejections?.[reason], true));
    if (count > 0) value.rejections[reason] = count;
    remaining -= count;
  }
  if (remaining > 0) value.rejections.other = add(value.rejections.other ?? 0, remaining);
  return value;
}

/** Session-local counters only: neither payloads nor arbitrary errors are retained. */
export function recordCompressionAttempt(
  state: TelemetryState,
  attempt: { durationMs: unknown; accepted: boolean; tokensSaved?: unknown; reason?: unknown },
): CompressionTelemetry {
  const value = normalized(state);
  state.telemetry = value;
  if (value.attempts === Number.MAX_SAFE_INTEGER) return value;
  value.attempts += 1;
  value.compressionDurationMs = add(value.compressionDurationMs, nonnegative(attempt.durationMs));
  if (attempt.accepted === true) {
    value.accepted += 1;
    value.compressionTokensSaved = add(
      value.compressionTokensSaved,
      nonnegative(attempt.tokensSaved, true),
    );
  } else {
    value.rejected += 1;
    const reason = REJECTION_REASONS.includes(attempt.reason as CompressionRejectionReason)
      ? (attempt.reason as CompressionRejectionReason)
      : "other";
    value.rejections[reason] = add(value.rejections[reason] ?? 0, 1);
  }
  return value;
}

/** Text retrieval cost is a character-based estimate, not provider token accounting. */
export function recordRetrievalCost(
  state: TelemetryState,
  cost: { chars: unknown; durationMs: unknown },
): CompressionTelemetry {
  const value = normalized(state);
  state.telemetry = value;
  const chars = nonnegative(cost.chars, true);
  value.retrievals = add(value.retrievals, 1);
  value.retrievalChars = add(value.retrievalChars, chars);
  value.retrievalDurationMs = add(value.retrievalDurationMs, nonnegative(cost.durationMs));
  value.retrievalEstimatedTokens = add(value.retrievalEstimatedTokens, Math.ceil(chars / 4));
  return value;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function telemetrySummary(
  state: TelemetryState,
  cacheReadTokens: unknown = 0,
  cacheWriteTokens: unknown = 0,
): string {
  const value = normalized(state);
  const compressionAverage = value.attempts > 0 ? value.compressionDurationMs / value.attempts : 0;
  const retrievalAverage = value.retrievals > 0 ? value.retrievalDurationMs / value.retrievals : 0;
  const net = value.compressionTokensSaved - value.retrievalEstimatedTokens;
  const reasons = REJECTION_REASONS.filter((reason) => (value.rejections[reason] ?? 0) > 0)
    .map((reason) => `${reason}=${count(value.rejections[reason] ?? 0)}`)
    .join(", ");
  return [
    `Compression: ${count(value.attempts)} attempts · ${count(value.accepted)} accepted · ${count(value.rejected)} rejected · avg ${compressionAverage.toFixed(1)} ms`,
    `Tokens: saved ${count(value.compressionTokensSaved)} · retrieval ≈${count(value.retrievalEstimatedTokens)} · net ≈${count(net)}`,
    `Retrieval: ${count(value.retrievals)} calls · ${count(value.retrievalChars)} chars · avg ${retrievalAverage.toFixed(1)} ms`,
    `Rejections: ${reasons || "none"}`,
    `Prompt cache: read ${count(nonnegative(cacheReadTokens, true))} · write ${count(nonnegative(cacheWriteTokens, true))} tokens (provider-reported, independent of the net estimate)`,
    "Net estimate subtracts retrieval text at approximately one token per four characters; it excludes archive savings and unmeasured cache effects.",
  ].join("\n");
}
