import { isCloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import type { TurnBrokerTurnStateCheckpointReceipt } from "@stella/contracts/turn-credential-broker";
import type { AgentExecutorResult } from "./shared/types.js";
import { parseTurnStateCheckpointRequest } from "../turn-state-checkpoint.js";

export const validBuilderFallbackMessages = (
  value: unknown,
): value is Array<{ ordinal: number; role: string; payloadJson: string }> => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_024)
    return false;
  let bytes = 0;
  return value.every((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return false;
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "ordinal,payloadJson,role" ||
      row.ordinal !== index ||
      typeof row.role !== "string" ||
      !["user", "assistant", "toolResult"].includes(row.role) ||
      typeof row.payloadJson !== "string"
    )
      return false;
    bytes += new TextEncoder().encode(row.payloadJson).byteLength;
    if (bytes > 5 * 1024 * 1024) return false;
    try {
      const payload = JSON.parse(row.payloadJson) as { role?: unknown };
      return payload?.role === row.role;
    } catch {
      return false;
    }
  });
};

export const validTurnStateCheckpointReceipt = (
  value: unknown,
): value is TurnBrokerTurnStateCheckpointReceipt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const allowed = new Set(["operationId", "historyCursor", "manifestId"]);
  return (
    Object.keys(receipt).every((key) => allowed.has(key)) &&
    typeof receipt.operationId === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.operationId) &&
    typeof receipt.historyCursor === "string" &&
    /^(?:v1:empty|v1:[0-9a-f]{64})$/u.test(receipt.historyCursor) &&
    typeof receipt.manifestId === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.manifestId)
  );
};

export const parseAgentExecutorResult = (
  value: unknown,
): AgentExecutorResult | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const allowed = new Set([
    "outcome",
    "ok",
    "finalText",
    "error",
    "usage",
    "checkpointPolicy",
    "checkpointMs",
    "turnStateCheckpoint",
    "suspension",
    "builderFallback",
  ]);
  const boundedOutput = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    new TextEncoder().encode(candidate).byteLength <= 4 * 1024 * 1024;
  if (
    !Object.keys(result).every((key) => allowed.has(key)) ||
    (result.outcome !== undefined &&
      result.outcome !== "completed" &&
      result.outcome !== "suspended") ||
    typeof result.ok !== "boolean" ||
    (result.finalText !== undefined && !boundedOutput(result.finalText)) ||
    (result.error !== undefined && !boundedOutput(result.error)) ||
    (result.usage !== undefined &&
      (!result.usage ||
        typeof result.usage !== "object" ||
        Array.isArray(result.usage))) ||
    (result.checkpointMs !== undefined &&
      (!Number.isSafeInteger(result.checkpointMs) ||
        Number(result.checkpointMs) < 0)) ||
    (result.checkpointPolicy !== undefined &&
      result.checkpointPolicy !== "preserve_prior" &&
      result.checkpointPolicy !== "builder_fallback")
  ) {
    return null;
  }

  if (result.outcome === "suspended") {
    if (
      result.ok !== false ||
      result.finalText !== "" ||
      result.error !== undefined ||
      !isCloudBrowserSuspension(result.suspension) ||
      result.checkpointPolicy !== undefined ||
      result.builderFallback !== undefined
    ) {
      return null;
    }
  } else if (result.suspension !== undefined) {
    return null;
  }

  if (result.checkpointPolicy === "builder_fallback") {
    if (
      !result.builderFallback ||
      typeof result.builderFallback !== "object" ||
      Array.isArray(result.builderFallback)
    ) {
      return null;
    }
    const fallback = result.builderFallback as Record<string, unknown>;
    if (
      !Object.keys(fallback).every((key) =>
        ["historyCursor", "messages", "nativeCheckpoint"].includes(key),
      ) ||
      typeof fallback.historyCursor !== "string" ||
      !validBuilderFallbackMessages(fallback.messages) ||
      !parseTurnStateCheckpointRequest({
        schemaVersion: 1,
        historyCursor: fallback.historyCursor,
        ...(fallback.nativeCheckpoint !== undefined
          ? { nativeCheckpoint: fallback.nativeCheckpoint }
          : {}),
      }) ||
      result.turnStateCheckpoint !== undefined
    ) {
      return null;
    }
  } else if (result.builderFallback !== undefined) {
    return null;
  }

  if (result.checkpointPolicy === "preserve_prior") {
    if (result.turnStateCheckpoint !== undefined) return null;
  } else if (
    result.checkpointPolicy !== "builder_fallback" &&
    !validTurnStateCheckpointReceipt(result.turnStateCheckpoint)
  ) {
    return null;
  }
  return result as AgentExecutorResult;
};
