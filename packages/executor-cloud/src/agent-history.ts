import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";

export type AgentHistoryRow = {
  seq: number;
  role: "user" | "assistant" | "toolResult";
  payloadJson: string;
  turnId: string;
};

export const AGENT_HISTORY_MAX_ROWS = 400;
export const AGENT_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_HISTORY_ROW_MAX_BYTES = 512 * 1024;

// Cloud history is its own serialized AgentMessage boundary, not a desktop
// SQLite row. Keep this validator local and dependency-free so a resident
// Durable Object wake does not initialize the desktop storage schemas.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

const isOptionalFiniteNumber = (value: unknown): boolean =>
  value === undefined || isFiniteNumber(value);

const isTextContent = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === "text" &&
  typeof value.text === "string" &&
  isOptionalString(value.textSignature);

const isImageContent = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === "image" &&
  typeof value.data === "string" &&
  typeof value.mimeType === "string" &&
  isOptionalString(value.sourcePath);

const isThinkingContent = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === "thinking" &&
  typeof value.thinking === "string" &&
  isOptionalString(value.thinkingSignature) &&
  (value.redacted === undefined || typeof value.redacted === "boolean");

const isToolCall = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === "toolCall" &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  isRecord(value.arguments) &&
  isOptionalString(value.thoughtSignature);

const isContentArray = (
  value: unknown,
  isContent: (candidate: unknown) => boolean,
): boolean => Array.isArray(value) && value.every(isContent);

const isUserContent = (value: unknown): boolean =>
  typeof value === "string" ||
  isContentArray(
    value,
    (candidate) => isTextContent(candidate) || isImageContent(candidate),
  );

const isUsage = (value: unknown): boolean => {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  return (
    isFiniteNumber(value.input) &&
    isFiniteNumber(value.output) &&
    (value.reasoning === undefined || isFiniteNumber(value.reasoning)) &&
    isFiniteNumber(value.cacheRead) &&
    isFiniteNumber(value.cacheWrite) &&
    isFiniteNumber(value.totalTokens) &&
    isFiniteNumber(value.cost.input) &&
    isFiniteNumber(value.cost.output) &&
    isFiniteNumber(value.cost.cacheRead) &&
    isFiniteNumber(value.cost.cacheWrite) &&
    isFiniteNumber(value.cost.total)
  );
};

const isStopReason = (value: unknown): boolean =>
  value === "stop" ||
  value === "length" ||
  value === "toolUse" ||
  value === "error" ||
  value === "aborted";

const isDiagnosticError = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.message === "string" &&
  isOptionalString(value.name) &&
  isOptionalString(value.stack) &&
  (value.code === undefined ||
    typeof value.code === "string" ||
    typeof value.code === "number");

const isAssistantDiagnostic = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.type === "string" &&
  isFiniteNumber(value.timestamp) &&
  (value.error === undefined || isDiagnosticError(value.error)) &&
  (value.details === undefined || isRecord(value.details));

const isAgentMessage = (value: unknown): value is AgentMessage => {
  if (!isRecord(value) || !isFiniteNumber(value.timestamp)) return false;
  switch (value.role) {
    case "user":
      return isUserContent(value.content);
    case "assistant":
      return (
        isContentArray(
          value.content,
          (candidate) =>
            isTextContent(candidate) ||
            isThinkingContent(candidate) ||
            isToolCall(candidate),
        ) &&
        typeof value.api === "string" &&
        typeof value.provider === "string" &&
        typeof value.model === "string" &&
        isUsage(value.usage) &&
        isStopReason(value.stopReason) &&
        isOptionalString(value.responseModel) &&
        isOptionalString(value.responseId) &&
        isOptionalString(value.errorMessage) &&
        isOptionalFiniteNumber(value.retryAfterMs) &&
        (value.diagnostics === undefined ||
          (Array.isArray(value.diagnostics) &&
            value.diagnostics.every(isAssistantDiagnostic)))
      );
    case "toolResult":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.toolName === "string" &&
        typeof value.isError === "boolean" &&
        isContentArray(
          value.content,
          (candidate) => isTextContent(candidate) || isImageContent(candidate),
        ) &&
        (value.modelOutputTokens === undefined ||
          (isFiniteNumber(value.modelOutputTokens) &&
            Number.isSafeInteger(value.modelOutputTokens) &&
            value.modelOutputTokens >= 0))
      );
    default:
      return false;
  }
};

const parseAgentHistoryMessage = (value: string): AgentMessage | undefined => {
  try {
    const parsed: unknown = JSON.parse(value);
    return isAgentMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

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
    const message = parseAgentHistoryMessage(payloadJson);
    if (!message || message.role !== role) {
      throw new Error(`Agent thread history row ${index} is invalid.`);
    }
    parsed.push(message);
  }
  return parsed;
};
