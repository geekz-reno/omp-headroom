export interface ProxyCapabilityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProxyCapabilities {
  ready: boolean;
  compatible: boolean;
  checks: ProxyCapabilityCheck[];
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The probe contains only synthetic tool output. It never invokes a model or
// includes a session ID, credential, prompt, or user-provided content.
const PROBE_ORIGINAL = Array.from(
  { length: 400 },
  () => "headroom capability fixture: unchanged repeated diagnostic record; status=ok; count=1",
).join("\n");

function containsOriginal(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === "string") {
    if (value.includes(PROBE_ORIGINAL)) return true;
    try {
      return containsOriginal(JSON.parse(value), depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((item) => containsOriginal(item, depth + 1));
  if (record(value)) return Object.values(value).some((item) => containsOriginal(item, depth + 1));
  return false;
}

/** Check the exact compression/retrieval contract used by the provider hooks. */
export async function checkProxyCapabilities(
  proxyUrl: string,
  signal?: AbortSignal,
  timeoutMs = 5_000,
): Promise<ProxyCapabilities> {
  const checks: ProxyCapabilityCheck[] = [];
  const result: ProxyCapabilities = { ready: false, compatible: false, checks };
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : 5_000;
  const deadline = AbortSignal.timeout(duration);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const base = proxyUrl.replace(/\/+$/, "");
  let stage = "readiness";
  try {
    requestSignal.throwIfAborted();
    const live = await fetch(`${base}/livez`, { signal: requestSignal });
    if (!live.ok) throw new Error(`GET /livez returned HTTP ${live.status}`);
    const health: unknown = await live.json();
    if (!record(health)) throw new Error("GET /livez returned an invalid health object");
    if (
      health.alive === false ||
      health.ready === false ||
      (typeof health.status === "string" && health.status !== "healthy" && health.status !== "ok")
    ) {
      throw new Error(`Proxy is not ready (${String(health.status ?? "unhealthy")})`);
    }
    result.ready = true;
    checks.push({ name: stage, ok: true, detail: "Proxy health endpoint is ready" });

    stage = "compression";
    const messages = [
      { role: "user", content: "Inspect the diagnostic tool output." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "headroom_capability_probe",
            type: "function",
            function: { name: "headroom_diagnostic", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "headroom_capability_probe", content: PROBE_ORIGINAL },
    ];
    const compressed = await fetch(`${base}/v1/compress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client": "omp",
        "X-Headroom-Diagnostic": "1",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages,
        config: {
          mode: "ccr",
          compress_user_messages: false,
          protect_recent: 0,
          protect_analysis_context: false,
        },
      }),
      signal: requestSignal,
    });
    if (!compressed.ok) throw new Error(`POST /v1/compress returned HTTP ${compressed.status}`);
    const data: unknown = await compressed.json();
    if (!record(data)) throw new Error("Compression response is not an object");
    const before = data.tokens_before ?? data.tokensBefore;
    const after = data.tokens_after ?? data.tokensAfter;
    const saved = data.tokens_saved ?? data.tokensSaved;
    if (
      typeof before !== "number" ||
      typeof after !== "number" ||
      !Number.isInteger(before) ||
      !Number.isInteger(after) ||
      before <= 0 ||
      after < 0 ||
      after >= before ||
      (saved !== undefined && saved !== before - after)
    ) {
      throw new Error(
        "Proxy did not prove a strict token reduction with consistent integer metrics",
      );
    }
    const output = data.messages;
    if (
      !Array.isArray(output) ||
      output.length !== messages.length ||
      stableJson(output[0]) !== stableJson(messages[0]) ||
      stableJson(output[1]) !== stableJson(messages[1]) ||
      !record(output[2]) ||
      output[2].role !== "tool" ||
      output[2].tool_call_id !== "headroom_capability_probe" ||
      typeof output[2].content !== "string" ||
      JSON.stringify(output).length >= JSON.stringify(messages).length
    ) {
      throw new Error(
        "Proxy response is not smaller or changes the protected message/tool structure",
      );
    }
    const hashes = data.ccr_hashes ?? data.ccrHashes;
    const marker = output[2].content.match(/hash=([0-9A-Za-z_-]{8,128})(?![0-9A-Za-z_-])/)?.[1];
    const hash =
      marker ??
      (Array.isArray(hashes)
        ? hashes.find((value) => typeof value === "string" && /^[0-9A-Za-z_-]{8,128}$/.test(value))
        : undefined);
    if (typeof hash !== "string") throw new Error("CCR compression returned no retrievable hash");
    checks.push({
      name: stage,
      ok: true,
      detail: `CCR compression preserved message structure and reduced ${before} tokens to ${after}`,
    });

    stage = "retrieval";
    const retrieved = await fetch(`${base}/v1/retrieve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client": "omp",
        "X-Headroom-Diagnostic": "1",
      },
      body: JSON.stringify({ hash }),
      signal: requestSignal,
    });
    if (!retrieved.ok) throw new Error(`POST /v1/retrieve returned HTTP ${retrieved.status}`);
    const original: unknown = await retrieved.json();
    if ((record(original) && original.error) || !containsOriginal(original)) {
      throw new Error("CCR retrieval did not return the complete diagnostic original");
    }
    checks.push({ name: stage, ok: true, detail: "CCR retrieval returned the complete original" });
    result.compatible = true;
  } catch (error) {
    checks.push({ name: stage, ok: false, detail: failure(error) });
  }
  return result;
}

export interface VerifiedUpdateCallbacks<Snapshot> {
  snapshot: () => Snapshot | Promise<Snapshot>;
  upgrade: () => void | Promise<void>;
  verify: () => boolean | { compatible: boolean } | Promise<boolean | { compatible: boolean }>;
  rollback: (snapshot: Snapshot) => void | Promise<void>;
  /** Restart/reconnect the restored installation, when the caller owns it. */
  recover?: () => void | Promise<void>;
}

export interface VerifiedUpdateResult {
  updated: boolean;
  rolledBack: boolean;
  error?: string;
  rollbackError?: string;
}

/** Snapshot before mutation; failed upgrades or capability checks restore it. */
export async function runVerifiedUpdate<Snapshot>(
  callbacks: VerifiedUpdateCallbacks<Snapshot>,
): Promise<VerifiedUpdateResult> {
  let snapshot: Snapshot;
  try {
    snapshot = await callbacks.snapshot();
  } catch (error) {
    return {
      updated: false,
      rolledBack: false,
      error: `Update snapshot failed: ${failure(error)}`,
    };
  }
  try {
    await callbacks.upgrade();
    const verified = await callbacks.verify();
    if (!(typeof verified === "boolean" ? verified : verified.compatible)) {
      throw new Error("Proxy capability verification failed");
    }
    return { updated: true, rolledBack: false };
  } catch (error) {
    const outcome: VerifiedUpdateResult = {
      updated: false,
      rolledBack: false,
      error: failure(error),
    };
    try {
      await callbacks.rollback(snapshot);
      await callbacks.recover?.();
      outcome.rolledBack = true;
    } catch (rollbackError) {
      outcome.rollbackError = failure(rollbackError);
    }
    return outcome;
  }
}

import { isRecord as record, stableJson } from "./util.ts";
