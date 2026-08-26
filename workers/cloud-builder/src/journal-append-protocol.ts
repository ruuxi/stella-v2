import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import type { MessageRole } from "./conversation-types.js";

const RECORD_KEYS = new Set(["kind", "role", "payloadJson", "hidden"]);

export type ParsedVoiceJournalRecord = {
  kind: "message";
  role: MessageRole;
  message: AgentMessage;
  payloadJson: string;
  hidden: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasMessageShape = (
  message: Record<string, unknown>,
  role: MessageRole,
): boolean => {
  if (
    message.role !== role ||
    typeof message.timestamp !== "number" ||
    !Number.isFinite(message.timestamp)
  ) {
    return false;
  }
  if (role === "user") {
    return (
      typeof message.content === "string" || Array.isArray(message.content)
    );
  }
  if (!Array.isArray(message.content)) return false;
  if (role === "assistant") {
    return (
      typeof message.api === "string" &&
      typeof message.provider === "string" &&
      typeof message.model === "string" &&
      typeof message.stopReason === "string" &&
      isRecord(message.usage)
    );
  }
  return (
    typeof message.toolCallId === "string" &&
    message.toolCallId.length > 0 &&
    typeof message.toolName === "string" &&
    message.toolName.length > 0 &&
    typeof message.isError === "boolean"
  );
};

/**
 * `/journal` is a user-authenticated network write path. It accepts only the
 * exact voice message envelope produced by the desktop writer; lifecycle rows
 * and declared/payload role mismatches fail closed.
 */
export const parseVoiceJournalRecords = (
  value: unknown,
): ParsedVoiceJournalRecord[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed: ParsedVoiceJournalRecord[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some((key) => !RECORD_KEYS.has(key)) ||
      candidate.kind !== "message" ||
      (candidate.role !== "user" &&
        candidate.role !== "assistant" &&
        candidate.role !== "toolResult") ||
      (candidate.hidden !== undefined &&
        typeof candidate.hidden !== "boolean") ||
      typeof candidate.payloadJson !== "string" ||
      candidate.payloadJson.length === 0
    ) {
      return null;
    }
    let message: unknown;
    try {
      message = JSON.parse(candidate.payloadJson);
    } catch {
      return null;
    }
    if (!isRecord(message) || !hasMessageShape(message, candidate.role)) {
      return null;
    }
    parsed.push({
      kind: "message",
      role: candidate.role,
      message: message as AgentMessage,
      payloadJson: candidate.payloadJson,
      hidden: candidate.hidden === true,
    });
  }
  return parsed;
};
