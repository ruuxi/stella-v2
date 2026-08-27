import type {
  TurnBrokerNativeStateCheckpoint,
  TurnBrokerTurnStateCheckpointReceipt,
  TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";
import type { TurnStateCandidate } from "./turn-state-registry.js";

const HISTORY_CURSOR = /^(?:v1:empty|v1:[0-9a-f]{64})$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;

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

export const parseTurnStateCheckpointRequest = (
  value: unknown,
): TurnBrokerTurnStateCheckpointRequest | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, ["schemaVersion", "historyCursor"], ["nativeCheckpoint"]) ||
    row.schemaVersion !== 1 ||
    typeof row.historyCursor !== "string" ||
    !HISTORY_CURSOR.test(row.historyCursor)
  ) {
    return null;
  }
  if (!Object.hasOwn(row, "nativeCheckpoint")) {
    return { schemaVersion: 1, historyCursor: row.historyCursor };
  }
  const nativeCheckpoint = parseNativeCheckpoint(
    row.nativeCheckpoint,
    row.historyCursor,
  );
  return nativeCheckpoint
    ? { schemaVersion: 1, historyCursor: row.historyCursor, nativeCheckpoint }
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
