// Cross-session subagent stats via process-shared counters.
//
// loadLegacyPiModule imports each extension with `?mtime=<now>`, which busts
// Bun's module cache — so every session (main + each subagent) gets a SEPARATE
// factory call. Module-level state in THIS module IS shared across those calls
// (Bun caches the module despite the ?mtime bust), so it is the only reliable
// cross-call bridge. Subagent compression counts flow through `shared` below;
// the main UI session folds them into its widget counters.
import type { HeadroomState } from "./types.ts";

// SHARED across all factory calls (main + subagent). The factory creates a
// SEPARATE `state` object per call, so per-state fields cannot bridge them;
// these module-level counters are the ONLY reliable cross-call channel. Held in
// one mutable object because ES module bindings cannot be reassigned by importers.
export const shared = {
  foreignProvider: 0,
  foreignTool: 0,
  foreignCcr: 0,
  foreignCleared: false,
  // Process-wide spawn claim (epoch ms; 0 = unclaimed). Each factory call gets
  // its own `state`, so `state.proxyStarting` cannot prevent a second session
  // instance from spawning a duplicate proxy child during cold start.
  proxySpawnClaimedAt: 0,
};

// Session IDs of subagents seen in THIS process (hasUI=false session_start).
// The main reads the proxy's per_project bucket for each to render (+N).
export const subagentSessionIds = new Set<string>();

// Per-factory-call mutable state. Each OMP session (main + subagent) gets its
// own instance; cross-call totals live in the module-level `shared` object above.
export function createHeadroomState(): HeadroomState {
  return {
    enabled: process.env.OMP_HEADROOM_DISABLED !== "1",
    proxyReady: false,
    proxyStarting: false,
    proxyProcess: undefined,
    proxyCheckedAt: 0,
    statsFetchedAt: 0,
    statsInFlight: undefined,
    stats: undefined,
    lastError: "",
    installState: "",
    version: "",
    latest: "",
    reconcileKey: "",
    providerCompressions: 0,
    toolCompressions: 0,
    ccrHashes: 0,
    tokensSaved: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessionArchiveCompactions: 0,
    ompCompactions: 0,
    _ompHydrated: false,
    _archiveHydrated: false,
    sessionArchiveCharsBefore: 0,
    sessionArchiveCharsAfter: 0,
    sessionArchiveCharsSaved: 0,
    headroomCompactActive: false,
    lastCompactionCcrHash: "",
    sessionId: "",
    rainbowPhase: 0,
    connectAttempt: 0,
    connectExhausted: false,
  };
}
