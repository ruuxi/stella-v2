/**
 * Serialization for persisted desktop-bridge sessions (pure — no Expo
 * imports, tested under `bun test`). Persisting the session lets an app
 * cold-start skip the challenge → Convex-mint → consume handshake (~3 RTTs)
 * whenever the desktop still honors the session; the liveness probe before
 * reuse catches every case where it doesn't.
 */

export type PersistedBridgeSession = {
  v: 1;
  baseUrl: string;
  sessionId: string;
  /** Auth headers exactly as sent on every bridge request. */
  headers: Record<string, string>;
  /** Derived AES-256-GCM session key, base64url. */
  keyB64: string;
  /** Envelope tx sequence at save time (restored with slack, see below). */
  txSeq: number;
  expiresAt: number;
  features: string[];
  helloSupported: boolean;
  includeDeveloperArtifacts: boolean;
};

/**
 * On restore the desktop's anti-replay window has seen seqs we may not have
 * persisted (saves are not per-message). Restart the counter well past
 * anything the previous process could plausibly have sent so no fresh
 * envelope reuses a seq the desktop already recorded. Seqs are plain numbers;
 * even at one envelope per millisecond this costs ~3 months of headroom per
 * restore against Number.MAX_SAFE_INTEGER.
 */
export const BRIDGE_SESSION_TX_SEQ_RESTORE_SLACK = 8192;

/** Don't bother restoring a session that is about to expire anyway. */
export const BRIDGE_SESSION_RESTORE_MIN_REMAINING_MS = 2 * 60_000;

export const serializePersistedBridgeSession = (
  session: PersistedBridgeSession,
): string => JSON.stringify(session);

export const deserializePersistedBridgeSession = (
  raw: string | null | undefined,
  nowMs: number,
): PersistedBridgeSession | null => {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.baseUrl !== "string" ||
    !record.baseUrl.trim() ||
    typeof record.sessionId !== "string" ||
    !record.sessionId.trim() ||
    typeof record.keyB64 !== "string" ||
    !record.keyB64.trim() ||
    typeof record.txSeq !== "number" ||
    !Number.isFinite(record.txSeq) ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt) ||
    !record.headers ||
    typeof record.headers !== "object"
  ) {
    return null;
  }
  if (record.expiresAt <= nowMs + BRIDGE_SESSION_RESTORE_MIN_REMAINING_MS) {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    record.headers as Record<string, unknown>,
  )) {
    if (typeof value === "string") headers[key] = value;
  }
  const features = Array.isArray(record.features)
    ? record.features.filter((f): f is string => typeof f === "string")
    : [];
  return {
    v: 1,
    baseUrl: record.baseUrl.trim(),
    sessionId: record.sessionId.trim(),
    headers,
    keyB64: record.keyB64.trim(),
    txSeq: Math.max(0, Math.floor(record.txSeq)),
    expiresAt: record.expiresAt,
    features,
    helloSupported: record.helloSupported === true,
    includeDeveloperArtifacts: record.includeDeveloperArtifacts === true,
  };
};

/** The tx seq a restored crypto session must resume from. */
export const restoredTxSeq = (persistedTxSeq: number): number =>
  Math.max(0, Math.floor(persistedTxSeq)) + BRIDGE_SESSION_TX_SEQ_RESTORE_SLACK;
