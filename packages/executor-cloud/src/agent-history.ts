import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import { parseRuntimeThreadPayload } from "../../runtime/kernel/storage/shared.js";

export type AgentHistoryRow = {
  seq: number;
  role: "user" | "assistant" | "toolResult";
  payloadJson: string;
  turnId: string;
};

export const AGENT_HISTORY_MAX_ROWS = 400;
export const AGENT_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_HISTORY_ROW_MAX_BYTES = 512 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

/**
 * Treat Convex thread history as authoritative input, not best-effort cache.
 * Any malformed row rejects the whole preflight so an agent can never run on
 * silently truncated/corrupted context.
 */
export const parseAuthoritativeAgentHistory = (
  value: unknown,
): AgentMessage[] => {
  if (!Array.isArray(value) || value.length > AGENT_HISTORY_MAX_ROWS) {
    throw new Error("Agent thread history is not a bounded row array.");
  }
  const parsed: AgentMessage[] = [];
  let priorSeq = -1;
  let totalBytes = 0;
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) {
      throw new Error(`Agent thread history row ${index} is malformed.`);
    }
    const { seq, role, payloadJson, turnId } = candidate;
    if (
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      seq <= priorSeq ||
      (role !== "user" && role !== "assistant" && role !== "toolResult") ||
      typeof payloadJson !== "string" ||
      typeof turnId !== "string" ||
      !turnId.trim() ||
      turnId.length > 256
    ) {
      throw new Error(`Agent thread history row ${index} is malformed.`);
    }
    priorSeq = seq;
    const bytes = utf8Bytes(payloadJson);
    totalBytes += bytes;
    if (
      bytes > AGENT_HISTORY_ROW_MAX_BYTES ||
      totalBytes > AGENT_HISTORY_MAX_BYTES
    ) {
      throw new Error("Agent thread history exceeds its byte bound.");
    }
    const message = parseRuntimeThreadPayload(payloadJson);
    if (!message || message.role !== role) {
      throw new Error(`Agent thread history row ${index} is invalid.`);
    }
    parsed.push(message as AgentMessage);
  }
  return parsed;
};
