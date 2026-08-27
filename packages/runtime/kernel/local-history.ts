import {
  formatTimestampForHistory,
  THIRTY_MINUTES_MS,
} from "@stella/contracts/message-timestamp";
import {
  selectRecentByTokenBudget,
  type LocalContextEvent,
} from "./storage/shared.js";

const INTERNAL_TASK_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_input",
  "pause_agent",
]);

export type LocalHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type HistoryBuildOptions = {
  timezone?: string;
};

const MIN_EVENT_TOKENS = 8;
const MAX_TEXT_CHARS = 30_000;
const MAX_JSON_CHARS = 12_000;

type PendingToolCall = {
  requestId?: string;
  toolName: string;
};

type TimestampState = {
  prevDate?: string;
  timezone?: string;
  prevUserTs?: number;
};

const truncateWithSuffix = (
  value: string,
  maxChars: number,
  suffix = "...(truncated)",
): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}${suffix}`;

const stringifyBounded = (value: unknown, maxChars: number): string => {
  if (typeof value === "string") {
    return truncateWithSuffix(value.trim(), maxChars);
  }
  try {
    return truncateWithSuffix(JSON.stringify(value), maxChars);
  } catch {
    return truncateWithSuffix(String(value), maxChars);
  }
};

const asObject = <T = unknown>(value: unknown): Record<string, T> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};

const clampEventTokens = (tokens: number): number =>
  Math.max(MIN_EVENT_TOKENS, Math.floor(tokens));

const estimateTextTokens = (value: unknown): number => {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
};

const estimateJsonTokens = (value: unknown): number => {
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return Math.ceil(String(value).length / 4);
  }
};

const estimateContextEventTokens = (event: {
  type: string;
  payload?: unknown;
  requestId?: string;
}): number => {
  const payload = asObject(event.payload);

  if (event.type === "user_message" || event.type === "assistant_message") {
    return clampEventTokens(
      estimateTextTokens(payload.text) +
        (payload.usage ? estimateJsonTokens(payload.usage) : 0) +
        8,
    );
  }

  return clampEventTokens(estimateJsonTokens(payload) + 6);
};

const normalizeRequestId = (event: LocalContextEvent): string | undefined => {
  if (event.requestId && event.requestId.trim()) {
    return event.requestId;
  }
  const payload = asObject(event.payload);
  const fromPayload =
    typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  return fromPayload || undefined;
};

const normalizeToolName = (
  payload: Record<string, unknown>,
  fallbackToolName?: string,
): string => {
  const payloadToolName =
    typeof payload.toolName === "string" ? payload.toolName.trim() : "";
  return payloadToolName || fallbackToolName || "unknown_tool";
};

const shouldHideToolFromHistory = (toolName: string): boolean =>
  INTERNAL_TASK_TOOL_NAMES.has(toolName);

const formatTextEvent = (
  event: LocalContextEvent,
  tsState: TimestampState,
): LocalHistoryMessage | null => {
  const payload = asObject(event.payload);
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return null;
  const isAssistant = event.type === "assistant_message";
  const skipTs =
    !isAssistant &&
    tsState.prevUserTs != null &&
    event.timestamp - tsState.prevUserTs < THIRTY_MINUTES_MS;
  if (!isAssistant) tsState.prevUserTs = event.timestamp;
  const { tag, dateStr } = formatTimestampForHistory(
    event.timestamp,
    tsState.prevDate,
    tsState.timezone,
  );
  tsState.prevDate = dateStr;
  const body = truncateWithSuffix(text, MAX_TEXT_CHARS);
  if (isAssistant) {
    return { role: "assistant", content: body };
  }
  return {
    role: "user",
    content: skipTs ? body : `${body}\n\n${tag}`,
  };
};

const formatToolRequest = (event: LocalContextEvent): LocalHistoryMessage => {
  const payload = asObject(event.payload);
  const lines = [`[Tool call] ${normalizeToolName(payload)}`];
  const requestId = normalizeRequestId(event);
  if (requestId) lines.push(`request_id: ${requestId}`);
  lines.push(`args: ${stringifyBounded(payload.args ?? {}, MAX_JSON_CHARS)}`);
  return { role: "assistant", content: lines.join("\n") };
};

const formatToolResult = (
  event: LocalContextEvent,
  fallbackToolName: string | undefined,
): LocalHistoryMessage => {
  const payload = asObject(event.payload);
  const toolName = normalizeToolName(payload, fallbackToolName);
  const requestId = normalizeRequestId(event);
  const lines = [`[Tool result] ${toolName}`];
  if (requestId) lines.push(`request_id: ${requestId}`);
  if (typeof payload.error === "string" && payload.error.trim()) {
    lines.push(
      `error: ${truncateWithSuffix(payload.error.trim(), MAX_TEXT_CHARS)}`,
    );
  } else if ("result" in payload) {
    lines.push(`result: ${stringifyBounded(payload.result, MAX_JSON_CHARS)}`);
  }
  return { role: "user", content: lines.join("\n") };
};

const flushPendingToolCalls = (
  pendingById: Map<string, PendingToolCall>,
  pendingWithoutId: PendingToolCall[],
  out: LocalHistoryMessage[],
) => {
  for (const pending of pendingById.values()) {
    const lines = [`[Tool result] ${pending.toolName}`];
    if (pending.requestId) lines.push(`request_id: ${pending.requestId}`);
    lines.push("error: No result provided");
    out.push({ role: "user", content: lines.join("\n") });
  }
  pendingById.clear();
  for (const pending of pendingWithoutId) {
    out.push({
      role: "user",
      content: `[Tool result] ${pending.toolName}\nerror: No result provided`,
    });
  }
  pendingWithoutId.length = 0;
};

const eventsToHistoryMessages = (
  events: LocalContextEvent[],
  options: HistoryBuildOptions = {},
): LocalHistoryMessage[] => {
  const out: LocalHistoryMessage[] = [];
  const pendingById = new Map<string, PendingToolCall>();
  const pendingWithoutId: PendingToolCall[] = [];
  const tsState: TimestampState = { timezone: options.timezone };

  for (const event of events) {
    if (
      event.type !== "tool_request" &&
      event.type !== "tool_result" &&
      (pendingById.size > 0 || pendingWithoutId.length > 0)
    ) {
      flushPendingToolCalls(pendingById, pendingWithoutId, out);
    }
    if (event.type === "tool_request") {
      const payload = asObject(event.payload);
      const toolName = normalizeToolName(payload);
      if (shouldHideToolFromHistory(toolName)) {
        continue;
      }
      out.push(formatToolRequest(event));
      const pending: PendingToolCall = { toolName };
      const requestId = normalizeRequestId(event);
      if (requestId) {
        pending.requestId = requestId;
        pendingById.set(requestId, pending);
      } else {
        pendingWithoutId.push(pending);
      }
      continue;
    }
    if (event.type === "tool_result") {
      const payload = asObject(event.payload);
      const toolName = normalizeToolName(payload);
      if (shouldHideToolFromHistory(toolName)) {
        continue;
      }
      let fallbackName: string | undefined;
      const requestId = normalizeRequestId(event);
      if (requestId) {
        const pending = pendingById.get(requestId);
        fallbackName = pending?.toolName;
        pendingById.delete(requestId);
      } else if (pendingWithoutId.length > 0) {
        fallbackName = pendingWithoutId.shift()?.toolName;
      }
      out.push(formatToolResult(event, fallbackName));
      continue;
    }
    if (event.type === "user_message" || event.type === "assistant_message") {
      const message = formatTextEvent(event, tsState);
      if (message) out.push(message);
      continue;
    }
  }

  if (pendingById.size > 0 || pendingWithoutId.length > 0) {
    flushPendingToolCalls(pendingById, pendingWithoutId, out);
  }

  return out;
};

export const buildLocalHistoryFromEvents = (args: {
  events: LocalContextEvent[];
  maxTokens?: number;
  timezone?: string;
}): LocalHistoryMessage[] => {
  const selected = selectRecentByTokenBudget({
    itemsNewestFirst: [...args.events].reverse(),
    maxTokens: args.maxTokens ?? 24_000,
    estimateTokens: (event) => estimateContextEventTokens(event),
  });
  const chronological = [...selected].reverse();
  return eventsToHistoryMessages(chronological, {
    timezone: args.timezone,
  });
};
