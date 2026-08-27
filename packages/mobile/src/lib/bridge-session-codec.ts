export type PersistedBridgeSession = {
  v: 1;
  baseUrl: string;
  sessionId: string;

  headers: Record<string, string>;

  keyB64: string;

  txSeq: number;
  expiresAt: number;
  features: string[];
  helloSupported: boolean;
  includeDeveloperArtifacts: boolean;
};

export const BRIDGE_SESSION_TX_SEQ_RESTORE_SLACK = 8192;

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

export const restoredTxSeq = (persistedTxSeq: number): number =>
  Math.max(0, Math.floor(persistedTxSeq)) + BRIDGE_SESSION_TX_SEQ_RESTORE_SLACK;
