import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import type { TurnPhase } from "./conversation-types.js";

export const LOCAL_DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const LOCAL_TURN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const LOCAL_CLIENT_MSG_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;
export const LOCAL_LEASE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export type LocalTerminalPhase = Exclude<TurnPhase, "started">;

export type ParsedLocalTurnRenewal = {
  deviceId: string;
  localTurnId: string;
  leaseToken: string;
};

export type ParsedLocalFinishRecord = {
  ordinal: number;
  role: "assistant" | "toolResult";
  message: AgentMessage;
  payloadJson: string;
};

const TERMINAL_PHASES = new Set<string>([
  "completed",
  "failed",
  "canceled",
  "timeout",
]);

export const localTurnId = (deviceId: string, localId: string): string =>
  `desktop:${deviceId}:${localId}`;

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
  if (
    !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
    !LOCAL_TURN_ID_PATTERN.test(localId) ||
    !LOCAL_LEASE_TOKEN_PATTERN.test(leaseToken)
  ) {
    return null;
  }
  return { deviceId, localTurnId: localId, leaseToken };
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
