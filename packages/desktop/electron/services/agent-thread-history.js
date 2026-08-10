import {
  redactSensitiveText,
  sanitizeSensitiveData,
} from "@stella/contracts/sensitive-data";

const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";
const REASONING_DISPLAY_MAX_CHARS = 8_000;
const TOOL_INPUT_DISPLAY_MAX_CHARS = 6_000;
const TOOL_OUTPUT_DISPLAY_MAX_CHARS = 12_000;
const DATA_URL_RE =
  /^data:(?:image|audio|video|application\/octet-stream)[^,]*;base64,/i;
const BASE64_BLOB_RE = /^[A-Za-z0-9+/_=-]+$/;
const FREEFORM_SECRET_LABEL_RE =
  /\b(password|passwd|passphrase|api[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|session[-_ ]?token|secret)(["']?\s*(?::|=|\bis\b)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)/gi;

const redactFreeformText = (value) =>
  redactSensitiveText(String(value ?? "")).replace(
    FREEFORM_SECRET_LABEL_RE,
    "$1$2[REDACTED]",
  );

const truncatePreparedText = (value, maxChars) => {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[${omitted.toLocaleString("en-US")} characters omitted from this view]`;
};

const truncateForDisplay = (value, maxChars) =>
  truncatePreparedText(redactFreeformText(value), maxChars);

const omitBinaryData = (value) => {
  if (typeof value === "string") {
    if (
      DATA_URL_RE.test(value) ||
      (value.length > 512 && BASE64_BLOB_RE.test(value))
    ) {
      return `[Binary data omitted: ${value.length.toLocaleString("en-US")} characters]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(omitBinaryData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, omitBinaryData(entry)]),
  );
};

const stringifyForDisplay = (value, maxChars) => {
  try {
    const sanitized = omitBinaryData(sanitizeSensitiveData(value));
    const serialized = JSON.stringify(sanitized, null, 2);
    return truncatePreparedText(
      serialized ?? String(sanitized ?? ""),
      maxChars,
    );
  } catch {
    return "[Unable to display persisted tool input]";
  }
};

const textFromToolResult = (payload) =>
  truncateForDisplay(
    payload.content
      .map((block) =>
        block.type === "text" ? block.text : `[Image: ${block.mimeType}]`,
      )
      .join("\n")
      .trim(),
    TOOL_OUTPUT_DISPLAY_MAX_CHARS,
  );

const checkpointContent = (value) => {
  const trimmed = value.trim();
  if (!trimmed.startsWith(THREAD_CHECKPOINT_MARKER)) return null;
  const content = trimmed.slice(THREAD_CHECKPOINT_MARKER.length).trim();
  return content
    ? truncateForDisplay(content, REASONING_DISPLAY_MAX_CHARS)
    : null;
};

export const listAgentThreadMessages = (store, args = {}) => {
  const rawThreadId = Reflect.get(args, "threadId");
  const threadId = typeof rawThreadId === "string" ? rawThreadId.trim() : "";
  if (!threadId) throw new Error("threadId is required.");
  const rawLimit = Reflect.get(args, "limit");
  const limit = Math.min(
    300,
    Math.max(1, Math.floor(typeof rawLimit === "number" ? rawLimit : 200)),
  );
  const threadMessages = store.loadThreadMessages(threadId, limit);
  const toolResultsByCallId = new Map();
  const pairedToolCallIds = new Set();
  for (const message of threadMessages) {
    if (message.payload?.role === "toolResult") {
      toolResultsByCallId.set(message.payload.toolCallId, message);
      continue;
    }
    if (message.payload?.role !== "assistant") continue;
    for (const block of message.payload.content) {
      if (block.type === "toolCall") pairedToolCallIds.add(block.id);
    }
  }
  const lifecycleById = new Map(
    store
      .listLifecycleEventsByIds(
        threadMessages.flatMap((message) => {
          const eventId = message.customMessage?.eventId;
          return message.customMessage?.customType ===
            "runtime.task_lifecycle" && eventId
            ? [eventId]
            : [];
        }),
      )
      .map((event) => [event._id, event]),
  );
  const projected = threadMessages.flatMap((message) => {
    if (message.payload?.role === "assistant") {
      return message.payload.content.flatMap((block, blockIndex) => {
        const blockEntryId = message.entryId
          ? `${message.entryId}:block:${blockIndex}`
          : undefined;
        if (block.type === "text") {
          const content = truncateForDisplay(
            block.text,
            TOOL_OUTPUT_DISPLAY_MAX_CHARS,
          );
          return content
            ? [
                {
                  ...(blockEntryId ? { entryId: blockEntryId } : {}),
                  timestamp: message.timestamp,
                  role: "assistant",
                  content,
                },
              ]
            : [];
        }
        if (block.type === "thinking") {
          const content = truncateForDisplay(
            block.thinking,
            REASONING_DISPLAY_MAX_CHARS,
          );
          return content
            ? [
                {
                  ...(blockEntryId ? { entryId: blockEntryId } : {}),
                  timestamp: message.timestamp,
                  role: "reasoning",
                  content,
                },
              ]
            : [];
        }
        if (block.type !== "toolCall") return [];
        const resultMessage = toolResultsByCallId.get(block.id);
        const resultPayload = resultMessage?.payload;
        const toolName = truncateForDisplay(block.name, 200) || "Tool";
        const status = resultPayload
          ? resultPayload.isError
            ? "error"
            : "completed"
          : "running";
        return [
          {
            ...(blockEntryId ? { entryId: blockEntryId } : {}),
            timestamp: message.timestamp,
            role: "tool",
            content: `${toolName} ${status}`,
            toolActivity: {
              toolCallId: truncateForDisplay(block.id, 300),
              toolName,
              status,
              input: stringifyForDisplay(
                block.arguments,
                TOOL_INPUT_DISPLAY_MAX_CHARS,
              ),
              ...(resultPayload
                ? {
                    output: textFromToolResult(resultPayload),
                    completedAt: resultMessage.timestamp,
                  }
                : {}),
            },
          },
        ];
      });
    }
    if (message.payload?.role === "toolResult") {
      if (pairedToolCallIds.has(message.payload.toolCallId)) return [];
      const toolName =
        truncateForDisplay(message.payload.toolName, 200) || "Tool";
      const status = message.payload.isError ? "error" : "completed";
      return [
        {
          ...(message.entryId ? { entryId: message.entryId } : {}),
          timestamp: message.timestamp,
          role: "tool",
          content: `${toolName} ${status}`,
          toolActivity: {
            toolCallId: truncateForDisplay(message.payload.toolCallId, 300),
            toolName,
            status,
            output: textFromToolResult(message.payload),
            completedAt: message.timestamp,
          },
        },
      ];
    }
    if (message.customMessage) {
      const lifecycleEvent = message.customMessage.eventId
        ? lifecycleById.get(message.customMessage.eventId)
        : undefined;
      return lifecycleEvent
        ? [
            {
              ...(message.entryId ? { entryId: message.entryId } : {}),
              timestamp: message.timestamp,
              role: "lifecycle",
              content: "",
              lifecycleEvent,
            },
          ]
        : [];
    }
    const checkpoint =
      message.role === "assistant" ? checkpointContent(message.content) : null;
    if (checkpoint) {
      return [
        {
          ...(message.entryId ? { entryId: message.entryId } : {}),
          timestamp: message.timestamp,
          role: "checkpoint",
          content: checkpoint,
        },
      ];
    }
    const content = truncateForDisplay(
      message.content,
      TOOL_OUTPUT_DISPLAY_MAX_CHARS,
    );
    if (!content || (message.role !== "assistant" && message.role !== "user")) {
      return [];
    }
    return [
      {
        ...(message.entryId ? { entryId: message.entryId } : {}),
        timestamp: message.timestamp,
        role: message.role,
        content,
      },
    ];
  });
  const authored = new Set(
    projected.map((message) => `${message.role}\0${message.content.trim()}`),
  );
  const agentRecord = store.getAgentRecord(threadId);
  const storedPrompt = agentRecord
    ? Reflect.get(agentRecord, "prompt")
    : undefined;
  if (agentRecord && typeof storedPrompt === "string" && storedPrompt.trim()) {
    const content = truncateForDisplay(
      storedPrompt,
      TOOL_OUTPUT_DISPLAY_MAX_CHARS,
    );
    const key = `user\0${content}`;
    if (!authored.has(key)) {
      authored.add(key);
      const promptCreatedAt = Reflect.get(agentRecord, "promptCreatedAt");
      projected.push({
        entryId: `${threadId}:durable-initial-instruction`,
        timestamp:
          typeof promptCreatedAt === "number"
            ? promptCreatedAt
            : agentRecord.startedAt,
        role: "user",
        content,
      });
    }
  }
  if (agentRecord?.parentAgentId) {
    const parentRecord = store.getAgentRecord(agentRecord.parentAgentId);
    if (parentRecord?.conversationId === agentRecord.conversationId) {
      const parentRows = store.loadThreadMessages(agentRecord.parentAgentId);
      const successfulCalls = new Map();
      for (const row of parentRows) {
        const payload = row.payload;
        if (
          payload?.role !== "toolResult" ||
          payload.isError ||
          (payload.toolName !== "spawn_agent" &&
            payload.toolName !== "send_input")
        ) {
          continue;
        }
        const text = payload.content
          .flatMap((block) =>
            block.type === "text" && block.text.trim() ? [block.text] : [],
          )
          .join("\n");
        try {
          const result = JSON.parse(text);
          if (result.thread_id === threadId) {
            successfulCalls.set(payload.toolCallId, payload.toolName);
          }
        } catch {
          // Only structured successful results prove exact child ownership.
        }
      }
      for (const row of parentRows) {
        if (row.payload?.role !== "assistant") continue;
        for (const [index, block] of row.payload.content.entries()) {
          if (block.type !== "toolCall") continue;
          const toolName = successfulCalls.get(block.id);
          if (!toolName || toolName !== block.name) continue;
          const content =
            toolName === "spawn_agent"
              ? typeof block.arguments.prompt === "string"
                ? truncateForDisplay(
                    block.arguments.prompt,
                    TOOL_OUTPUT_DISPLAY_MAX_CHARS,
                  )
                : ""
              : block.arguments.thread_id === threadId &&
                  typeof block.arguments.message === "string"
                ? truncateForDisplay(
                    block.arguments.message,
                    TOOL_OUTPUT_DISPLAY_MAX_CHARS,
                  )
                : "";
          const key = `user\0${content}`;
          if (!content || authored.has(key)) continue;
          authored.add(key);
          projected.push({
            entryId: `${row.entryId ?? block.id}:recovered-input:${index}`,
            timestamp: row.timestamp,
            role: "user",
            content,
          });
        }
      }
    }
  }
  if (agentRecord?.result?.trim()) {
    const content = truncateForDisplay(
      agentRecord.result,
      TOOL_OUTPUT_DISPLAY_MAX_CHARS,
    );
    const key = `assistant\0${content}`;
    if (!authored.has(key)) {
      projected.push({
        entryId: `${threadId}:durable-final-result`,
        timestamp: agentRecord.completedAt ?? agentRecord.updatedAt,
        role: "assistant",
        content,
      });
    }
  }
  const seenLifecycleIds = new Set(
    projected.flatMap((message) =>
      message.role === "lifecycle" && message.lifecycleEvent
        ? [message.lifecycleEvent._id]
        : [],
    ),
  );
  for (const entry of store.listThreadLifecycleEntries(threadId, limit)) {
    if (seenLifecycleIds.has(entry.event._id)) continue;
    seenLifecycleIds.add(entry.event._id);
    projected.push({
      entryId: entry.entryId,
      timestamp: entry.event.timestamp,
      role: "lifecycle",
      content: "",
      lifecycleEvent: entry.event,
    });
  }
  // Array.sort is stable: equal timestamps retain durable append order from
  // each source instead of being scrambled by opaque entry IDs.
  return projected.sort((a, b) => a.timestamp - b.timestamp);
};
