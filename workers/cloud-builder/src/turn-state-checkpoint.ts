import type {
  TurnBrokerCheckpointTranscriptRow,
  TurnBrokerNativeStateCheckpoint,
  TurnBrokerTurnStateCheckpointReceipt,
  TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";
import type { TurnStateCandidate } from "./turn-state-registry.js";

type TurnStateArchiveSessionFactory<TSession> = {
  deleteSession: (sessionId: string) => Promise<unknown>;
  createSession: (options: {
    id: string;
    cwd: string;
    commandTimeoutMs: number;
  }) => Promise<TSession>;
};

/**
 * Replace only the deterministic checkpoint helper session.
 *
 * Sandbox processes are shared across sessions, so `killAllProcesses()` is
 * intentionally forbidden here: it would also terminate the sessionless
 * agent executor that is awaiting this checkpoint response.
 */
export const replaceTurnStateArchiveSession = async <TSession>(args: {
  sandbox: TurnStateArchiveSessionFactory<TSession>;
  sessionId: string;
  commandTimeoutMs: number;
}): Promise<TSession> => {
  await args.sandbox.deleteSession(args.sessionId).catch(() => undefined);
  return await args.sandbox.createSession({
    id: args.sessionId,
    cwd: "/opt/stella",
    commandTimeoutMs: args.commandTimeoutMs,
  });
};

const HISTORY_CURSOR = /^(?:v1:empty|v1:[0-9a-f]{64})$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const MAX_SUSPENSION_TRANSCRIPT_ROWS = 1_024;
const MAX_SUSPENSION_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

const exactText = (value: unknown, max = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const parseNativeCheckpoint = (
  value: unknown,
  historyCursor: string,
): TurnBrokerNativeStateCheckpoint | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkpoint = value as Record<string, unknown>;
  if (
    !exactKeys(checkpoint, ["engine", "sessionId", "cursor", "tree", "mac"]) ||
    checkpoint.engine !== "anthropic" ||
    !exactText(checkpoint.sessionId) ||
    checkpoint.cursor !== historyCursor ||
    typeof checkpoint.mac !== "string" ||
    !HEX_SHA256.test(checkpoint.mac) ||
    !checkpoint.tree ||
    typeof checkpoint.tree !== "object" ||
    Array.isArray(checkpoint.tree)
  ) {
    return null;
  }
  const tree = checkpoint.tree as Record<string, unknown>;
  if (
    !exactKeys(tree, ["algorithm", "digest", "entries", "bytes"]) ||
    tree.algorithm !== "sha256" ||
    typeof tree.digest !== "string" ||
    !HEX_SHA256.test(tree.digest) ||
    !Number.isSafeInteger(tree.entries) ||
    Number(tree.entries) <= 0 ||
    !Number.isSafeInteger(tree.bytes) ||
    Number(tree.bytes) < 0
  ) {
    return null;
  }
  return {
    engine: "anthropic",
    sessionId: checkpoint.sessionId,
    cursor: historyCursor,
    tree: {
      algorithm: "sha256",
      digest: tree.digest,
      entries: Number(tree.entries),
      bytes: Number(tree.bytes),
    },
    mac: checkpoint.mac,
  };
};

const parseSuspensionTranscript = (
  value: unknown,
): TurnBrokerCheckpointTranscriptRow[] | null => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SUSPENSION_TRANSCRIPT_ROWS
  ) {
    return null;
  }
  let bytes = 0;
  const rows: TurnBrokerCheckpointTranscriptRow[] = [];
  for (let ordinal = 0; ordinal < value.length; ordinal += 1) {
    const entry = value[ordinal];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const row = entry as Record<string, unknown>;
    if (
      !exactKeys(row, ["ordinal", "role", "payloadJson"]) ||
      row.ordinal !== ordinal ||
      typeof row.role !== "string" ||
      !["user", "assistant", "toolResult"].includes(row.role) ||
      typeof row.payloadJson !== "string"
    ) {
      return null;
    }
    bytes += new TextEncoder().encode(row.payloadJson).byteLength;
    if (bytes > MAX_SUSPENSION_TRANSCRIPT_BYTES) return null;
    try {
      const payload = JSON.parse(row.payloadJson) as unknown;
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        (payload as Record<string, unknown>).role !== row.role
      ) {
        return null;
      }
    } catch {
      return null;
    }
    rows.push({
      ordinal,
      role: row.role,
      payloadJson: row.payloadJson,
    });
  }
  return rows;
};

export const parseTurnStateCheckpointRequest = (
  value: unknown,
): TurnBrokerTurnStateCheckpointRequest | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(
      row,
      ["schemaVersion", "historyCursor"],
      ["nativeCheckpoint", "suspensionTranscript"],
    ) ||
    row.schemaVersion !== 1 ||
    typeof row.historyCursor !== "string" ||
    !HISTORY_CURSOR.test(row.historyCursor)
  ) {
    return null;
  }
  const suspensionTranscript = Object.hasOwn(row, "suspensionTranscript")
    ? parseSuspensionTranscript(row.suspensionTranscript)
    : undefined;
  if (suspensionTranscript === null) return null;
  if (!Object.hasOwn(row, "nativeCheckpoint")) {
    return {
      schemaVersion: 1,
      historyCursor: row.historyCursor,
      ...(suspensionTranscript ? { suspensionTranscript } : {}),
    };
  }
  const nativeCheckpoint = parseNativeCheckpoint(
    row.nativeCheckpoint,
    row.historyCursor,
  );
  return nativeCheckpoint
    ? {
        schemaVersion: 1,
        historyCursor: row.historyCursor,
        nativeCheckpoint,
        ...(suspensionTranscript ? { suspensionTranscript } : {}),
      }
    : null;
};

export const publicTurnStateCheckpointReceipt = (
  candidate: TurnStateCandidate,
  replayed: boolean,
): TurnBrokerTurnStateCheckpointReceipt => ({
  schemaVersion: 1,
  operationId: candidate.operationId,
  historyCursor: candidate.historyCursor,
  workspaceSha256: candidate.workspace.sha256,
  ...(candidate.native ? { nativeSha256: candidate.native.sha256 } : {}),
  receipt: candidate.receipt,
  replayed,
});
