import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import type { TurnPhase } from "./conversation-types.js";

export const LOCAL_DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const LOCAL_TURN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const LOCAL_CLIENT_MSG_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;
export const LOCAL_LEASE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export const LOCAL_OWNER_GENERATION_MAX_CHARS = 512;

export type LocalTerminalPhase = Exclude<TurnPhase, "started">;

export type ParsedLocalTurnRenewal = {
  deviceId: string;
  expectedOwnerGeneration: string;
  localTurnId: string;
  leaseToken: string;
};

export type LocalClientMessageReceipt = {
  ownerGeneration: string;
  clientMsgId: string;
  beginFingerprint: string;
  turnId: string;
  phase?: LocalTerminalPhase;
};

export type LocalClientMessageReplay =
  | "new"
  | "same_turn"
  | "duplicate"
  | "conflict";

export const localTurnLeaseAllowsIdentityTransition = (args: {
  boundOwnerId: string;
  callerOwnerId: string;
  suppliedLeaseToken?: string;
  activeLease?: { ownerId: string; leaseToken: string };
}): boolean =>
  args.callerOwnerId === args.boundOwnerId ||
  Boolean(
    args.suppliedLeaseToken &&
    args.activeLease?.ownerId === args.boundOwnerId &&
    args.activeLease.leaseToken === args.suppliedLeaseToken,
  );

export type ParsedLocalFinishRecord = {
  ordinal: number;
  role: "assistant" | "toolResult";
  message: AgentMessage;
  payloadJson: string;
};

const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalizeJson(nested)]),
  );
};

/**
 * The desktop reconstructs the same logical AgentMessage after a restart, and
 * that construction gives it a fresh top-level timestamp. The timestamp is
 * delivery metadata, not message identity, so exclude it while retaining and
 * canonically ordering every other field used by the model.
 */
export const localClientMessageFingerprintSource = (
  clientMsgId: string,
  message: AgentMessage,
): string => {
  const logicalMessage = { ...(message as unknown as Record<string, unknown>) };
  delete logicalMessage.timestamp;
  return `${clientMsgId}\u0000${JSON.stringify(canonicalizeJson(logicalMessage))}`;
};

const TERMINAL_PHASES = new Set<string>([
  "completed",
  "failed",
  "canceled",
  "timeout",
]);

export const localTurnId = (deviceId: string, localId: string): string =>
  `desktop:${deviceId}:${localId}`;

export const parseExpectedOwnerGeneration = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= LOCAL_OWNER_GENERATION_MAX_CHARS
    ? normalized
    : null;
};

export const parseLocalTurnRenewal = (
  value: unknown,
): ParsedLocalTurnRenewal | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.renewOnly !== true) return null;
  const deviceId =
    typeof candidate.deviceId === "string" ? candidate.deviceId.trim() : "";
  const localId =
    typeof candidate.localTurnId === "string"
      ? candidate.localTurnId.trim()
      : "";
  const leaseToken =
    typeof candidate.leaseToken === "string" ? candidate.leaseToken.trim() : "";
  const expectedOwnerGeneration = parseExpectedOwnerGeneration(
    candidate.expectedOwnerGeneration,
  );
  if (
    !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
    !LOCAL_TURN_ID_PATTERN.test(localId) ||
    !LOCAL_LEASE_TOKEN_PATTERN.test(leaseToken) ||
    !expectedOwnerGeneration
  ) {
    return null;
  }
  return {
    deviceId,
    expectedOwnerGeneration,
    localTurnId: localId,
    leaseToken,
  };
};

export const classifyLocalClientMessageReplay = (
  receipt: LocalClientMessageReceipt | undefined,
  candidate: {
    ownerGeneration: string;
    clientMsgId: string;
    beginFingerprint: string;
    turnId: string;
  },
): LocalClientMessageReplay => {
  if (!receipt) return "new";
  if (
    receipt.ownerGeneration !== candidate.ownerGeneration ||
    receipt.clientMsgId !== candidate.clientMsgId ||
    receipt.beginFingerprint !== candidate.beginFingerprint
  ) {
    return "conflict";
  }
  return receipt.turnId === candidate.turnId ? "same_turn" : "duplicate";
};

export const parseLocalTerminalPhase = (
  value: unknown,
): LocalTerminalPhase | null =>
  typeof value === "string" && TERMINAL_PHASES.has(value)
    ? (value as LocalTerminalPhase)
    : null;

export const parseLocalFinishRecords = (
  value: unknown,
  maxRows: number,
): { records: ParsedLocalFinishRecord[]; totalBytes: number } | null => {
  if (!Array.isArray(value) || value.length > maxRows) return null;
  let totalBytes = 0;
  const parsed: ParsedLocalFinishRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!candidate || typeof candidate !== "object") return null;
    const record = candidate as {
      ordinal?: unknown;
      role?: unknown;
      payloadJson?: unknown;
    };
    if (
      record.ordinal !== index ||
      (record.role !== "assistant" && record.role !== "toolResult") ||
      typeof record.payloadJson !== "string"
    ) {
      return null;
    }
    let message: AgentMessage;
    try {
      message = JSON.parse(record.payloadJson) as AgentMessage;
    } catch {
      return null;
    }
    if ((message as { role?: unknown }).role !== record.role) return null;
    totalBytes += new TextEncoder().encode(record.payloadJson).length;
    parsed.push({
      ordinal: index,
      role: record.role,
      message,
      payloadJson: record.payloadJson,
    });
  }
  return { records: parsed, totalBytes };
};
