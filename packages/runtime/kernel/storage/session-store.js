import {
  MAX_ACTIVE_RUNTIME_THREADS,
  normalizeRuntimeThreadId,
} from "../runtime-threads.js";
import { slugify } from "../shared/slug.js";
import {
  DEFAULT_CONVERSATION_SETTING_KEY,
  MAX_EVENTS_PER_CONVERSATION,
  RUNTIME_THREAD_SESSION_VERSION,
  asFiniteNumber,
  asObject,
  asTrimmedString,
  eventTextFromPayload,
  generateLocalId,
  isUserContent,
  parseJsonRecord,
  parseRuntimeThreadPayload,
  toJsonString,
  toJsonValueString,
} from "./shared.js";
import { isUiHiddenChatMessagePayload } from "@stella/contracts/chat-event-visibility";
import { normalizeRetiredAgentType } from "@stella/contracts/agent-runtime";
import { DreamInboxStore } from "../memory/dream-inbox-store.js";
import {
  CONTEXT_DELTA_CUSTOM_TYPE_PREFIX,
  RESIDENT_FOLD_ENTRY_ID_MARKER,
  parseResidentFold,
  residentIdentityForCustomMessage,
} from "../agent-runtime/resident-context.js";
/**
 * Upper bound on the user/assistant rows scanned per `listMessages` /
 * `listMessagesBefore` call to compute the visible-message cutoff. Lets
 * the scan absorb hundreds of hidden system reminders / workspace
 * requests near the tail without scanning every row in chats with
 * millions of historical events.
 */
const CUTOFF_SCAN_CEILING = 4000;
const CUTOFF_SCAN_BATCH_MIN = 128;
const CUTOFF_SCAN_BATCH_MAX = 512;
const compareTimelineCursor = (a, b) => {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id.localeCompare(b.id);
};
/** Hard storage/transport envelope for authored Activity updates. */
export const AGENT_ASSISTANT_UPDATE_LIMITS = {
  activeThreads: 16,
  messagesPerThread: 3,
  messageChars: 1200,
  messageBytes: 4096,
  threadChars: 3600,
  threadBytes: 12288,
  totalChars: 7200,
  totalBytes: 16384,
  scanRowsPerMessage: 8,
};
export class FtsSearchUnavailableError extends Error {
  index;
  name = "FtsSearchUnavailableError";
  constructor(index, message, options) {
    super(message, options);
    this.index = index;
  }
}
const throwFtsSearchUnavailable = (index, reason, cause) => {
  console.error(
    "[stella:recall:fts-degraded]",
    JSON.stringify({ index, reason }),
  );
  throw new FtsSearchUnavailableError(
    index,
    `Recall ${index} FTS unavailable: ${reason}`,
    cause === undefined ? undefined : { cause },
  );
};
const parseJsonValue = (value) => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
const eventRoleForType = (type) => {
  switch (type) {
    case "user_message":
      return "user";
    case "assistant_message":
      return "assistant";
    case "tool_request":
    case "tool_result":
      return "tool";
    default:
      return "system";
  }
};
const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";
// Hard cap on the text returned per transcript-search hit; the recall
// formatter windows it further around the first match.
const TRANSCRIPT_SEARCH_TEXT_CAP = 4_000;
// Step-1 candidate cap for the FTS-backed thread search. Generous (the
// result limit tops out at 25) so ordering parity with the LIKE scan is
// preserved in practice; `ORDER BY rank` keeps the most relevant candidates
// on the rare query where the cap binds.
const THREAD_SEARCH_FTS_CANDIDATE_CAP = 200;
// SQL-side truncation for the index's result/error excerpts: real final
// results average ~4k chars, so untruncated excerpts would multiply the
// index size ~10x for no identification gain.
const RECALL_INDEX_RESULT_EXCERPT_CHARS = 400;
const RECALL_INDEX_ERROR_EXCERPT_CHARS = 300;
// English function words dropped from search queries before matching.
// Under OR-with-ranking semantics a stray stopword can never exclude a
// result, only pad the 6-token budget and inflate scores with rows that
// merely contain "the" — so the list errs toward inclusion.
const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "by",
  "about",
  "into",
  "over",
  "after",
  "before",
  "during",
  "between",
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "doing",
  "have",
  "has",
  "had",
  "having",
  "will",
  "would",
  "can",
  "could",
  "should",
  "shall",
  "may",
  "might",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "it",
  "its",
  "they",
  "them",
  "their",
  "he",
  "him",
  "his",
  "she",
  "her",
  "that",
  "this",
  "these",
  "those",
  "there",
  "here",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "not",
  "no",
  "so",
  "if",
  "then",
  "than",
  "too",
  "very",
  "just",
  "also",
  "any",
  "some",
  "thing",
  "stuff",
  "one",
  "ago",
  "last",
  "recent",
]);
/**
 * Shared tokenizer for the OR-with-ranking searches (`searchThreads`,
 * `searchTranscripts`) and the recall formatter that scores their merged
 * results: whitespace split, stopwords dropped — unless the query is ALL
 * stopwords, which still searches with what it has rather than silently
 * degrading into a recency dump — capped at 12 tokens. The cap was 6, but
 * recall queries routinely enumerate candidates ("was it Apache Trail,
 * Tortilla Flat, Bush Highway/Saguaro Lake?") and truncating at 6 cut
 * exactly the tokens the right transcript rows contained.
 */
export const tokenizeSearchQuery = (query) => {
  const rawTokens = (query ?? "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const meaningful = rawTokens.filter(
    (token) => !SEARCH_STOPWORDS.has(token.toLowerCase()),
  );
  return (meaningful.length > 0 ? meaningful : rawTokens).slice(0, 12);
};
const toIsoTimestamp = (timestamp) => new Date(timestamp).toISOString();
const formatThreadCheckpointMessage = (summary) =>
  [THREAD_CHECKPOINT_MARKER, "", summary.trim()].join("\n");
const previewFromTextAndImages = (content) => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) =>
      block.type === "text" ? block.text : `[Image: ${block.mimeType}]`,
    )
    .join("\n")
    .trim();
};
const previewFromAssistantPayload = (payload) =>
  payload.content
    .flatMap((block) => {
      if (block.type === "text") {
        return block.text.trim() ? [block.text] : [];
      }
      if (block.type === "toolCall") {
        return [
          `[Tool call] ${block.name}\nargs: ${JSON.stringify(block.arguments ?? {})}`,
        ];
      }
      return [];
    })
    .join("\n\n")
    .trim();
const authoredTextFromAssistantPayload = (payload) =>
  payload.content
    .flatMap((block) =>
      block.type === "text" && block.text.trim() ? [block.text] : [],
    )
    .join("\n\n")
    .trim();
const truncateAuthoredUpdate = (
  value,
  maxChars = AGENT_ASSISTANT_UPDATE_LIMITS.messageChars,
  maxBytes = AGENT_ASSISTANT_UPDATE_LIMITS.messageBytes,
) => {
  const codePoints = [...value.trim()];
  let end = Math.min(codePoints.length, Math.max(0, maxChars));
  while (end > 0) {
    const candidate = codePoints.slice(0, end).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
    end -= 1;
  }
  return "";
};
const previewFromPayload = (payload) => {
  if (payload.role === "assistant") {
    return previewFromAssistantPayload(payload);
  }
  if (payload.role === "toolResult") {
    const body = previewFromTextAndImages(payload.content);
    return [`[Tool result] ${payload.toolName}`, ...(body ? [body] : [])]
      .join("\n")
      .trim();
  }
  return previewFromTextAndImages(payload.content);
};
const buildFallbackThreadPayload = (message) => {
  if (message.payload) {
    return message.payload;
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content:
        message.content.trim().length > 0
          ? [{ type: "text", text: message.content }]
          : [],
      api: "openai-completions",
      provider: "stella",
      model: "history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId ?? "",
      toolName: "tool",
      content:
        message.content.trim().length > 0
          ? [{ type: "text", text: message.content }]
          : [],
      isError: false,
      timestamp: message.timestamp,
    };
  }
  return {
    role: "user",
    content: message.content,
    timestamp: message.timestamp,
  };
};
const rowSizeTextEncoder = new TextEncoder();
// Tool results that include a screenshot (vision content block) routinely
// run 1–2 MB once the PNG is base64-encoded — that's a normal payload, not
// pathological. The previous 1.8 MB cap was below that threshold, so every
// computer-use snapshot result with an inline screenshot got dropped
// to a "too large to persist" placeholder, breaking the agent's context for
// the very next turn. SQLite handles multi-MB rows fine; bump high enough
// to fit a screenshot + element tree comfortably.
const THREAD_ROW_MAX_BYTES = 6_000_000;
const THREAD_ROW_MAX_TEXT_CHARS = 1_000;
const THREAD_ROW_PREVIEW_CHARS = 500;
const payloadByteLength = (payload) =>
  rowSizeTextEncoder.encode(JSON.stringify(payload)).byteLength;
const customMessageByteLength = (message) =>
  rowSizeTextEncoder.encode(JSON.stringify(message)).byteLength;
const truncatePreview = (value, maxChars = THREAD_ROW_PREVIEW_CHARS) =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
const truncateTextBlockForStorage = (text, label = "Text") =>
  `[${label} truncated for storage (${text.length} chars). First ${Math.min(text.length, THREAD_ROW_PREVIEW_CHARS)} chars: ${truncatePreview(text)}]`;
const truncateToolOutputForStorage = (text) =>
  `This tool output was too large to persist in storage (${text.length} chars). If the user asks about this data, suggest re-running the tool. Preview: ${truncatePreview(text)}`;
const strippedImageStorageNote = (image) => {
  const sourcePath = image.sourcePath?.trim();
  if (sourcePath) {
    return {
      type: "text",
      text: `<image_reference>\n${sourcePath}\nUse the Read tool with file_path set to this absolute path to inspect the image.\n</image_reference>`,
    };
  }
  const sizeKb = Math.round(((image.data?.length ?? 0) * 0.75) / 1024);
  return {
    type: "text",
    text: `[image content block stripped for storage: mime=${image.mimeType ?? "image/png"} approx_kb=${sizeKb}]`,
  };
};
const truncateObjectForStorage = (value, label) => {
  const json = JSON.stringify(value);
  return {
    __truncated: `${label} truncated for storage (${json.length} chars). Preview: ${truncatePreview(json)}`,
  };
};
const enforceThreadPayloadRowSizeLimit = (payload) => {
  if (payloadByteLength(payload) <= THREAD_ROW_MAX_BYTES) {
    return payload;
  }
  if (payload.role === "user") {
    const content =
      typeof payload.content === "string"
        ? truncateTextBlockForStorage(payload.content, "User content")
        : payload.content.map((block) =>
            block.type === "text" &&
            block.text.length > THREAD_ROW_MAX_TEXT_CHARS
              ? {
                  ...block,
                  text: truncateTextBlockForStorage(block.text, "User content"),
                }
              : block,
          );
    const candidate = { ...payload, content };
    if (payloadByteLength(candidate) <= THREAD_ROW_MAX_BYTES) {
      return candidate;
    }
    if (typeof content !== "string") {
      const withoutImageData = {
        ...payload,
        content: content.map((block) =>
          block.type === "image" ? strippedImageStorageNote(block) : block,
        ),
      };
      if (payloadByteLength(withoutImageData) <= THREAD_ROW_MAX_BYTES) {
        return withoutImageData;
      }
    }
    return {
      ...payload,
      content:
        typeof payload.content === "string"
          ? truncateTextBlockForStorage(payload.content, "User content")
          : [
              {
                type: "text",
                text: truncateTextBlockForStorage(
                  JSON.stringify(payload.content),
                  "User content",
                ),
              },
            ],
    };
  }
  if (payload.role === "assistant") {
    const compacted = {
      ...payload,
      content: payload.content.map((block) => {
        if (
          block.type === "text" &&
          block.text.length > THREAD_ROW_MAX_TEXT_CHARS
        ) {
          return { ...block, text: truncateTextBlockForStorage(block.text) };
        }
        if (
          block.type === "thinking" &&
          block.thinking.length > THREAD_ROW_MAX_TEXT_CHARS
        ) {
          return {
            ...block,
            thinking: truncateTextBlockForStorage(block.thinking, "Reasoning"),
          };
        }
        if (block.type === "toolCall") {
          const argsJson = JSON.stringify(block.arguments ?? {});
          if (argsJson.length > THREAD_ROW_MAX_TEXT_CHARS) {
            return {
              ...block,
              arguments: truncateObjectForStorage(
                block.arguments ?? {},
                `${block.name} arguments`,
              ),
            };
          }
        }
        return block;
      }),
    };
    if (payloadByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
      return compacted;
    }
    return {
      ...payload,
      content: [
        {
          type: "text",
          text: truncateTextBlockForStorage(
            JSON.stringify(payload.content),
            "Assistant message",
          ),
        },
      ],
    };
  }
  const compacted = {
    ...payload,
    content: payload.content.map((block) =>
      block.type === "text" && block.text.length > THREAD_ROW_MAX_TEXT_CHARS
        ? { ...block, text: truncateToolOutputForStorage(block.text) }
        : block,
    ),
  };
  if (payloadByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
    return compacted;
  }
  // Still too big — almost always because an inline image (vision content
  // block) ballooned the row. Drop the base64 payload of every image and
  // leave a small text breadcrumb in its place so the rest of the result
  // (and any other text blocks the model still needs) survives.
  const withoutImageData = {
    ...compacted,
    content: compacted.content.map((block) => {
      if (block.type !== "image") {
        return block;
      }
      return strippedImageStorageNote(block);
    }),
  };
  if (payloadByteLength(withoutImageData) <= THREAD_ROW_MAX_BYTES) {
    return withoutImageData;
  }
  return {
    ...payload,
    content: [
      {
        type: "text",
        text: truncateToolOutputForStorage(JSON.stringify(payload.content)),
      },
    ],
  };
};
const enforceCustomMessageRowSizeLimit = (message) => {
  if (customMessageByteLength(message) <= THREAD_ROW_MAX_BYTES) {
    return message;
  }
  const content =
    typeof message.content === "string"
      ? truncateTextBlockForStorage(message.content, "Custom message")
      : message.content.map((block) => {
          if (
            block.type === "text" &&
            block.text.length > THREAD_ROW_MAX_TEXT_CHARS
          ) {
            return {
              ...block,
              text: truncateTextBlockForStorage(block.text, "Custom message"),
            };
          }
          return block;
        });
  const compacted = {
    ...message,
    content,
  };
  if (customMessageByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
    return compacted;
  }
  const withoutImageData = {
    ...compacted,
    content:
      typeof compacted.content === "string"
        ? compacted.content
        : compacted.content.map((block) => {
            if (block.type !== "image") {
              return block;
            }
            const sizeKb = Math.round(
              ((block.data?.length ?? 0) * 0.75) / 1024,
            );
            return {
              type: "text",
              text: `[image content block stripped for storage: mime=${block.mimeType ?? "image/png"} approx_kb=${sizeKb}]`,
            };
          }),
  };
  if (customMessageByteLength(withoutImageData) <= THREAD_ROW_MAX_BYTES) {
    return withoutImageData;
  }
  return {
    ...message,
    content:
      typeof message.content === "string"
        ? truncateTextBlockForStorage(message.content, "Custom message")
        : [
            {
              type: "text",
              text: truncateTextBlockForStorage(
                JSON.stringify(message.content),
                "Custom message",
              ),
            },
          ],
  };
};
const THREAD_LIFECYCLE_EVENT_TYPES = new Set([
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
]);
const parseStoredThreadLifecycleEvent = (value) => {
  const record = asObject(value);
  const id = asTrimmedString(record?._id);
  const type = asTrimmedString(record?.type);
  const timestamp = asFiniteNumber(record?.timestamp);
  if (
    !id ||
    !type ||
    !THREAD_LIFECYCLE_EVENT_TYPES.has(type) ||
    timestamp === null
  ) {
    return null;
  }
  const payload = asObject(record?.payload);
  return {
    _id: id,
    timestamp,
    type,
    ...(payload ? { payload } : {}),
  };
};
const parseThreadSessionEntry = (row) => {
  const data = parseJsonValue(row.dataJson);
  switch (row.entryType) {
    case "message": {
      const rawMessage =
        data && "message" in data
          ? parseRuntimeThreadPayload(JSON.stringify(data.message))
          : undefined;
      if (!rawMessage) {
        return null;
      }
      return {
        type: "message",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        message: rawMessage,
      };
    }
    case "compaction": {
      const summary =
        typeof data?.summary === "string" ? data.summary.trim() : "";
      const fromEntryId =
        typeof data?.fromEntryId === "string" ? data.fromEntryId.trim() : "";
      const toEntryId =
        typeof data?.toEntryId === "string" ? data.toEntryId.trim() : "";
      const firstKeptEntryId =
        typeof data?.firstKeptEntryId === "string"
          ? data.firstKeptEntryId.trim()
          : "";
      const tokensBefore =
        typeof data?.tokensBefore === "number" &&
        Number.isFinite(data.tokensBefore)
          ? data.tokensBefore
          : 0;
      if (!summary || (!(fromEntryId && toEntryId) && !firstKeptEntryId)) {
        return null;
      }
      return {
        type: "compaction",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        summary,
        ...(fromEntryId && toEntryId ? { fromEntryId, toEntryId } : {}),
        ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
        tokensBefore,
        ...(data && "details" in data ? { details: data.details } : {}),
        ...(data?.fromHook === true ? { fromHook: true } : {}),
      };
    }
    case "custom_message": {
      const customType =
        typeof data?.customType === "string" ? data.customType.trim() : "";
      const content = data?.content;
      const display = data?.display === true;
      const eventId =
        typeof data?.eventId === "string" && data.eventId.trim()
          ? data.eventId.trim()
          : undefined;
      if (!customType || !isUserContent(content)) {
        return null;
      }
      return {
        type: "custom_message",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        customType,
        content,
        display,
        ...(eventId ? { eventId } : {}),
      };
    }
    case "lifecycle_event": {
      const event = parseStoredThreadLifecycleEvent(data?.event);
      if (!event) return null;
      return {
        type: "lifecycle_event",
        id: row.entryId,
        parentId: row.parentEntryId,
        timestamp: row.timestampIso,
        event,
      };
    }
    default:
      return null;
  }
};
const toThreadMessageRecord = (entry) => {
  if (entry.type === "message") {
    const payload = entry.message;
    return {
      entryId: entry.id,
      threadKey: "",
      timestamp: payload.timestamp,
      role: payload.role,
      content: previewFromPayload(payload),
      ...(payload.role === "toolResult"
        ? { toolCallId: payload.toolCallId }
        : {}),
      payload,
    };
  }
  if (entry.type === "custom_message") {
    return {
      entryId: entry.id,
      threadKey: "",
      timestamp: Date.parse(entry.timestamp) || Date.now(),
      role: "runtimeInternal",
      content: previewFromTextAndImages(entry.content),
      customMessage: {
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        ...(entry.eventId ? { eventId: entry.eventId } : {}),
      },
    };
  }
  return null;
};
const buildThreadPathEntries = (entries) => {
  if (entries.length === 0) {
    return [];
  }
  const byId = new Map();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }
  let leaf = entries[entries.length - 1];
  const reversePath = [];
  const visited = new Set();
  while (leaf) {
    // Malformed imported history must not hang reconstruction. Falling back
    // to the durable insertion order also retains every legitimate legacy
    // sibling created by the former same-millisecond parent race.
    if (visited.has(leaf.id)) return entries;
    visited.add(leaf.id);
    reversePath.push(leaf);
    leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
  }
  if (reversePath.length !== entries.length) return entries;
  return reversePath.reverse();
};
const buildRawThreadMessages = (path) =>
  path
    .map((entry) => toThreadMessageRecord(entry))
    .filter((message) => message !== null);
const normalizeCompactionOverlay = (compaction, rawMessages) => {
  const timestamp = Date.parse(compaction.timestamp) || Date.now();
  const residentFold = parseResidentFold(compaction.details);
  if (compaction.fromEntryId && compaction.toEntryId) {
    return {
      id: compaction.id,
      summary: compaction.summary,
      fromEntryId: compaction.fromEntryId,
      toEntryId: compaction.toEntryId,
      timestamp,
      ...(residentFold ? { residentFold } : {}),
    };
  }
  if (!compaction.firstKeptEntryId) {
    return null;
  }
  const firstKeptIndex = rawMessages.findIndex(
    (message) => message.entryId === compaction.firstKeptEntryId,
  );
  if (firstKeptIndex <= 0) {
    return null;
  }
  const fromEntryId = rawMessages[0]?.entryId;
  const toEntryId = rawMessages[firstKeptIndex - 1]?.entryId;
  if (!fromEntryId || !toEntryId) {
    return null;
  }
  return {
    id: compaction.id,
    summary: compaction.summary,
    fromEntryId,
    toEntryId,
    timestamp,
    ...(residentFold ? { residentFold } : {}),
  };
};
const buildThreadCompactionOverlays = (path, rawMessages) =>
  path
    .filter((entry) => entry.type === "compaction")
    .map((entry) => normalizeCompactionOverlay(entry, rawMessages))
    .filter((entry) => entry !== null);
/**
 * Resident-block fold-in half of the overlay application. The newest applied
 * overlay that carries a `residentFold` (written by `maybeCompactRuntimeThread`)
 * re-establishes the canonical resident context:
 *
 *   1. every older copy of a folded block (stale head docs, mid-thread
 *      re-appends that survived in the kept tail) and every accumulated
 *      `runtime.context_delta.*` notice from before the compaction is
 *      dropped from the materialized window;
 *   2. exactly one fresh copy of each folded block is emitted immediately
 *      before that overlay's checkpoint message — i.e. at the head of the
 *      rebuilt window, where compaction head-protection keeps it pinned.
 *
 * Copies appended AFTER the compaction (timestamp > overlay timestamp) are
 * genuine new deltas and are left in place. Purely derived from persisted
 * entries, so every store rebuild materializes the same canonical window.
 */
const applyResidentFold = (messages, overlay) => {
  const fold = overlay.residentFold;
  const checkpointIndex = messages.findIndex(
    (message) => message.entryId === overlay.id,
  );
  if (checkpointIndex < 0) {
    return messages;
  }
  const swept = messages.filter((message) => {
    if (message.role !== "runtimeInternal" || !message.customMessage) {
      return true;
    }
    if (message.timestamp > overlay.timestamp) {
      return true;
    }
    const customType = message.customMessage.customType;
    if (
      typeof customType === "string" &&
      customType.startsWith(CONTEXT_DELTA_CUSTOM_TYPE_PREFIX)
    ) {
      return false;
    }
    const identity = residentIdentityForCustomMessage(message.customMessage);
    return !(identity && fold.identities.has(identity));
  });
  const insertIndex = swept.findIndex(
    (message) => message.entryId === overlay.id,
  );
  if (insertIndex < 0) {
    return swept;
  }
  const docMessages = fold.docs.map((doc, docIndex) => ({
    entryId: `${overlay.id}${RESIDENT_FOLD_ENTRY_ID_MARKER}${docIndex}`,
    threadKey: "",
    timestamp: overlay.timestamp,
    role: "runtimeInternal",
    content: previewFromTextAndImages([{ type: "text", text: doc.text }]),
    customMessage: {
      customType: doc.customType,
      content: [{ type: "text", text: doc.text }],
      display: false,
    },
  }));
  swept.splice(insertIndex, 0, ...docMessages);
  return swept;
};
const applyCompactionOverlays = (rawMessages, overlays) => {
  if (rawMessages.length === 0 || overlays.length === 0) {
    return rawMessages;
  }
  const ids = rawMessages.map((message) => message.entryId);
  let result = [];
  const appliedOverlays = [];
  let index = 0;
  while (index < rawMessages.length) {
    const matching = overlays.filter(
      (overlay) => overlay.fromEntryId === ids[index],
    );
    const overlay =
      matching.length > 1 ? matching[matching.length - 1] : matching[0];
    if (overlay) {
      const endIndex = ids.indexOf(overlay.toEntryId);
      if (endIndex >= index) {
        appliedOverlays.push(overlay);
        result.push({
          entryId: overlay.id,
          threadKey: "",
          timestamp: overlay.timestamp,
          role: "assistant",
          content: formatThreadCheckpointMessage(overlay.summary),
        });
        index = endIndex + 1;
        continue;
      }
    }
    result.push(rawMessages[index]);
    index += 1;
  }
  const foldOverlay = appliedOverlays
    .filter((overlay) => overlay.residentFold)
    .pop();
  if (foldOverlay) {
    result = applyResidentFold(result, foldOverlay);
  }
  return result;
};
const buildThreadMessagesFromEntries = (entries) => {
  const path = buildThreadPathEntries(entries);
  const rawMessages = buildRawThreadMessages(path);
  const overlays = buildThreadCompactionOverlays(path, rawMessages);
  return applyCompactionOverlays(rawMessages, overlays);
};
export class SessionStore {
  db;
  options;
  dreamInboxStoreInstance = null;
  constructor(db, options = {}) {
    this.db = db;
    this.options = options;
  }
  /**
   * Lazily-constructed singleton DreamInboxStore — the unified queue of
   * everything Dream consolidates: subagent rollout summaries, orchestrator
   * memory-review notes.
   */
  get dreamInboxStore() {
    if (!this.dreamInboxStoreInstance) {
      this.dreamInboxStoreInstance = new DreamInboxStore(this.db);
    }
    return this.dreamInboxStoreInstance;
  }
  withTransaction(work) {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      work();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
  /** Reserve the WAL writer before a read-then-write decision. */
  withImmediateTransaction(work) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      work();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
  getSetting(key) {
    const row = this.db
      .prepare(
        `
      SELECT value
      FROM settings
      WHERE key = ?
    `,
      )
      .get(key);
    return typeof row?.value === "string" && row.value.length > 0
      ? row.value
      : null;
  }
  setSetting(key, value) {
    this.db
      .prepare(
        `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
      )
      .run(key, value, Date.now());
  }
  sanitizeConversationId(value) {
    const conversationId = asTrimmedString(value);
    if (!conversationId) {
      throw new Error("conversationId is required.");
    }
    return conversationId;
  }
  upsertSession(sessionId, updatedAt) {
    this.db
      .prepare(
        `
      INSERT INTO session (
        id,
        title,
        status,
        created_at,
        updated_at
      )
      VALUES (?, '', 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = CASE
          WHEN excluded.updated_at > updated_at THEN excluded.updated_at
          ELSE updated_at
        END
    `,
      )
      .run(sessionId, updatedAt, updatedAt);
  }
  getSession(sessionId) {
    const row = this.db
      .prepare(
        `
      SELECT
        id,
        sync_checkpoint_message_id AS syncCheckpointMessageId
      FROM session
      WHERE id = ?
      LIMIT 1
    `,
      )
      .get(sessionId);
    return row ?? null;
  }
  deriveImplicitThreadMetadata(threadKey) {
    const subagentMarker = "::subagent::";
    const subagentIndex = threadKey.indexOf(subagentMarker);
    if (subagentIndex > 0) {
      const conversationId = threadKey.slice(0, subagentIndex).trim();
      const remainder = threadKey.slice(subagentIndex + subagentMarker.length);
      const nextDelimiter = remainder.indexOf("::");
      const agentType =
        nextDelimiter > 0
          ? remainder.slice(0, nextDelimiter).trim()
          : "subagent";
      if (conversationId) {
        return {
          conversationId,
          agentType: agentType || "subagent",
        };
      }
    }
    return {
      conversationId: threadKey,
      agentType: "orchestrator",
    };
  }
  ensureImplicitThreadRow(threadKey) {
    const derived = this.deriveImplicitThreadMetadata(threadKey);
    const now = Date.now();
    this.upsertSession(derived.conversationId, now);
    this.db
      .prepare(
        `
      INSERT INTO runtime_threads (
        thread_key,
        conversation_id,
        agent_type,
        name,
        status,
        created_at,
        last_used_at,
        summary
      )
      VALUES (?, ?, ?, ?, 'evicted', ?, ?, NULL)
      ON CONFLICT(thread_key) DO NOTHING
    `,
      )
      .run(
        threadKey,
        derived.conversationId,
        derived.agentType,
        threadKey,
        now,
        now,
      );
    return derived;
  }
  replaceMessageParts(messageId, sessionId, parts) {
    this.db
      .prepare(
        `
      DELETE FROM part
      WHERE message_id = ?
    `,
      )
      .run(messageId);
    const stmt = this.db.prepare(`
      INSERT INTO part (
        id,
        session_id,
        message_id,
        ord,
        type,
        tool_call_id,
        data_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    parts.forEach((part, index) => {
      stmt.run(
        `${messageId}:part:${index}`,
        sessionId,
        messageId,
        index,
        part.type,
        part.toolCallId ?? null,
        toJsonValueString(part.data),
        part.createdAt,
      );
    });
  }
  upsertEventMessage(args) {
    this.db
      .prepare(
        `
      INSERT INTO message (
        id,
        session_id,
        thread_key,
        run_id,
        role,
        type,
        request_id,
        device_id,
        target_device_id,
        agent_type,
        data_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        role = excluded.role,
        type = excluded.type,
        request_id = excluded.request_id,
        device_id = excluded.device_id,
        target_device_id = excluded.target_device_id,
        data_json = excluded.data_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        args.eventId,
        args.sessionId,
        eventRoleForType(args.type),
        args.type,
        args.requestId ?? null,
        args.deviceId ?? null,
        args.targetDeviceId ?? null,
        toJsonString(
          args.channelEnvelope
            ? { channelEnvelope: args.channelEnvelope }
            : undefined,
        ),
        args.timestamp,
        args.timestamp,
      );
    this.replaceMessageParts(
      args.eventId,
      args.sessionId,
      args.payload
        ? [
            {
              type: "payload",
              data: args.payload,
              createdAt: args.timestamp,
            },
          ]
        : [],
    );
  }
  deserializeEventRow(row) {
    const meta = parseJsonRecord(row.channelEnvelopeJson);
    return {
      _id: row._id,
      timestamp: row.timestamp,
      type: row.type,
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(row.targetDeviceId ? { targetDeviceId: row.targetDeviceId } : {}),
      ...(parseJsonRecord(row.payloadJson)
        ? { payload: parseJsonRecord(row.payloadJson) }
        : {}),
      ...(asObject(meta?.channelEnvelope)
        ? { channelEnvelope: asObject(meta?.channelEnvelope) }
        : {}),
    };
  }
  appendEvent(args) {
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const type = asTrimmedString(args.type);
    if (!type) {
      throw new Error("type is required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const eventId =
      asTrimmedString(args.eventId) || `local-${generateLocalId()}`;
    const payload = asObject(args.payload) ?? undefined;
    const channelEnvelope = asObject(args.channelEnvelope) ?? undefined;
    const deviceId = asTrimmedString(args.deviceId) || undefined;
    const requestId = asTrimmedString(args.requestId) || undefined;
    const targetDeviceId = asTrimmedString(args.targetDeviceId) || undefined;
    this.withTransaction(() => {
      this.upsertSession(conversationId, timestamp);
      this.upsertEventMessage({
        sessionId: conversationId,
        eventId,
        type,
        timestamp,
        deviceId,
        requestId,
        targetDeviceId,
        payload,
        channelEnvelope,
      });
    });
    return {
      _id: eventId,
      timestamp,
      type,
      ...(deviceId ? { deviceId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(targetDeviceId ? { targetDeviceId } : {}),
      ...(payload ? { payload } : {}),
      ...(channelEnvelope ? { channelEnvelope } : {}),
    };
  }
  hasEvent(conversationIdInput, eventIdInput, typeInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return false;
    const type = asTrimmedString(typeInput);
    const row = this.db
      .prepare(
        type
          ? `SELECT 1 AS present FROM message
             WHERE session_id = ? AND id = ? AND type = ? LIMIT 1`
          : `SELECT 1 AS present FROM message
             WHERE session_id = ? AND id = ? LIMIT 1`,
      )
      .get(
        ...(type ? [conversationId, eventId, type] : [conversationId, eventId]),
      );
    return Boolean(row);
  }
  hasEventId(eventIdInput, typeInput) {
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return false;
    const type = asTrimmedString(typeInput);
    const statement = this.db.prepare(
      type
        ? `SELECT 1 AS present FROM message WHERE id = ? AND type = ? LIMIT 1`
        : `SELECT 1 AS present FROM message WHERE id = ? LIMIT 1`,
    );
    return Boolean(
      type ? statement.get(eventId, type) : statement.get(eventId),
    );
  }
  /**
   * Shallow-merge a partial payload into an existing local-chat event's
   * stored payload. Returns the updated record (so callers can fire
   * `notifyLocalChatUpdated`), or null when the event/payload row is
   * missing. Used by the worker to attach post-run fields after the run finalizes.
   *
   * Atomicity: the SELECT, merge, and write all run inside a single
   * `withTransaction` block so a concurrent writer to the same eventId
   * can't slip a write between the read and the merge.
   *
   * Caveat: the write replaces every `part` row for the message via
   * `replaceMessageParts`, then re-inserts a single merged payload at
   * `ord: 0`. Today every chat event only stores its payload at ord 0,
   * but a future feature adding multi-part chat events would have its
   * non-ord:0 parts wiped by a subsequent `mergeEventPayload` call.
   * If that becomes a concern, switch to a part-level merge instead of
   * full replacement. The transaction below logs a tripwire warning
   * when it observes more than one existing part row for the target
   * message so we notice the moment a multi-part event type lands.
   */
  mergeEventPayload(args) {
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const eventId = asTrimmedString(args.eventId);
    if (!eventId) {
      return null;
    }
    let updatedRecord = null;
    this.withTransaction(() => {
      const existingRow = this.db
        .prepare(
          `
          SELECT
            message.id AS _id,
            message.created_at AS timestamp,
            message.type AS type,
            message.device_id AS deviceId,
            message.request_id AS requestId,
            message.target_device_id AS targetDeviceId,
            part.data_json AS payloadJson,
            message.data_json AS channelEnvelopeJson
          FROM message
          LEFT JOIN part
            ON part.message_id = message.id
           AND part.ord = 0
          WHERE message.id = ?
            AND message.session_id = ?
        `,
        )
        .get(eventId, conversationId);
      if (!existingRow) {
        return;
      }
      // Tripwire: see JSDoc caveat. `replaceMessageParts` below is
      // destructive across all ords for this message id; if we ever
      // see >1 part row pre-merge it means a multi-part event type
      // has landed and this method silently dropped sibling parts.
      const existingPartCount =
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM part WHERE message_id = ?`)
          .get(eventId)?.n ?? 0;
      if (existingPartCount > 1) {
        console.warn(
          `[session-store] mergeEventPayload destructively replaced ${existingPartCount} parts for event ${eventId} (conversation ${conversationId}); only ord:0 will survive. A multi-part event type now exists — switch this method to a part-level merge.`,
        );
      }
      const existingPayload = parseJsonRecord(existingRow.payloadJson) ?? {};
      const mergedPayload = {
        ...existingPayload,
        ...args.patch,
      };
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE message SET updated_at = ? WHERE id = ? AND session_id = ?`,
        )
        .run(now, eventId, conversationId);
      this.replaceMessageParts(eventId, conversationId, [
        {
          type: "payload",
          data: mergedPayload,
          createdAt: existingRow.timestamp,
        },
      ]);
      updatedRecord = {
        ...this.deserializeEventRow(existingRow),
        payload: mergedPayload,
      };
    });
    return updatedRecord;
  }
  getOrCreateDefaultConversationId() {
    const existing = this.getSetting(DEFAULT_CONVERSATION_SETTING_KEY);
    if (existing) {
      this.upsertSession(existing, Date.now());
      return existing;
    }
    const created = generateLocalId();
    const createdAt = Date.now();
    this.withTransaction(() => {
      this.upsertSession(created, createdAt);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, created);
    });
    return created;
  }
  createNewDefaultConversationId() {
    let resolvedConversationId = "";
    this.withImmediateTransaction(() => {
      const activeConversationId = this.getSetting(
        DEFAULT_CONVERSATION_SETTING_KEY,
      );
      // "Empty" follows the durable UI-visibility contract: every
      // displayable user/assistant row occupies a chat, including an
      // attachment/context-only or malformed row with no title text.
      // Hidden workspace triggers and system/tool-only rows do not. A
      // conversation that has owned an agent is also excluded so a
      // task-only thread is never repurposed as a blank user chat.
      const reusable = this.db
        .prepare(
          `
          SELECT candidate.id
          FROM session AS candidate
          WHERE candidate.status = 'active'
            AND length(candidate.id) = 26
            AND candidate.id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
            AND NOT EXISTS (
              SELECT 1
              FROM runtime_agents AS agent
              WHERE agent.conversation_id = candidate.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM message AS visible_message
              INNER JOIN part AS visible_part
                ON visible_part.message_id = visible_message.id
               AND visible_part.ord = 0
              WHERE visible_message.session_id = candidate.id
                AND visible_message.type IN ('user_message', 'assistant_message')
                AND (
                  NOT json_valid(visible_part.data_json)
                  OR (
                    coalesce(json_extract(visible_part.data_json, '$.metadata.ui.visibility'), '') <> 'hidden'
                    AND coalesce(json_extract(visible_part.data_json, '$.metadata.trigger.kind'), '') <> 'workspace_creation_request'
                  )
                )
            )
          ORDER BY
            CASE WHEN candidate.id = ? THEN 0 ELSE 1 END,
            candidate.updated_at DESC,
            candidate.id DESC
          LIMIT 1
        `,
        )
        .get(activeConversationId ?? "");
      if (typeof reusable?.id === "string" && reusable.id) {
        resolvedConversationId = reusable.id;
        // Repeated New Chat on the active empty chat is a true no-op.
        if (reusable.id !== activeConversationId) {
          this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, reusable.id);
        }
        return;
      }
      const created = generateLocalId();
      const createdAt = Date.now();
      this.upsertSession(created, createdAt);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, created);
      resolvedConversationId = created;
    });
    return resolvedConversationId;
  }
  /**
   * Point the durable "active conversation" pointer at `conversationId`.
   * This is the single durable source of truth the desktop restores from on
   * boot (renderer hard-reload and full restart alike); the renderer writes
   * it whenever the active conversation changes. Unlike
   * `createNewDefaultConversationId`, this never mints a new id — it records
   * the conversation the user is actually viewing.
   */
  setActiveDefaultConversationId(conversationIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const now = Date.now();
    this.withTransaction(() => {
      this.upsertSession(conversationId, now);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, conversationId);
    });
  }
  /** Permanently remove one local conversation and its conversation-owned data. */
  deleteConversation(conversationIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const exists = this.db
      .prepare(`SELECT 1 FROM session WHERE id = ? LIMIT 1`)
      .get(conversationId);
    if (!exists) return false;
    const runningAgent = this.db
      .prepare(
        `SELECT 1
         FROM runtime_agents
         WHERE conversation_id = ? AND status = 'running'
         LIMIT 1`,
      )
      .get(conversationId);
    if (runningAgent) {
      throw new Error("A conversation with running tasks cannot be deleted.");
    }
    this.withTransaction(() => {
      this.db
        .prepare(
          `DELETE FROM agent_progress_summaries
                 WHERE agent_id IN (
                   SELECT thread_id FROM runtime_agents WHERE conversation_id = ?
                 )`,
        )
        .run(conversationId);
      this.db
        .prepare(`DELETE FROM runtime_agents WHERE conversation_id = ?`)
        .run(conversationId);
      this.db
        .prepare(`DELETE FROM runtime_threads WHERE conversation_id = ?`)
        .run(conversationId);
      this.db
        .prepare(
          `DELETE FROM runtime_conversation_state WHERE conversation_id = ?`,
        )
        .run(conversationId);
      this.db
        .prepare(
          `DELETE FROM runtime_memory_review_state WHERE conversation_id = ?`,
        )
        .run(conversationId);
      this.db
        .prepare(`DELETE FROM settings WHERE key = ? AND value = ?`)
        .run(DEFAULT_CONVERSATION_SETTING_KEY, conversationId);
      this.db.prepare(`DELETE FROM session WHERE id = ?`).run(conversationId);
    });
    return true;
  }
  /**
   * Ordering cursor `(created_at, id)` for one event within a conversation.
   * Returns null when the event id is absent from the conversation.
   */
  getEventCursor(conversationIdInput, eventIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const eventId = asTrimmedString(eventIdInput);
    if (!eventId) return null;
    const row = this.db
      .prepare(
        `SELECT id AS _id, created_at AS timestamp
           FROM message
          WHERE session_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(conversationId, eventId);
    if (!row) return null;
    return { id: row._id, timestamp: row.timestamp };
  }
  /**
   * Mint a fresh, empty conversation id WITHOUT touching the durable
   * "active conversation" pointer or reusing an existing empty chat. Used
   * by the desktop Fork action, which needs a brand-new destination that
   * leaves the user's current chat (and the active pointer) untouched.
   */
  createConversation() {
    const created = generateLocalId();
    const createdAt = Date.now();
    this.withTransaction(() => {
      this.upsertSession(created, createdAt);
    });
    return created;
  }
  /**
   * Truncate a conversation at a message: permanently remove the event
   * identified by `eventId` AND every event at-or-after it in
   * `(created_at, id)` order. Backs the desktop "Rewind here" action.
   *
   * Deleting `message` rows cascades to their `part` rows
   * (FOREIGN KEY ... ON DELETE CASCADE) and refreshes the FTS mirror via
   * triggers. Best-effort: any background agents this conversation spawned
   * within the removed range (non-running only) are pruned too, so the
   * Activity surface doesn't keep dangling task cards for turns that no
   * longer exist. A running agent is left alone — the renderer stops the
   * active stream before rewinding.
   */
  truncateConversationAtEvent(conversationIdInput, eventIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const cursor = this.getEventCursor(conversationId, eventIdInput);
    if (!cursor) return { removed: 0 };
    let removed = 0;
    this.withImmediateTransaction(() => {
      const cutoffCondition =
        `session_id = ? AND (created_at > ? OR (created_at = ? AND id >= ?))`;
      // The DELETE's own `changes` count is the number of removed rows —
      // no separate COUNT(*) pass over the same index range. (SQLite's
      // changes() counts only the directly-deleted `message` rows, not the
      // cascaded `part` rows, which is exactly the total we want.)
      const deleteResult = this.db
        .prepare(`DELETE FROM message WHERE ${cutoffCondition}`)
        .run(conversationId, cursor.timestamp, cursor.timestamp, cursor.id);
      removed = deleteResult?.changes ?? 0;
      const orphanThreadRows = this.db
        .prepare(
          `SELECT thread_id FROM runtime_agents
             WHERE conversation_id = ?
               AND status <> 'running'
               AND prompt_created_at IS NOT NULL
               AND prompt_created_at >= ?`,
        )
        .all(conversationId, cursor.timestamp);
      const orphanThreadIds = orphanThreadRows
        .map((row) => (typeof row.thread_id === "string" ? row.thread_id : ""))
        .filter((id) => id.length > 0);
      for (const threadId of orphanThreadIds) {
        this.db
          .prepare(`DELETE FROM agent_progress_summaries WHERE agent_id = ?`)
          .run(threadId);
        this.db
          .prepare(`DELETE FROM runtime_threads WHERE thread_key = ?`)
          .run(threadId);
        this.db
          .prepare(`DELETE FROM runtime_agents WHERE thread_id = ?`)
          .run(threadId);
      }
    });
    return { removed };
  }
  /**
   * Fork a conversation: copy every user/assistant message BEFORE
   * `eventId` (exclusive) into a brand-new conversation, preserving order
   * and timestamps, and return the new conversation id. Backs the desktop
   * "Fork to new chat" action; the source conversation is left untouched.
   *
   * Only `user_message` / `assistant_message` rows are copied — tool and
   * agent-lifecycle events are intentionally dropped so the branch carries
   * a clean transcript with no dangling agent/task references. Event ids
   * are re-minted (they are a globally-unique primary key) and each
   * assistant row's `userMessageId` back-reference is remapped onto the
   * copied user id so streaming/overlay correlation stays sound if the
   * fork is continued.
   */
  forkConversationBeforeEvent(conversationIdInput, eventIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const cursor = this.getEventCursor(conversationId, eventIdInput);
    if (!cursor) return null;
    const rows = this.db
      .prepare(
        `SELECT
           source.id AS _id,
           source.created_at AS timestamp,
           source.type AS type,
           source.device_id AS deviceId,
           source.request_id AS requestId,
           source.target_device_id AS targetDeviceId,
           part.data_json AS payloadJson,
           source.data_json AS channelEnvelopeJson
         FROM message AS source
         LEFT JOIN part
           ON part.message_id = source.id AND part.ord = 0
         WHERE source.session_id = ?
           AND source.type IN ('user_message', 'assistant_message')
           AND (source.created_at < ? OR (source.created_at = ? AND source.id < ?))
         ORDER BY source.created_at ASC, source.id ASC`,
      )
      .all(conversationId, cursor.timestamp, cursor.timestamp, cursor.id);
    const newConversationId = generateLocalId();
    const createdAt = Date.now();
    const idMap = new Map();
    this.withImmediateTransaction(() => {
      this.upsertSession(newConversationId, createdAt);
      for (const row of rows) {
        idMap.set(row._id, `local-${generateLocalId()}`);
      }
      for (const row of rows) {
        const newId = idMap.get(row._id);
        const meta = parseJsonRecord(row.channelEnvelopeJson);
        const channelEnvelope = asObject(meta?.channelEnvelope) ?? undefined;
        let payload = parseJsonRecord(row.payloadJson) ?? undefined;
        if (payload && row.type === "assistant_message") {
          const remappedUserId =
            typeof payload.userMessageId === "string"
              ? idMap.get(payload.userMessageId)
              : undefined;
          if (remappedUserId) {
            payload = { ...payload, userMessageId: remappedUserId };
          }
        }
        this.upsertEventMessage({
          sessionId: newConversationId,
          eventId: newId,
          type: row.type,
          timestamp: row.timestamp,
          deviceId: asTrimmedString(row.deviceId) || undefined,
          requestId: asTrimmedString(row.requestId) || undefined,
          targetDeviceId: asTrimmedString(row.targetDeviceId) || undefined,
          payload,
          channelEnvelope,
        });
      }
    });
    return { conversationId: newConversationId };
  }
  /** Cursor-paginated conversation history for the renderer's top bar. */
  listConversationSummaries(args = {}) {
    const requestedLimit = asFiniteNumber(args.limit);
    const limit = Math.min(100, Math.max(1, Math.floor(requestedLimit ?? 50)));
    const cursorUpdatedAt = asFiniteNumber(args.cursor?.updatedAt);
    const cursorConversationId = asTrimmedString(args.cursor?.conversationId);
    const hasCursor = cursorUpdatedAt !== null && Boolean(cursorConversationId);
    const rows = this.db
      .prepare(
        `
      WITH page AS (
        SELECT id, created_at, updated_at
        FROM session
        WHERE status = 'active'
          AND length(id) = 26
          AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
          ${
            hasCursor
              ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))"
              : ""
          }
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      )
      SELECT
        page.id AS conversationId,
        page.created_at AS createdAt,
        page.updated_at AS updatedAt,
        latest.id AS latestMessageId,
        latest.created_at AS latestMessageAt,
        latest_part.data_json AS payloadJson
      FROM page
      LEFT JOIN message AS latest
        ON latest.id = (
          SELECT candidate.id
          FROM message AS candidate
          INNER JOIN part AS candidate_part
            ON candidate_part.message_id = candidate.id
           AND candidate_part.ord = 0
          WHERE candidate.session_id = page.id
            AND candidate.type IN ('user_message', 'assistant_message')
            AND CASE
              WHEN json_valid(candidate_part.data_json) THEN
                typeof(json_extract(candidate_part.data_json, '$.text')) = 'text'
                AND trim(json_extract(candidate_part.data_json, '$.text')) <> ''
                AND coalesce(json_extract(candidate_part.data_json, '$.metadata.ui.visibility'), '') <> 'hidden'
                AND coalesce(json_extract(candidate_part.data_json, '$.metadata.trigger.kind'), '') <> 'workspace_creation_request'
              ELSE 0
            END
          ORDER BY candidate.created_at DESC, candidate.id DESC
          LIMIT 1
        )
      LEFT JOIN part AS latest_part
        ON latest_part.message_id = latest.id
       AND latest_part.ord = 0
      ORDER BY page.updated_at DESC, page.id DESC
      `,
      )
      .all(
        ...(hasCursor
          ? [cursorUpdatedAt, cursorUpdatedAt, cursorConversationId, limit + 1]
          : [limit + 1]),
      );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const conversations = pageRows.map((row) => {
      const payload = parseJsonRecord(row.payloadJson);
      const rawText =
        !isUiHiddenChatMessagePayload(payload ?? null) &&
        typeof payload?.text === "string"
          ? payload.text
          : "";
      const title = rawText.replace(/\s+/g, " ").trim().slice(0, 240);
      return {
        conversationId: row.conversationId,
        title: title || "New chat",
        ...(row.latestMessageId
          ? { latestMessageId: row.latestMessageId }
          : {}),
        ...(typeof row.latestMessageAt === "number"
          ? { latestMessageAt: row.latestMessageAt }
          : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
    const last = conversations.at(-1);
    return {
      conversations,
      hasMore,
      ...(hasMore && last
        ? {
            nextCursor: {
              updatedAt: last.updatedAt,
              conversationId: last.conversationId,
            },
          }
        : {}),
    };
  }
  listEvents(conversationIdInput, maxItems = 200) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(maxItems));
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE session_id = ?
          AND type NOT IN ('thread_message', 'run_event', 'memory')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(conversationId, normalizedLimit);
    return rows.map((row) => this.deserializeEventRow(row));
  }
  /**
   * Provider-call ledger projected from the durable assistant messages in
   * runtime_thread_entries. This intentionally reads the canonical thread
   * history instead of maintaining a second write path that could drift or
   * double-count retries. Historical native calls become visible as soon as
   * this reader ships; synthetic `model: history` replay rows are excluded.
   */
  listModelUsage(args = {}) {
    const fromMs = asFiniteNumber(args.fromMs);
    const toMs = asFiniteNumber(args.toMs);
    const conversationId = asTrimmedString(args.conversationId);
    const threadId =
      typeof args.threadId === "string" && args.threadId.trim()
        ? normalizeRuntimeThreadId(args.threadId)
        : undefined;
    const normalizedLimit = Math.min(
      10000,
      Math.max(1, Math.floor(asFiniteNumber(args.limit) ?? 5000)),
    );
    // The first three clauses must stay textually in sync with the WHERE
    // of idx_runtime_thread_entries_usage (database-init.ts) so SQLite's
    // partial-index prover keeps this off the full-table-scan path.
    const clauses = [
      "entry.entry_type = 'message'",
      "json_extract(entry.data_json, '$.message.role') = 'assistant'",
      "json_type(entry.data_json, '$.message.usage') = 'object'",
      "COALESCE(json_extract(entry.data_json, '$.message.model'), '') != 'history'",
    ];
    const params = [];
    if (fromMs !== null) {
      clauses.push("entry.created_at >= ?");
      params.push(Math.floor(fromMs));
    }
    if (toMs !== null) {
      clauses.push("entry.created_at <= ?");
      params.push(Math.floor(toMs));
    }
    if (conversationId) {
      clauses.push("thread.conversation_id = ?");
      params.push(conversationId);
    }
    if (threadId) {
      clauses.push("thread.thread_key = ?");
      params.push(threadId);
    }
    params.push(normalizedLimit + 1);
    const rows = this.db
      .prepare(
        `
      SELECT
        entry.entry_id AS id,
        entry.created_at AS timestamp,
        thread.conversation_id AS conversationId,
        COALESCE(NULLIF(session.title, ''), thread.conversation_id) AS conversationTitle,
        thread.thread_key AS threadId,
        thread.name AS threadName,
        thread.agent_type AS agentType,
        agent.description AS agentDescription,
        agent.agent_depth AS agentDepth,
        agent.parent_agent_id AS parentAgentId,
        agent.root_run_id AS rootRunId,
        json_extract(entry.data_json, '$.message.provider') AS provider,
        json_extract(entry.data_json, '$.message.api') AS api,
        json_extract(entry.data_json, '$.message.model') AS model,
        json_extract(entry.data_json, '$.message.responseModel') AS responseModel,
        json_extract(entry.data_json, '$.message.usage.input') AS inputTokens,
        json_extract(entry.data_json, '$.message.usage.cacheRead') AS cacheReadTokens,
        json_extract(entry.data_json, '$.message.usage.cacheWrite') AS cacheWriteTokens,
        json_extract(entry.data_json, '$.message.usage.output') AS outputTokens,
        json_extract(entry.data_json, '$.message.usage.reasoning') AS reasoningTokens,
        json_extract(entry.data_json, '$.message.usage.totalTokens') AS totalTokens,
        json_extract(entry.data_json, '$.message.usage.cost.input') AS inputCostUsd,
        json_extract(entry.data_json, '$.message.usage.cost.cacheRead') AS cacheReadCostUsd,
        json_extract(entry.data_json, '$.message.usage.cost.cacheWrite') AS cacheWriteCostUsd,
        json_extract(entry.data_json, '$.message.usage.cost.output') AS outputCostUsd,
        json_extract(entry.data_json, '$.message.usage.cost.total') AS totalCostUsd,
        json_extract(entry.data_json, '$.message.stopReason') AS stopReason,
        json_extract(entry.data_json, '$.message.errorMessage') AS errorMessage
      FROM runtime_thread_entries entry
      JOIN runtime_threads thread ON thread.thread_key = entry.thread_key
      LEFT JOIN runtime_agents agent ON agent.thread_id = thread.thread_key
      LEFT JOIN session ON session.id = thread.conversation_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY entry.created_at DESC, entry.entry_id DESC
      LIMIT ?
    `,
      )
      .all(...params);
    const truncated = rows.length > normalizedLimit;
    return {
      records: rows.slice(0, normalizedLimit).map((row) => {
        const rowConversationId = asTrimmedString(row.conversationId);
        const agentType = asTrimmedString(row.agentType);
        const agentDescription = asTrimmedString(row.agentDescription);
        const agentDepth = asFiniteNumber(row.agentDepth);
        const parentAgentId = asTrimmedString(row.parentAgentId);
        const rootRunId = asTrimmedString(row.rootRunId);
        const responseModel = asTrimmedString(row.responseModel);
        const errorMessage = asTrimmedString(row.errorMessage);
        return {
          id: asTrimmedString(row.id),
          timestamp: asFiniteNumber(row.timestamp) ?? 0,
          conversationId: rowConversationId,
          conversationTitle:
            asTrimmedString(row.conversationTitle) || rowConversationId,
          threadId: asTrimmedString(row.threadId),
          threadName: asTrimmedString(row.threadName) || agentType,
          agentType: agentType || "unknown",
          ...(agentDescription ? { agentDescription } : {}),
          ...(agentDepth !== null ? { agentDepth } : {}),
          ...(parentAgentId ? { parentAgentId } : {}),
          ...(rootRunId ? { rootRunId } : {}),
          provider: asTrimmedString(row.provider) || "unknown",
          api: asTrimmedString(row.api) || "unknown",
          model: asTrimmedString(row.model) || "unknown",
          ...(responseModel ? { responseModel } : {}),
          inputTokens: asFiniteNumber(row.inputTokens) ?? 0,
          cacheReadTokens: asFiniteNumber(row.cacheReadTokens) ?? 0,
          cacheWriteTokens: asFiniteNumber(row.cacheWriteTokens) ?? 0,
          outputTokens: asFiniteNumber(row.outputTokens) ?? 0,
          reasoningTokens: asFiniteNumber(row.reasoningTokens) ?? 0,
          totalTokens: asFiniteNumber(row.totalTokens) ?? 0,
          inputCostUsd: asFiniteNumber(row.inputCostUsd) ?? 0,
          cacheReadCostUsd: asFiniteNumber(row.cacheReadCostUsd) ?? 0,
          cacheWriteCostUsd: asFiniteNumber(row.cacheWriteCostUsd) ?? 0,
          outputCostUsd: asFiniteNumber(row.outputCostUsd) ?? 0,
          totalCostUsd: asFiniteNumber(row.totalCostUsd) ?? 0,
          stopReason: asTrimmedString(row.stopReason) || "unknown",
          ...(errorMessage ? { errorMessage } : {}),
        };
      }),
      truncated,
    };
  }
  listLifecycleEventsByIds(eventIdsInput) {
    const eventIds = [
      ...new Set(eventIdsInput.map(asTrimmedString).filter(Boolean)),
    ].slice(0, 500);
    if (eventIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.id IN (${eventIds.map(() => "?").join(", ")})
        AND message.type IN (
          'agent-started',
          'agent-progress',
          'agent-completed',
          'agent-failed',
          'agent-canceled'
        )
      ORDER BY message.created_at ASC, message.id ASC
    `,
      )
      .all(...eventIds);
    return rows.map((row) => this.deserializeEventRow(row));
  }
  /**
   * Return cross-conversation activity newer than `sinceMs` (plain ms
   * since the Unix epoch — same unit `message.created_at` is written
   * with by every `appendLocalChatEvent` call). Capped at `limit`
   * (default 80) of the most recent events and returned oldest→newest
   * so callers can fold them into a chronological brief.
   */
  listRecentActivitySince(args) {
    const sinceMs = Number.isFinite(args.sinceMs)
      ? Math.max(0, Math.floor(args.sinceMs))
      : 0;
    const normalizedLimit = Math.max(
      1,
      Math.min(Math.floor(args.limit ?? 80), 500),
    );
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.session_id AS conversationId,
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE created_at >= ?
          AND type IN (
            'user_message',
            'assistant_message',
            'agent-started',
            'agent-progress',
            'agent-completed',
            'agent-failed',
            'agent-canceled',
            'tool_result'
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(sinceMs, normalizedLimit);
    return rows.map((row) => ({
      conversationId: row.conversationId,
      ...this.deserializeEventRow(row),
    }));
  }
  /**
   * Page strictly older events than a `(beforeTimestampMs, beforeId)` cursor.
   * Used by the chat home overview's "See all" dialog to walk SQLite for
   * additional history beyond the renderer's in-memory event window —
   * without that, the dialog can only ever show what's already loaded for
   * the live chat (capped at ~500 events).
   *
   * Mirrors `listEvents`'s exclusion of internal types (`thread_message`,
   * `run_event`, `memory`) so the rows roundtrip through the same
   * `EventRecord` shape downstream consumers already use.
   */
  listEventsBefore(conversationIdInput, opts) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const beforeTimestamp = Math.floor(opts.beforeTimestampMs);
    const beforeId = opts.beforeId ?? "";
    const normalizedLimit = Math.max(1, Math.floor(opts.limit ?? 50));
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE session_id = ?
          AND type NOT IN ('thread_message', 'run_event', 'memory')
          AND (
            created_at < ?
            OR (created_at = ? AND id < ?)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(
        conversationId,
        beforeTimestamp,
        beforeTimestamp,
        beforeId,
        normalizedLimit,
      );
    return rows.map((row) => this.deserializeEventRow(row));
  }
  /**
   * Window of visible chat messages with each assistant message's turn-
   * scoped tool/agent lifecycle events attached as `toolEvents`. This is
   * the read shape the chat UI consumes — pure event-log readers should
   * keep using `listEvents` / `listEventsBefore`.
   *
   * Two-step query: first locate the (timestamp, id) cutoff of the
   * `maxVisibleMessages`-th most-recent user/assistant row, then fetch all
   * tool/agent lifecycle events from the cutoff forward and group them by
   * turn (boundary = `user_message`). Mirrors the renderer's prior
   * `segmentToolEventsByAssistant` so the inline-artifact /
   * schedule-receipt projections that hung off the flat event stream keep
   * working without a flat event stream.
   *
   * `messages` is the ordered visible chat (oldest → newest). Trailing
   * tool/agent lifecycle events that landed after the last visible
   * `user_message` with no following assistant yet (typical for
   * fire-and-forget image submissions in-flight at fetch time) stay on
   * that user message's `toolEvents`, so the renderer can synthesize the
   * standalone artifact row it always has.
   */
  listMessages(conversationIdInput, args = {}) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const maxVisibleMessages = Math.max(
      1,
      Math.floor(args.maxVisibleMessages ?? 200),
    );
    const cutoff = this.findVisibleMessageCutoff(
      conversationId,
      maxVisibleMessages,
    );
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, cutoff);
    const rows = this.fetchTimelineRows(conversationId, fetchCutoff, null);
    return this.trimMessageWindow(this.assembleMessageWindow(rows), cutoff);
  }
  /**
   * Same projection as `listMessages` but returns strictly-older messages
   * than `(beforeTimestampMs, beforeId)`. Drives the chat's "load older"
   * pagination — the cursor is the oldest message in the currently-loaded
   * window so successive calls walk the conversation backwards a page at
   * a time.
   */
  listMessagesBefore(conversationIdInput, args) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const maxVisibleMessages = Math.max(
      1,
      Math.floor(args.maxVisibleMessages ?? 200),
    );
    const beforeTimestamp = Math.floor(args.beforeTimestampMs);
    const beforeId = args.beforeId;
    const before = { timestamp: beforeTimestamp, id: beforeId };
    const cutoff = this.findVisibleMessageCutoffBefore(
      conversationId,
      maxVisibleMessages,
      before,
    );
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, cutoff);
    const rows = this.fetchTimelineRows(conversationId, fetchCutoff, before);
    return this.trimMessageWindow(this.assembleMessageWindow(rows), cutoff);
  }
  /**
   * Same projection as `listMessages`, but walks forward from a known mobile
   * cursor. The returned rows are the new user/assistant messages plus any
   * existing message rows whose turn gained new tool-derived artifacts after
   * the cursor.
   */
  listMessagesAfter(conversationIdInput, args) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const maxVisibleMessages = Math.max(
      1,
      Math.floor(args.maxVisibleMessages ?? 200),
    );
    const after = {
      timestamp: Math.floor(args.afterTimestampMs),
      id: args.afterId,
    };
    const fetchCutoff = this.findTurnFetchCutoff(conversationId, after);
    const rows = this.fetchTimelineRows(
      conversationId,
      fetchCutoff,
      null,
      null,
      CUTOFF_SCAN_CEILING,
    );
    const sourceEvents = rows.filter(
      (row) =>
        compareTimelineCursor(
          { timestamp: row.timestamp, id: row._id },
          after,
        ) > 0,
    );
    return {
      ...this.limitChangedMessageWindow(
        this.assembleMessageWindow(rows),
        after,
        maxVisibleMessages,
      ),
      sourceEvents,
    };
  }
  hasMobileSyncEventsAfter(conversationIdInput, afterTimestampMs, afterId) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const row = this.db
      .prepare(
        `
      SELECT 1 AS found
      FROM message
      WHERE session_id = ?
        AND (
          created_at, id
        ) > (?, ?)
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `,
      )
      .get(conversationId, Math.floor(afterTimestampMs), afterId);
    return row?.found === 1;
  }
  /**
   * Resolve lifecycle state only for task ids a cursor delta touched. This is
   * deliberately separate from `listMessages`: incremental mobile sync must
   * not scan/project the latest 100 transcript rows merely to recover an old
   * task's spawning anchor. Each matching start event loads only its own turn,
   * then later lifecycle events for that agent are folded onto that anchor.
   */
  listMobileTaskContext(conversationIdInput, agentIdsInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const agentIds = [
      ...new Set(agentIdsInput.map(asTrimmedString).filter(Boolean)),
    ].slice(0, 100);
    if (agentIds.length === 0) {
      return { messages: [], visibleMessageCount: 0 };
    }
    const placeholders = agentIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.session_id = ?
        AND message.type IN ('agent-started', 'agent-progress', 'agent-completed', 'agent-failed', 'agent-canceled')
        AND json_extract(part.data_json, '$.agentId') IN (${placeholders})
      ORDER BY message.created_at ASC, message.id ASC
    `,
      )
      .all(conversationId, ...agentIds);
    const lifecycleEvents = rows.map((row) => this.deserializeEventRow(row));
    const eventsByAgent = new Map();
    for (const event of lifecycleEvents) {
      const agentId = asTrimmedString(event.payload?.agentId);
      if (!agentId) continue;
      const bucket = eventsByAgent.get(agentId);
      if (bucket) bucket.push(event);
      else eventsByAgent.set(agentId, [event]);
    }
    const anchorsById = new Map();
    for (const start of lifecycleEvents) {
      if (start.type !== "agent-started") continue;
      const agentId = asTrimmedString(start.payload?.agentId);
      if (!agentId) continue;
      const turnStart = this.findTurnFetchCutoff(conversationId, {
        timestamp: start.timestamp,
        id: start._id,
      });
      const nextTurn = this.findNextUserMessageAfter(conversationId, turnStart);
      const turn = this.assembleMessageWindow(
        this.fetchTimelineRows(conversationId, turnStart, nextTurn),
      );
      const anchor =
        turn.messages.find((message) =>
          message.toolEvents.some((event) => event._id === start._id),
        ) ?? turn.messages.find((message) => message.type === "user_message");
      if (!anchor) continue;
      const existing = anchorsById.get(anchor._id);
      const lifecycle = eventsByAgent.get(agentId) ?? [];
      const combined = [
        ...(existing?.toolEvents ?? anchor.toolEvents),
        ...lifecycle,
      ];
      const seen = new Set();
      const toolEvents = combined
        .filter((event) => {
          if (seen.has(event._id)) return false;
          seen.add(event._id);
          return true;
        })
        .sort(
          (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
        );
      anchorsById.set(anchor._id, { ...anchor, toolEvents });
    }
    const messages = [...anchorsById.values()].sort(
      (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
    );
    return {
      messages,
      visibleMessageCount: messages.filter(
        (message) => !isUiHiddenChatMessagePayload(message.payload ?? null),
      ).length,
    };
  }
  /**
   * Walks user/assistant rows DESC pulling the payload JSON so we can
   * skip UI-hidden messages (system reminders, workspace-creation
   * requests — see `isUiHiddenChatMessagePayload`). Without this, hidden
   * rows near the tail eat the `maxVisibleMessages` budget and the chat
   * surface comes back missing real messages.
   *
   * Bounded by `CUTOFF_SCAN_CEILING` — large enough to absorb the
   * worst-case hidden-row density observed in real chats but capped so
   * conversations with millions of events don't fetch them all to
   * compute a window cutoff. If the ceiling is hit before we find
   * `maxVisibleMessages` visible rows, the oldest scanned message becomes
   * the cutoff so the timeline read remains bounded.
   */
  findVisibleMessageCutoff(conversationId, maxVisibleMessages) {
    return this.findVisibleMessageCutoffPaged(
      conversationId,
      maxVisibleMessages,
      null,
    );
  }
  findVisibleMessageCutoffBefore(conversationId, maxVisibleMessages, before) {
    return this.findVisibleMessageCutoffPaged(
      conversationId,
      maxVisibleMessages,
      before,
    );
  }
  findVisibleMessageCutoffPaged(
    conversationId,
    maxVisibleMessages,
    initialBefore,
  ) {
    const batchSize = Math.min(
      CUTOFF_SCAN_BATCH_MAX,
      Math.max(CUTOFF_SCAN_BATCH_MIN, maxVisibleMessages * 2),
    );
    let before = initialBefore;
    let scanned = 0;
    let visible = 0;
    let oldestScanned = null;
    while (scanned < CUTOFF_SCAN_CEILING) {
      const limit = Math.min(batchSize, CUTOFF_SCAN_CEILING - scanned);
      const beforeClause = before
        ? "AND (message.created_at, message.id) < (?, ?)"
        : "";
      const params = [conversationId];
      if (before) {
        params.push(before.timestamp, before.id);
      }
      params.push(limit);
      const rows = this.db
        .prepare(
          `
        SELECT message.created_at AS timestamp, message.id AS id, part.data_json AS payloadJson
        FROM message
        LEFT JOIN part
          ON part.message_id = message.id
         AND part.ord = 0
        WHERE message.session_id = ?
          AND message.type IN ('user_message', 'assistant_message')
          ${beforeClause}
        ORDER BY message.created_at DESC, message.id DESC
        LIMIT ?
      `,
        )
        .all(...params);
      if (rows.length === 0) return null;
      for (const row of rows) {
        if (typeof row.timestamp !== "number" || typeof row.id !== "string") {
          continue;
        }
        oldestScanned = { timestamp: row.timestamp, id: row.id };
        const payload = parseJsonRecord(row.payloadJson) ?? null;
        if (isUiHiddenChatMessagePayload(payload)) continue;
        visible += 1;
        if (visible === maxVisibleMessages) return oldestScanned;
      }
      scanned += rows.length;
      if (rows.length < limit) return null;
      before = oldestScanned;
      if (!before) return null;
    }
    return oldestScanned;
  }
  fetchTimelineRows(conversationId, cutoff, before, after = null, limit) {
    const clauses = [
      "message.session_id = ?",
      "message.type IN ('user_message', 'assistant_message', 'tool_request', 'tool_result', 'agent-started', 'agent-progress', 'agent-completed', 'agent-failed', 'agent-canceled')",
    ];
    const params = [conversationId];
    if (cutoff) {
      clauses.push("(message.created_at, message.id) >= (?, ?)");
      params.push(cutoff.timestamp, cutoff.id);
    }
    if (before) {
      clauses.push("(message.created_at, message.id) < (?, ?)");
      params.push(before.timestamp, before.id);
    }
    if (after) {
      clauses.push("(message.created_at, message.id) > (?, ?)");
      params.push(after.timestamp, after.id);
    }
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : null;
    if (normalizedLimit !== null) {
      params.push(normalizedLimit);
    }
    const sql = `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE ${clauses.join(" AND ")}
      ORDER BY message.created_at ASC, message.id ASC
      ${normalizedLimit !== null ? "LIMIT ?" : ""}
    `;
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => this.deserializeEventRow(row));
  }
  findTurnFetchCutoff(conversationId, cutoff) {
    if (!cutoff) return null;
    const row = this.db
      .prepare(
        `
      SELECT message.created_at AS timestamp, message.id AS id
      FROM message
      WHERE message.session_id = ?
        AND message.type = 'user_message'
        AND (
          message.created_at, message.id
        ) <= (?, ?)
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT 1
    `,
      )
      .get(conversationId, cutoff.timestamp, cutoff.id);
    if (typeof row?.timestamp !== "number" || typeof row.id !== "string") {
      return cutoff;
    }
    return { timestamp: row.timestamp, id: row.id };
  }
  findNextUserMessageAfter(conversationId, cursor) {
    if (!cursor) return null;
    const row = this.db
      .prepare(
        `
      SELECT message.created_at AS timestamp, message.id AS id
      FROM message
      WHERE message.session_id = ?
        AND message.type = 'user_message'
        AND (
          message.created_at, message.id
        ) > (?, ?)
      ORDER BY message.created_at ASC, message.id ASC
      LIMIT 1
    `,
      )
      .get(conversationId, cursor.timestamp, cursor.id);
    return typeof row?.timestamp === "number" && typeof row.id === "string"
      ? { timestamp: row.timestamp, id: row.id }
      : null;
  }
  trimMessageWindow(window, cutoff) {
    if (!cutoff) return window;
    let visibleMessageCount = 0;
    const messages = window.messages.filter((message) => {
      const keep =
        compareTimelineCursor(
          { timestamp: message.timestamp, id: message._id },
          cutoff,
        ) >= 0;
      if (keep && !isUiHiddenChatMessagePayload(message.payload ?? null)) {
        visibleMessageCount += 1;
      }
      return keep;
    });
    return { messages, visibleMessageCount };
  }
  limitMessageWindow(window, maxVisibleMessages) {
    const messages = [];
    let visibleMessageCount = 0;
    for (const message of window.messages) {
      messages.push(message);
      if (!isUiHiddenChatMessagePayload(message.payload ?? null)) {
        visibleMessageCount += 1;
      }
      if (visibleMessageCount >= maxVisibleMessages) {
        break;
      }
    }
    return { messages, visibleMessageCount };
  }
  limitChangedMessageWindow(window, after, maxVisibleMessages) {
    const messages = [];
    let visibleMessageCount = 0;
    for (const message of window.messages) {
      const messageChanged =
        compareTimelineCursor(
          { timestamp: message.timestamp, id: message._id },
          after,
        ) > 0;
      const toolEventsChanged = message.toolEvents.some(
        (event) =>
          compareTimelineCursor(
            { timestamp: event.timestamp, id: event._id },
            after,
          ) > 0,
      );
      if (!messageChanged && !toolEventsChanged) continue;
      messages.push(message);
      if (!isUiHiddenChatMessagePayload(message.payload ?? null)) {
        visibleMessageCount += 1;
      }
      if (visibleMessageCount >= maxVisibleMessages) {
        break;
      }
    }
    return { messages, visibleMessageCount };
  }
  /**
   * Walk fetched rows forward, group them into turns (boundary =
   * `user_message`), and attach every tool/agent lifecycle event in
   * a turn to the assistant message that most-recently preceded it:
   *
   *   - **most-recent preceding assistant** of the turn — orchestrator
   *     runs that emit a preamble → tools → post-tool answer render
   *     linearly with tool-derived artifacts on the preamble bubble
   *     (rather than collapsing every assistant in the turn into one
   *     row that owns every tool).
   *
   *   - **first assistant** of the turn for tools that fired BEFORE
   *     any assistant text (common for `image_gen` / `html` /
   *     `Schedule` called eagerly) — those tools defer until the first
   *     assistant arrives and attach to it, so inline image / schedule
   *     receipt / office preview / source-diff artifacts still surface
   *     on the assistant row.
   *
   *   - **user_message** of the turn when no assistant fires — fixes
   *     the prior port's silent drop of tools in turns where the
   *     agent's first action is a fire-and-forget tool. The renderer's
   *     trailing artifact paths already read from `user_message.toolEvents`,
   *     so they surface correctly.
   *
   * `visibleMessageCount` is the count of user/assistant rows whose
   * payload doesn't satisfy `isUiHiddenChatMessagePayload`. The chat
   * hook bases `hasOlderMessages` / `isLoadingOlder` on this rather
   * than raw `messages.length` so UI-hidden system reminders or
   * workspace-creation requests in the window don't make pagination
   * state latch against the wrong threshold.
   *
   * Mirror this in lockstep with `groupEventsIntoMessages` on the
   * renderer so cloud-mode and local-mode produce identical shapes.
   */
  assembleMessageWindow(rows) {
    const messages = [];
    let turnUserMessage = null;
    let currentAssistant = null;
    let pendingPreAssistantTools = [];
    let visibleMessageCount = 0;
    /**
     * Flush tools that arrived in the current turn without ever seeing
     * an assistant message — fall back to the user_message anchor so
     * inline artifacts on fire-and-forget turns
     * still render. Mirrors `groupEventsIntoMessages` on the renderer.
     */
    const finalizePreAssistantTools = () => {
      if (pendingPreAssistantTools.length > 0 && turnUserMessage) {
        turnUserMessage.toolEvents = [
          ...turnUserMessage.toolEvents,
          ...pendingPreAssistantTools,
        ];
      }
      pendingPreAssistantTools = [];
    };
    for (const row of rows) {
      if (row.type === "user_message") {
        finalizePreAssistantTools();
        const message = { ...row, toolEvents: [] };
        messages.push(message);
        turnUserMessage = message;
        currentAssistant = null;
        if (!isUiHiddenChatMessagePayload(row.payload ?? null)) {
          visibleMessageCount += 1;
        }
        continue;
      }
      if (row.type === "assistant_message") {
        const message = { ...row, toolEvents: [] };
        messages.push(message);
        const hidden = isUiHiddenChatMessagePayload(row.payload ?? null);
        // Tools that fired before any assistant in this turn attach to
        // the FIRST assistant (preserves the prior inline-artifact
        // behavior for tools called before any reply text). Tools that
        // fired between two assistants attach to whichever was most
        // recently seen — so an orchestrator run that does
        // preamble → tools → post-tool answer renders linearly with
        // tool-derived artifacts on the preamble bubble.
        if (!hidden && pendingPreAssistantTools.length > 0) {
          message.toolEvents = [
            ...message.toolEvents,
            ...pendingPreAssistantTools,
          ];
          pendingPreAssistantTools = [];
        }
        if (!hidden) {
          currentAssistant = message;
          visibleMessageCount += 1;
        }
        continue;
      }
      if (currentAssistant) {
        currentAssistant.toolEvents = [...currentAssistant.toolEvents, row];
      } else {
        pendingPreAssistantTools.push(row);
      }
    }
    finalizePreAssistantTools();
    return { messages, visibleMessageCount };
  }
  /**
   * Agent lifecycle events (`agent-started` / `agent-progress` /
   * `agent-completed` / `agent-failed` / `agent-canceled`) for the
   * conversation, ordered ASC by `(timestamp, _id)`.
   *
   * Task STATE no longer derives from these events (that's
   * `listThreadActivity`); the remaining consumers are file-derived
   * surfaces (per-agent file lists merge the `agent-completed` rollups)
   * and the inline chat cards' per-occurrence history.
   *
   * Optional `beforeTimestampMs` / `beforeId` cursor returns strictly-
   * older activity.
   */
  listActivity(conversationIdInput, args = {}) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(args.limit ?? 500));
    const before =
      typeof args.beforeTimestampMs === "number"
        ? {
            timestamp: Math.floor(args.beforeTimestampMs),
            id: args.beforeId ?? "",
          }
        : null;
    const clauses = [
      "session_id = ?",
      "type IN ('agent-started', 'agent-progress', 'agent-completed', 'agent-failed', 'agent-canceled')",
    ];
    const params = [conversationId];
    if (before) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(before.timestamp, before.timestamp, before.id);
    }
    params.push(normalizedLimit);
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(...params);
    const activities = rows.map((row) => this.deserializeEventRow(row));
    return { activities };
  }
  /**
   * File-carrying events (`tool_result` / `agent-completed` whose
   * payload has a non-empty `fileChanges` or `producedFiles` array)
   * for the conversation, ordered ASC by `(timestamp, _id)`.
   *
   * The Recent Files surfaces use this instead of scanning the full
   * event stream. The SQL pre-filter via `json_extract` +
   * `json_array_length` keeps the window genuinely scoped to events
   * that touch disk, so a `limit` of 500 buys 500 file events rather
   * than 500 arbitrary tool results that may or may not have produced
   * a file.
   *
   * Optional `beforeTimestampMs` / `beforeId` cursor pages strictly-
   * older file events for the ActivityHistoryDialog "files" section.
   */
  listFiles(conversationIdInput, args = {}) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(args.limit ?? 500));
    const before =
      typeof args.beforeTimestampMs === "number"
        ? {
            timestamp: Math.floor(args.beforeTimestampMs),
            id: args.beforeId ?? "",
          }
        : null;
    const clauses = [
      "m.session_id = ?",
      "m.type IN ('tool_result', 'agent-completed')",
      "p.data_json IS NOT NULL",
      // `json_array_length` on a missing/non-array path returns NULL in
      // SQLite, and `NULL > 0` is `NULL` (falsy), so this naturally
      // excludes events without file changes without needing explicit
      // null guards.
      "(json_array_length(json_extract(p.data_json, '$.fileChanges')) > 0 OR json_array_length(json_extract(p.data_json, '$.producedFiles')) > 0)",
    ];
    const params = [conversationId];
    if (before) {
      clauses.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      params.push(before.timestamp, before.timestamp, before.id);
    }
    params.push(normalizedLimit);
    const rows = this.db
      .prepare(
        `
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT m.*
        FROM message m
        LEFT JOIN part p
          ON p.message_id = m.id
         AND p.ord = 0
        WHERE ${clauses.join(" AND ")}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
      )
      .all(...params);
    return { files: rows.map((row) => this.deserializeEventRow(row)) };
  }
  getEventCount(conversationIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM message
      WHERE session_id = ?
        AND type NOT IN ('thread_message', 'run_event', 'memory')
    `,
      )
      .get(conversationId);
    return typeof row?.count === "number" ? row.count : 0;
  }
  listSyncMessages(
    conversationIdInput,
    maxMessages = MAX_EVENTS_PER_CONVERSATION,
  ) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(maxMessages));
    const rows = this.db
      .prepare(
        `
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        part.data_json AS payloadJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.session_id = ?
        AND message.type IN ('user_message', 'assistant_message')
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT ?
    `,
      )
      .all(conversationId, CUTOFF_SCAN_CEILING);
    const messages = [];
    for (const row of rows) {
      const payload = parseJsonRecord(row.payloadJson);
      if (isUiHiddenChatMessagePayload(payload ?? null)) continue;
      const text = eventTextFromPayload(payload);
      if (!text) continue;
      const role = row.type === "user_message" ? "user" : "assistant";
      messages.push({
        localMessageId: row._id,
        role,
        text,
        timestamp: row.timestamp,
        ...(role === "user" && row.deviceId ? { deviceId: row.deviceId } : {}),
      });
      if (messages.length >= normalizedLimit) break;
    }
    return messages.reverse();
  }
  getSyncCheckpoint(conversationIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    return this.getSession(conversationId)?.syncCheckpointMessageId ?? null;
  }
  setSyncCheckpoint(conversationIdInput, localMessageIdInput) {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const localMessageId = asTrimmedString(localMessageIdInput);
    if (!localMessageId) return;
    this.upsertSession(conversationId, Date.now());
    this.db
      .prepare(
        `
      UPDATE session
      SET sync_checkpoint_message_id = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(localMessageId, Date.now(), conversationId);
  }
  getThreadConversationId(threadKey) {
    const row = this.db
      .prepare(
        `
      SELECT conversation_id AS conversationId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey);
    if (
      typeof row?.conversationId === "string" &&
      row.conversationId.trim().length > 0
    ) {
      return row.conversationId;
    }
    return this.ensureImplicitThreadRow(threadKey).conversationId;
  }
  getThreadSession(threadKey) {
    const row = this.db
      .prepare(
        `
      SELECT
        session_id AS sessionId,
        created_at AS createdAt,
        cwd,
        parent_session AS parentSession
      FROM runtime_thread_sessions
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey);
    return row ?? null;
  }
  ensureThreadSession(threadKey, conversationId, timestamp) {
    const existing = this.getThreadSession(threadKey);
    if (existing) {
      this.db
        .prepare(
          `
        UPDATE runtime_thread_sessions
        SET updated_at = ?
        WHERE thread_key = ?
      `,
        )
        .run(timestamp, threadKey);
      return existing;
    }
    const sessionId = generateLocalId();
    const cwd = "";
    this.upsertSession(conversationId, timestamp);
    this.db
      .prepare(
        `
      INSERT INTO runtime_thread_sessions (
        thread_key,
        session_id,
        version,
        cwd,
        parent_session,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?)
    `,
      )
      .run(
        threadKey,
        sessionId,
        RUNTIME_THREAD_SESSION_VERSION,
        cwd,
        timestamp,
        timestamp,
      );
    return {
      sessionId,
      createdAt: timestamp,
      cwd,
      parentSession: null,
    };
  }
  getThreadLeafEntryId(threadKey) {
    const row = this.db
      .prepare(
        `
      SELECT entry_id AS entryId
      FROM runtime_thread_entries
      WHERE thread_key = ?
      ORDER BY insertion_sequence DESC, rowid DESC
      LIMIT 1
    `,
      )
      .get(threadKey);
    return typeof row?.entryId === "string" && row.entryId.trim().length > 0
      ? row.entryId
      : null;
  }
  appendThreadSessionEntry(args) {
    const entryId = generateLocalId();
    const parentEntryId = this.getThreadLeafEntryId(args.threadKey);
    const timestampIso = toIsoTimestamp(args.timestamp);
    this.db
      .prepare(
        `
      INSERT INTO runtime_thread_entries (
        entry_id,
        thread_key,
        session_id,
        parent_entry_id,
        entry_type,
        timestamp_iso,
        created_at,
        data_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        entryId,
        args.threadKey,
        args.sessionId,
        parentEntryId,
        args.entryType,
        timestampIso,
        args.timestamp,
        toJsonValueString(args.data),
      );
    return entryId;
  }
  loadThreadSessionEntries(threadKey, limit) {
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    const sql = `
      SELECT
        recent.entry_id AS entryId,
        recent.parent_entry_id AS parentEntryId,
        recent.entry_type AS entryType,
        recent.timestamp_iso AS timestampIso,
        recent.created_at AS createdAt,
        recent.data_json AS dataJson
      FROM (
        SELECT rowid AS entryRowId, *
        FROM runtime_thread_entries
        WHERE thread_key = ?
        ORDER BY insertion_sequence DESC, rowid DESC
        ${normalizedLimit ? "LIMIT ?" : ""}
      ) recent
      ORDER BY recent.insertion_sequence ASC, recent.entryRowId ASC
    `;
    const rows = normalizedLimit
      ? this.db.prepare(sql).all(threadKey, normalizedLimit)
      : this.db.prepare(sql).all(threadKey);
    return rows
      .map((row) => parseThreadSessionEntry(row))
      .filter((entry) => entry !== null);
  }
  appendThreadMessage(message) {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const conversationId = this.getThreadConversationId(threadKey);
    const payload = enforceThreadPayloadRowSizeLimit(
      buildFallbackThreadPayload(message),
    );
    let entryId = "";
    this.withImmediateTransaction(() => {
      this.upsertSession(conversationId, message.timestamp);
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        message.timestamp,
      );
      entryId = this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "message",
        timestamp: message.timestamp,
        data: {
          message: payload,
        },
      });
      this.touchThread(threadKey);
    });
    if (entryId) {
      this.options.onThreadTranscriptUpdate?.({
        conversationId,
        transcriptUpdate: {
          source: "stella",
          threadId: threadKey,
          entryId,
          atMs: message.timestamp,
        },
      });
    }
    if (payload.role === "assistant") {
      this.emitThreadAssistantUpdate(threadKey, message.timestamp);
    }
  }
  appendThreadCustomMessage(message) {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const customType = message.customType.trim();
    if (!customType) {
      throw new Error("customType is required.");
    }
    const boundedMessage = enforceCustomMessageRowSizeLimit({
      customType,
      content: message.content,
      display: message.display,
      ...(message.eventId?.trim() ? { eventId: message.eventId.trim() } : {}),
    });
    const conversationId = this.getThreadConversationId(threadKey);
    this.withImmediateTransaction(() => {
      this.upsertSession(conversationId, message.timestamp);
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        message.timestamp,
      );
      this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "custom_message",
        timestamp: message.timestamp,
        data: {
          customType: boundedMessage.customType,
          content: boundedMessage.content,
          display: boundedMessage.display,
          ...(boundedMessage.eventId
            ? { eventId: boundedMessage.eventId }
            : {}),
        },
      });
      this.touchThread(threadKey);
    });
  }
  appendThreadLifecycleEvent(message) {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const event = parseStoredThreadLifecycleEvent(message.event);
    if (!event) {
      throw new Error("A valid lifecycle event is required.");
    }
    const conversationId = this.getThreadConversationId(threadKey);
    this.withImmediateTransaction(() => {
      this.upsertSession(conversationId, event.timestamp);
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        event.timestamp,
      );
      this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "lifecycle_event",
        timestamp: event.timestamp,
        data: { event },
      });
      this.touchThread(threadKey);
    });
  }
  hasThreadLifecycleEvent(threadKeyInput, eventIdInput) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    const eventId = asTrimmedString(eventIdInput);
    if (!threadKey || !eventId) {
      return false;
    }
    const row = this.db
      .prepare(
        `
      SELECT 1 AS present
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'lifecycle_event'
        AND json_extract(data_json, '$.event._id') = ?
      LIMIT 1
    `,
      )
      .get(threadKey, eventId);
    return Boolean(row);
  }
  listThreadLifecycleEntries(threadKeyInput, limit = 300) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const normalizedLimit = Math.min(
      500,
      Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 300)),
    );
    const rows = this.db
      .prepare(
        `
      SELECT entry_id AS entryId, data_json AS dataJson
      FROM (
        SELECT entry_id, data_json, insertion_sequence, rowid
        FROM runtime_thread_entries
        WHERE thread_key = ? AND entry_type = 'lifecycle_event'
        ORDER BY insertion_sequence DESC, rowid DESC
        LIMIT ?
      ) recent
      ORDER BY insertion_sequence ASC, rowid ASC
    `,
      )
      .all(threadKey, normalizedLimit);
    return rows.flatMap((row) => {
      const data = parseJsonValue(row.dataJson);
      const event = parseStoredThreadLifecycleEvent(data?.event);
      return event ? [{ entryId: row.entryId, event }] : [];
    });
  }
  loadThreadMessages(threadKeyInput, limit) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    return buildThreadMessagesFromEntries(
      this.loadThreadSessionEntries(threadKey, limit),
    ).map((message) => ({
      ...(message.entryId ? { entryId: message.entryId } : {}),
      timestamp: message.timestamp,
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.payload ? { payload: message.payload } : {}),
      ...(message.customMessage
        ? { customMessage: message.customMessage }
        : {}),
    }));
  }
  /**
   * Newest-first sample of recent user-role messages in a thread. Used by
   * write-time transcript decoration (`agent-runtime/transcript-decoration.js`)
   * to decide whether a freshly persisted user message needs a timestamp tag —
   * the same thirty-minute suppression window the retired local-events history
   * projection applied. Content is returned so callers can skip user-role rows
   * that are not actual user utterances (e.g. voice tool results persisted with
   * role "user" and a "[Tool result]" prefix).
   */
  listRecentThreadUserMessages(threadKeyInput, limit = 8) {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      return [];
    }
    const normalizedLimit = Math.min(50, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `
      SELECT created_at AS createdAt, data_json AS dataJson
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'message'
        AND json_extract(data_json, '$.message.role') = 'user'
      ORDER BY insertion_sequence DESC, rowid DESC
      LIMIT ?
    `,
      )
      .all(threadKey, normalizedLimit);
    const results = [];
    for (const row of rows) {
      const timestamp = Number(row.createdAt);
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      let content = "";
      try {
        const parsed = JSON.parse(row.dataJson);
        const rawContent = parsed?.message?.content;
        if (typeof rawContent === "string") {
          content = rawContent;
        }
      } catch {
        // Malformed rows simply don't inform tagging.
      }
      results.push({ content, timestamp });
    }
    return results;
  }
  compactThread(args) {
    const threadKey = normalizeRuntimeThreadId(args.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const summary = args.summary.trim();
    const fromEntryId = args.fromEntryId?.trim();
    const toEntryId = args.toEntryId?.trim();
    const firstKeptEntryId = args.firstKeptEntryId?.trim();
    if (!summary || (!(fromEntryId && toEntryId) && !firstKeptEntryId)) {
      throw new Error("summary and a compaction range are required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const conversationId = this.getThreadConversationId(threadKey);
    let entryId = "";
    this.withImmediateTransaction(() => {
      const path = buildThreadPathEntries(
        this.loadThreadSessionEntries(threadKey),
      );
      const rawMessages = buildRawThreadMessages(path);
      const existingOverlays = buildThreadCompactionOverlays(path, rawMessages);
      const normalizedFromEntryId =
        existingOverlays[0]?.fromEntryId ?? fromEntryId;
      const threadSession = this.ensureThreadSession(
        threadKey,
        conversationId,
        timestamp,
      );
      entryId = this.appendThreadSessionEntry({
        threadKey,
        sessionId: threadSession.sessionId,
        entryType: "compaction",
        timestamp,
        data: {
          summary,
          ...(normalizedFromEntryId && toEntryId
            ? {
                fromEntryId: normalizedFromEntryId,
                toEntryId,
              }
            : {}),
          ...(normalizedFromEntryId || toEntryId ? {} : { firstKeptEntryId }),
          tokensBefore: Math.max(0, Math.floor(args.tokensBefore)),
          ...(args.details !== undefined ? { details: args.details } : {}),
          ...(args.fromHook ? { fromHook: true } : {}),
        },
      });
      this.touchThread(threadKey);
    });
    if (entryId) {
      this.options.onThreadTranscriptUpdate?.({
        conversationId,
        transcriptUpdate: {
          source: "stella",
          threadId: threadKey,
          entryId,
          atMs: timestamp,
        },
      });
    }
  }
  recordRunEvent(event) {
    const messageId = `run:${event.runId}:${event.seq ?? generateLocalId()}`;
    this.withTransaction(() => {
      this.upsertSession(event.conversationId, event.timestamp);
      this.db
        .prepare(
          `
        INSERT INTO message (
          id,
          session_id,
          thread_key,
          run_id,
          role,
          type,
          request_id,
          device_id,
          target_device_id,
          agent_type,
          data_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, NULL, ?, 'system', 'run_event', NULL, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          run_id = excluded.run_id,
          agent_type = excluded.agent_type,
          data_json = excluded.data_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          messageId,
          event.conversationId,
          event.runId,
          event.agentType,
          toJsonString({
            eventType: event.type,
            ...(event.seq == null ? {} : { seq: event.seq }),
          }),
          event.timestamp,
          event.timestamp,
        );
      this.replaceMessageParts(messageId, event.conversationId, [
        {
          type: "run_event",
          toolCallId: event.toolCallId,
          data: event,
          createdAt: event.timestamp,
        },
      ]);
    });
  }
  deserializeRuntimeThread(row) {
    return {
      threadId: row.threadId,
      conversationId: row.conversationId,
      name: row.name,
      agentType: row.agentType,
      status: row.status,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ...(row.agentStatus ? { agentStatus: row.agentStatus } : {}),
      ...(typeof row.agentUpdatedAt === "number"
        ? { agentUpdatedAt: row.agentUpdatedAt }
        : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
    };
  }
  static RUNTIME_THREAD_SELECT = `
      SELECT
        thread_key AS threadId,
        runtime_threads.conversation_id AS conversationId,
        runtime_threads.name AS name,
        runtime_threads.agent_type AS agentType,
        runtime_threads.status AS status,
        runtime_threads.created_at AS createdAt,
        runtime_threads.last_used_at AS lastUsedAt,
        runtime_threads.summary AS summary,
        runtime_agents.description AS description,
        runtime_agents.status AS agentStatus,
        runtime_agents.updated_at AS agentUpdatedAt
      FROM runtime_threads
      LEFT JOIN runtime_agents
        ON runtime_agents.thread_id = runtime_threads.thread_key
  `;
  listActiveThreads(conversationId) {
    // Active-thread eviction keeps this query bounded to the same cap.
    const rows = this.db
      .prepare(
        `
      ${SessionStore.RUNTIME_THREAD_SELECT}
      WHERE runtime_threads.conversation_id = ?
        AND runtime_threads.status = 'active'
      ORDER BY runtime_threads.last_used_at DESC
      LIMIT ?
    `,
      )
      .all(conversationId, MAX_ACTIVE_RUNTIME_THREADS);
    return rows.map((row) => this.deserializeRuntimeThread(row));
  }
  /**
   * Search EVERY delegated agent thread across ALL conversations —
   * including evicted ones — by key, name, summary, group label, and
   * agent description. Results from `conversationId` (the caller's
   * current conversation) sort ahead of other conversations' threads;
   * the record's own `conversationId` lets callers label which scope a
   * hit came from. A result must match at least one token and ranks by
   * how many tokens it matches (ties break newest-first). Strict AND
   * would make the verbose natural-language queries an LLM writes ("the
   * flight comparison from last week") return nothing — the one failure
   * this tool exists to prevent — so stopwords are dropped up front and
   * the rest is scored, not filtered. No query returns the most recent
   * work first. Orchestrator threads are excluded (they are the
   * conversations themselves, not work — transcript content is
   * `searchTranscripts`' job).
   *
   * Matching is backed by the `thread_search_fts` FTS5 index (see
   * database-init) so the lookup scales with match count instead of total
   * thread history, porter stemming matches word forms ("deploys" ~
   * "deploy"), and — the main quality win — the agent's final
   * `result`/`error` text is searchable, which no LIKE column ever was.
   * Missing or broken FTS is a surfaced retrieval failure. The LIKE scan is
   * available only when a caller deliberately opts into degraded mode.
   */
  searchThreads(args) {
    const limit = Math.max(1, Math.min(25, Math.floor(args.limit ?? 12)));
    const tokens = tokenizeSearchQuery(args.query);
    // No tokens means "most recent work" — a pure recency read of the base
    // table that the FTS index (matching only) has nothing to add to.
    if (tokens.length === 0) {
      return this.searchThreadsLike(args.conversationId, tokens, limit);
    }
    if (args.degradedMode === "like") {
      console.warn(
        "[stella:recall:fts-degraded]",
        JSON.stringify({ index: "threads", reason: "explicit LIKE mode" }),
      );
      return this.searchThreadsLike(args.conversationId, tokens, limit);
    }
    if (!this.threadFtsAvailable()) {
      return throwFtsSearchUnavailable("threads", "index table is missing");
    }
    try {
      return this.searchThreadsFts(args.conversationId, tokens, limit);
    } catch (error) {
      return throwFtsSearchUnavailable("threads", "MATCH query failed", error);
    }
  }
  hasThreadFts;
  threadFtsAvailable() {
    if (this.hasThreadFts === undefined) {
      try {
        this.hasThreadFts = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_search_fts'",
            )
            .get(),
        );
      } catch {
        this.hasThreadFts = false;
      }
    }
    return this.hasThreadFts;
  }
  /**
   * Two-step FTS search: the index answers WHICH threads match, the base
   * tables answer everything else. Step 1 collects candidate thread keys
   * via MATCH; step 2 re-runs the exact LIKE-scan query shape over just
   * those candidates — same eligibility clauses, same ORDER BY (scope,
   * per-token LIKE match count, recency) — so ranking semantics are
   * byte-identical to the fallback. Stemmed-only hits (which the LIKE
   * CASEs score 0) rank after literal matches within their scope, ties
   * newest-first.
   */
  searchThreadsFts(conversationId, tokens, limit) {
    // Each token becomes a quoted FTS phrase (quoting neutralizes MATCH
    // operators in user text), OR'd to keep the any-token-matches semantics.
    const matchQuery = tokens
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" OR ");
    const candidates = this.db
      .prepare(
        `
      SELECT thread_key AS threadKey
      FROM thread_search_fts
      WHERE thread_search_fts MATCH ?
      ORDER BY rank
      LIMIT ${THREAD_SEARCH_FTS_CANDIDATE_CAP}
    `,
      )
      .all(matchQuery);
    if (candidates.length === 0) return [];
    const candidateKeys = candidates.map((row) => row.threadKey);
    const escapeLike = (value) => value.replace(/([\\%_])/g, "\\$1");
    const tokenClause = `(
        thread_key LIKE ? ESCAPE '\\'
        OR runtime_threads.name LIKE ? ESCAPE '\\'
        OR runtime_threads.summary LIKE ? ESCAPE '\\'
        OR runtime_agents.description LIKE ? ESCAPE '\\'
      )`;
    // The index already enforced eligibility at write time, but the clauses
    // stay here so a stale index row can never resurrect an excluded thread.
    const where = [
      "runtime_threads.agent_type != 'orchestrator'",
      "thread_key != ?",
      "thread_key NOT LIKE '%::subagent::%'",
      `thread_key IN (${candidateKeys.map(() => "?").join(", ")})`,
    ].join("\n        AND ");
    const orderBy = `(runtime_threads.conversation_id = ?) DESC,
      (${tokens
        .map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`)
        .join(" + ")}) DESC,
      runtime_threads.last_used_at DESC`;
    const params = [conversationId, ...candidateKeys, conversationId];
    for (const token of tokens) {
      const pattern = `%${escapeLike(token)}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `
      ${SessionStore.RUNTIME_THREAD_SELECT}
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ?
    `,
      )
      .all(...params);
    return rows.map((row) => this.deserializeRuntimeThread(row));
  }
  searchThreadsLike(conversationId, tokens, limit) {
    const escapeLike = (value) => value.replace(/([\\%_])/g, "\\$1");
    const tokenClause = `(
        thread_key LIKE ? ESCAPE '\\'
        OR runtime_threads.name LIKE ? ESCAPE '\\'
        OR runtime_threads.summary LIKE ? ESCAPE '\\'
        OR runtime_agents.description LIKE ? ESCAPE '\\'
      )`;
    const where = [
      "runtime_threads.agent_type != 'orchestrator'",
      "thread_key != ?",
      // Implicit transcript rows (ephemeral workflow agents, internal
      // subagent sessions) are not orchestrator-resumable work — offering
      // them as results would hand the model dead "resumable" ids.
      "thread_key NOT LIKE '%::subagent::%'",
      ...(tokens.length > 0
        ? [`(${tokens.map(() => tokenClause).join("\n        OR ")})`]
        : []),
    ].join("\n        AND ");
    // Current-conversation hits outrank other conversations' regardless of
    // token score — the caller almost always means "my work" first, and the
    // cross-conversation tail is the fallback.
    const scopeOrder = `(runtime_threads.conversation_id = ?) DESC`;
    const orderBy =
      tokens.length > 0
        ? `${scopeOrder},
      (${tokens
        .map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`)
        .join(" + ")}) DESC,
      runtime_threads.last_used_at DESC`
        : `${scopeOrder},
      runtime_threads.last_used_at DESC`;
    const params = [conversationId];
    const pushTokenParams = () => {
      for (const token of tokens) {
        const pattern = `%${escapeLike(token)}%`;
        params.push(pattern, pattern, pattern, pattern);
      }
    };
    pushTokenParams(); // WHERE token binds,
    params.push(conversationId); // then the ORDER BY scope bind,
    pushTokenParams(); // then ORDER BY rebinds the same patterns.
    params.push(limit);
    const rows = this.db
      .prepare(
        `
      ${SessionStore.RUNTIME_THREAD_SELECT}
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ?
    `,
      )
      .all(...params);
    return rows.map((row) => this.deserializeRuntimeThread(row));
  }
  /**
   * The rows behind Recall's inline "# Thread Index": the most recent
   * `limit` delegated agent threads across ALL conversations (including
   * evicted ones), by genuine last-active time. Carries the fields the
   * index renders that the generic thread record lacks — the agent's final
   * `result` and `error` text (truncated in SQL; `summary` is empty on
   * nearly every real thread, so `result` is the only durable record of
   * what a finished thread actually did). Exclusions mirror
   * `searchThreads`: orchestrator threads and implicit subagent sessions
   * are not resumable work.
   *
   * Ordering by MAX(last_used_at, agent updated_at) can't use an index
   * directly, so the query gathers candidates from TWO indexed recency
   * scans (top `limit` by thread last_used_at, top `limit` by agent
   * updated_at) and only sorts that ≤2·limit union by the MAX. That union
   * provably contains the true top `limit` by last-active: if a thread
   * ranked top-N by the max of the two columns, it must rank top-N on
   * whichever column supplied that max. No full-table scan or whole-table
   * temp sort as history grows.
   */
  listThreadsForRecallIndex(args) {
    const limit = Math.max(1, Math.min(2_000, Math.floor(args.limit)));
    const activeSinceMs =
      Number.isFinite(args.activeSinceMs) && (args.activeSinceMs ?? 0) > 0
        ? Math.floor(args.activeSinceMs)
        : 0;
    const rows = this.db
      .prepare(
        `
      WITH candidates(thread_key) AS (
        SELECT thread_key FROM (
          SELECT thread_key
          FROM runtime_threads
          WHERE agent_type != 'orchestrator'
            AND thread_key NOT LIKE '%::subagent::%'
            AND last_used_at >= ?
          ORDER BY last_used_at DESC
          LIMIT ?
        )
        UNION
        SELECT thread_id FROM (
          SELECT thread_id
          FROM runtime_agents
          WHERE agent_type != 'orchestrator'
            AND thread_id NOT LIKE '%::subagent::%'
            AND updated_at >= ?
          ORDER BY updated_at DESC
          LIMIT ?
        )
      )
      SELECT
        thread_key AS threadId,
        runtime_threads.conversation_id AS conversationId,
        runtime_threads.name AS name,
        runtime_threads.created_at AS createdAt,
        runtime_threads.last_used_at AS lastUsedAt,
        runtime_agents.description AS description,
        runtime_agents.status AS agentStatus,
        runtime_agents.updated_at AS agentUpdatedAt,
        substr(runtime_agents.result, 1, ${RECALL_INDEX_RESULT_EXCERPT_CHARS}) AS resultExcerpt,
        substr(runtime_agents.error, 1, ${RECALL_INDEX_ERROR_EXCERPT_CHARS}) AS errorExcerpt
      FROM runtime_threads
      LEFT JOIN runtime_agents
        ON runtime_agents.thread_id = runtime_threads.thread_key
      WHERE thread_key IN (SELECT thread_key FROM candidates)
        AND runtime_threads.agent_type != 'orchestrator'
        AND thread_key NOT LIKE '%::subagent::%'
        AND MAX(
          runtime_threads.last_used_at,
          COALESCE(runtime_agents.updated_at, 0)
        ) >= ?
      ORDER BY MAX(
        runtime_threads.last_used_at,
        COALESCE(runtime_agents.updated_at, 0)
      ) DESC
      LIMIT ?
    `,
      )
      .all(activeSinceMs, limit, activeSinceMs, limit, activeSinceMs, limit);
    return rows.map((row) => ({
      threadId: row.threadId,
      conversationId: row.conversationId,
      name: row.name,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ...(row.description ? { description: row.description } : {}),
      ...(row.agentStatus ? { agentStatus: row.agentStatus } : {}),
      ...(typeof row.agentUpdatedAt === "number"
        ? { agentUpdatedAt: row.agentUpdatedAt }
        : {}),
      ...(row.resultExcerpt?.trim()
        ? { resultExcerpt: row.resultExcerpt }
        : {}),
      ...(row.errorExcerpt?.trim() ? { errorExcerpt: row.errorExcerpt } : {}),
    }));
  }
  /**
   * Final result/error excerpts for a set of threads, keyed by thread id.
   * Recall's thread search renders these because `summary` is empty on
   * nearly every real thread — the agent's final `result` is the only
   * durable record of what a finished thread actually did.
   */
  listThreadResultExcerpts(threadIds) {
    const ids = [...new Set(threadIds)].slice(0, 64);
    const map = new Map();
    if (ids.length === 0) return map;
    const rows = this.db
      .prepare(
        `
      SELECT
        thread_id AS threadId,
        substr(result, 1, ${RECALL_INDEX_RESULT_EXCERPT_CHARS}) AS resultExcerpt,
        substr(error, 1, ${RECALL_INDEX_ERROR_EXCERPT_CHARS}) AS errorExcerpt
      FROM runtime_agents
      WHERE thread_id IN (${ids.map(() => "?").join(", ")})
    `,
      )
      .all(...ids);
    for (const row of rows) {
      map.set(row.threadId, {
        ...(row.resultExcerpt?.trim()
          ? { resultExcerpt: row.resultExcerpt }
          : {}),
        ...(row.errorExcerpt?.trim() ? { errorExcerpt: row.errorExcerpt } : {}),
      });
    }
    return map;
  }
  /**
   * How many index-eligible threads were created since `sinceMs` — the
   * cheap signal Recall uses to size its thread index (a high-volume day
   * widens the index so heavy users keep their realistic recall window).
   * `idx_runtime_threads_created` makes this a range scan over just the
   * recent window (the eligibility filters apply as residuals on those few
   * rows), so the preflight scales with daily volume, not total history.
   */
  countThreadsCreatedSince(sinceMs) {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM runtime_threads
      WHERE agent_type != 'orchestrator'
        AND thread_key NOT LIKE '%::subagent::%'
        AND created_at >= ?
    `,
      )
      .get(sinceMs);
    return typeof row?.count === "number" ? row.count : 0;
  }
  /**
   * Search what was actually SAID in chat: user/assistant message text
   * across ALL conversations (not just the caller's). This is the only
   * durable index over things the user merely mentioned in conversation —
   * no agent thread, no memory note — so it is what answers episodic
   * questions ("did I ever tell you…", "where did we…"). Same
   * OR-with-ranking token semantics as `searchThreads`: a hit must match
   * at least one non-stopword token, ranks by how many tokens it matches,
   * ties break newest-first. Matching runs against the extracted `$.text`
   * of each chat payload, never the raw JSON, so attachments/base64 and
   * metadata cannot produce false hits.
   *
   * Backed by the `message_text_fts` FTS5 index (see database-init) so the
   * lookup scales with match count, not history size, and porter stemming
   * matches word forms ("drive" ~ "drives"). Missing or broken FTS is a
   * surfaced retrieval failure; LIKE requires an explicit degraded-mode opt-in.
   */
  searchTranscripts(args) {
    const limit = Math.max(1, Math.min(25, Math.floor(args.limit ?? 12)));
    const tokens = tokenizeSearchQuery(args.query);
    if (tokens.length === 0) return [];
    if (args.degradedMode === "like") {
      console.warn(
        "[stella:recall:fts-degraded]",
        JSON.stringify({ index: "transcripts", reason: "explicit LIKE mode" }),
      );
      return this.searchTranscriptsLike(tokens, limit);
    }
    if (!this.transcriptFtsAvailable()) {
      return throwFtsSearchUnavailable("transcripts", "index table is missing");
    }
    try {
      return this.searchTranscriptsFts(tokens, limit);
    } catch (error) {
      return throwFtsSearchUnavailable(
        "transcripts",
        "MATCH query failed",
        error,
      );
    }
  }
  hasTranscriptFts;
  transcriptFtsAvailable() {
    if (this.hasTranscriptFts === undefined) {
      try {
        this.hasTranscriptFts = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_text_fts'",
            )
            .get(),
        );
      } catch {
        this.hasTranscriptFts = false;
      }
    }
    return this.hasTranscriptFts;
  }
  searchTranscriptsFts(tokens, limit) {
    // Each token becomes a quoted FTS phrase (quoting neutralizes MATCH
    // operators in user text), OR'd to keep the any-token-matches
    // semantics. The matched-token count for RANKING is computed with the
    // same LIKE test the scan used — but only over the FTS matches, never
    // the whole table — so ordering is unchanged: more matched tokens
    // first, ties newest-first.
    const matchQuery = tokens
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" OR ");
    const escapeLike = (value) => value.replace(/([\\%_])/g, "\\$1");
    const tokenClause = `text LIKE ? ESCAPE '\\'`;
    const rows = this.db
      .prepare(
        `
      SELECT
        session_id AS conversationId,
        role,
        created_at AS atMs,
        substr(text, 1, ${TRANSCRIPT_SEARCH_TEXT_CAP}) AS text
      FROM message_text_fts
      WHERE message_text_fts MATCH ?
      ORDER BY
        (${tokens
          .map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`)
          .join(" + ")}) DESC,
        created_at DESC
      LIMIT ?
    `,
      )
      .all(
        matchQuery,
        ...tokens.map((token) => `%${escapeLike(token)}%`),
        limit,
      );
    return this.deserializeTranscriptHits(rows);
  }
  searchTranscriptsLike(tokens, limit) {
    const escapeLike = (value) => value.replace(/([\\%_])/g, "\\$1");
    const textExpr = `json_extract(part.data_json, '$.text')`;
    const tokenClause = `${textExpr} LIKE ? ESCAPE '\\'`;
    const rows = this.db
      .prepare(
        `
      SELECT
        message.session_id AS conversationId,
        message.role AS role,
        message.created_at AS atMs,
        substr(${textExpr}, 1, ${TRANSCRIPT_SEARCH_TEXT_CAP}) AS text
      FROM message
      JOIN part ON part.message_id = message.id
      WHERE message.role IN ('user', 'assistant')
        AND message.type IN ('user_message', 'assistant_message')
        AND ${textExpr} IS NOT NULL
        AND (${tokens.map(() => tokenClause).join("\n          OR ")})
      ORDER BY
        (${tokens
          .map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`)
          .join(" + ")}) DESC,
        message.created_at DESC
      LIMIT ?
    `,
      )
      .all(
        ...tokens.map((token) => `%${escapeLike(token)}%`), // WHERE binds,
        ...tokens.map((token) => `%${escapeLike(token)}%`), // ORDER BY rebinds.
        limit,
      );
    return this.deserializeTranscriptHits(rows);
  }
  deserializeTranscriptHits(rows) {
    return rows.flatMap((row) => {
      const text = typeof row.text === "string" ? row.text.trim() : "";
      if (!text) return [];
      return [
        {
          conversationId: row.conversationId,
          role: row.role === "assistant" ? "assistant" : "user",
          atMs: row.atMs,
          text,
        },
      ];
    });
  }
  /**
   * The chat messages immediately surrounding a `searchTranscripts` hit, in
   * chronological order (excluding the hit itself). Keyword search finds the
   * message that NAMES the thing; the messages around it are usually what
   * actually happened ("give me the address" → drove there → "damn i love
   * the car"), so recall renders a hit's neighbors as its evidence context.
   */
  listTranscriptNeighbors(args) {
    const before = Math.max(0, Math.min(8, Math.floor(args.before ?? 2)));
    const after = Math.max(0, Math.min(10, Math.floor(args.after ?? 2)));
    // The follow-through to a matched message ("give me the address" → drove
    // there → reaction) routinely lands tens of minutes later, so the
    // episode boundary is a time window, not just a message count.
    const windowMs = Math.max(60_000, args.windowMs ?? 2 * 60 * 60 * 1000);
    const textExpr = `json_extract(part.data_json, '$.text')`;
    const base = `
      SELECT
        message.session_id AS conversationId,
        message.role AS role,
        message.created_at AS atMs,
        substr(${textExpr}, 1, ${TRANSCRIPT_SEARCH_TEXT_CAP}) AS text
      FROM message
      JOIN part ON part.message_id = message.id
      WHERE message.session_id = ?
        AND message.role IN ('user', 'assistant')
        AND message.type IN ('user_message', 'assistant_message')
        AND ${textExpr} IS NOT NULL
    `;
    const rows = [
      ...(before > 0
        ? this.db
            .prepare(
              `${base} AND message.created_at < ? AND message.created_at >= ?
               ORDER BY message.created_at DESC LIMIT ?`,
            )
            .all(args.conversationId, args.atMs, args.atMs - windowMs, before)
        : []),
      ...(after > 0
        ? this.db
            .prepare(
              `${base} AND message.created_at > ? AND message.created_at <= ?
               ORDER BY message.created_at ASC LIMIT ?`,
            )
            .all(args.conversationId, args.atMs, args.atMs + windowMs, after)
        : []),
    ];
    return rows
      .flatMap((row) => {
        const text = typeof row.text === "string" ? row.text.trim() : "";
        if (!text) return [];
        return [
          {
            conversationId: row.conversationId,
            role: row.role === "assistant" ? "assistant" : "user",
            atMs: row.atMs,
            text,
          },
        ];
      })
      .sort((a, b) => a.atMs - b.atMs);
  }
  listActiveThreadsByAge(conversationId) {
    return this.db
      .prepare(
        `
      SELECT
        thread_key AS threadId,
        last_used_at AS lastUsedAt
      FROM runtime_threads
      WHERE conversation_id = ?
        AND status = 'active'
      ORDER BY last_used_at ASC, thread_key ASC
    `,
      )
      .all(conversationId);
  }
  evictOldestThread(conversationId) {
    const oldest = this.listActiveThreadsByAge(conversationId)[0];
    if (!oldest) return;
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET status = 'evicted'
      WHERE conversation_id = ?
        AND status = 'active'
        AND thread_key = ?
    `,
      )
      .run(conversationId, oldest.threadId);
  }
  reactivateThread(conversationId, threadId) {
    if (
      this.listActiveThreadsByAge(conversationId).length >=
      MAX_ACTIVE_RUNTIME_THREADS
    ) {
      this.evictOldestThread(conversationId);
    }
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET status = 'active'
      WHERE conversation_id = ?
        AND thread_key = ?
    `,
      )
      .run(conversationId, threadId);
  }
  threadKeyExists(key) {
    const row = this.db
      .prepare(
        `
      SELECT 1 AS hit
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(key);
    return Boolean(row);
  }
  /** Mint a globally unique thread key, suffixing collisions with -2, -3, …. */
  mintUniqueKey(base) {
    if (!this.threadKeyExists(base)) return base;
    for (let ordinal = 2; ; ordinal++) {
      const candidate = `${base}-${ordinal}`;
      if (!this.threadKeyExists(candidate)) return candidate;
    }
  }
  mintThreadKey(args) {
    const slug = slugify(args.nameHint ?? "");
    // `legacy-` is the seeded feature roster's id namespace
    // (store-mod-store.ts); a thread key landing there would merge unrelated
    // identities downstream.
    if (slug && !slug.startsWith("legacy-")) {
      return this.mintUniqueKey(slug);
    }
    // Fallback for descriptions that slug to nothing (emoji, non-Latin
    // scripts): the historical per-agent-type ordinal.
    const prefix = "task-";
    const rows = this.db
      .prepare(
        `
      SELECT thread_key AS threadId
      FROM runtime_threads
      WHERE agent_type = ?
    `,
      )
      .all(args.agentType);
    let nextOrdinal = 1;
    for (const row of rows) {
      if (!row.threadId.startsWith(prefix)) continue;
      const suffix = Number.parseInt(row.threadId.slice(prefix.length), 10);
      if (Number.isFinite(suffix) && suffix >= nextOrdinal) {
        nextOrdinal = suffix + 1;
      }
    }
    return this.mintUniqueKey(`${prefix}${nextOrdinal}`);
  }
  resolveOrCreateActiveThread(args) {
    const requestedThreadId = normalizeRuntimeThreadId(args.threadId ?? "");
    const existing = requestedThreadId
      ? this.db
          .prepare(
            `
        SELECT
          thread_key AS threadId,
          conversation_id AS conversationId,
          agent_type AS agentType,
          status
        FROM runtime_threads
        WHERE thread_key = ?
        LIMIT 1
      `,
          )
          .get(requestedThreadId)
      : undefined;
    if (existing) {
      if (
        existing.conversationId !== args.conversationId ||
        existing.agentType !== args.agentType
      ) {
        throw new Error(
          `Thread ${existing.threadId} belongs to a different conversation or agent type.`,
        );
      }
      if (existing.status !== "active") {
        this.reactivateThread(args.conversationId, existing.threadId);
      }
      this.touchThread(existing.threadId);
      return {
        threadId: existing.threadId,
        reused: true,
      };
    }
    if (
      this.listActiveThreadsByAge(args.conversationId).length >=
      MAX_ACTIVE_RUNTIME_THREADS
    ) {
      this.evictOldestThread(args.conversationId);
    }
    const threadId =
      requestedThreadId ??
      this.mintThreadKey({
        agentType: args.agentType,
        ...(args.nameHint ? { nameHint: args.nameHint } : {}),
      });
    const name =
      args.nameHint?.trim().replace(/\s+/g, " ").slice(0, 200) || threadId;
    const now = Date.now();
    this.upsertSession(args.conversationId, now);
    this.db
      .prepare(
        `
      INSERT INTO runtime_threads (
        thread_key,
        conversation_id,
        agent_type,
        name,
        status,
        created_at,
        last_used_at,
        summary
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
    `,
      )
      .run(threadId, args.conversationId, args.agentType, name, now, now);
    return {
      threadId,
      reused: false,
    };
  }
  touchThread(threadKey) {
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET last_used_at = ?
      WHERE thread_key = ?
    `,
      )
      .run(Date.now(), threadKey);
  }
  getThreadExternalSessionId(threadKey) {
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db
      .prepare(
        `
      SELECT external_session_id AS externalSessionId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey);
    return typeof row?.externalSessionId === "string" &&
      row.externalSessionId.trim().length > 0
      ? row.externalSessionId.trim()
      : undefined;
  }
  setThreadExternalSessionId(threadKey, externalSessionId) {
    this.ensureImplicitThreadRow(threadKey);
    const normalized =
      typeof externalSessionId === "string" &&
      externalSessionId.trim().length > 0
        ? externalSessionId.trim()
        : null;
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET external_session_id = ?, last_used_at = ?
      WHERE thread_key = ?
    `,
      )
      .run(normalized, Date.now(), threadKey);
  }
  updateThreadSummary(threadKey, summary) {
    const trimmed = summary.trim();
    if (!trimmed) return;
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db
      .prepare(
        `
      SELECT conversation_id AS conversationId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey);
    this.db
      .prepare(
        `
      UPDATE runtime_threads
      SET summary = ?, last_used_at = ?
      WHERE thread_key = ?
    `,
      )
      .run(trimmed, Date.now(), threadKey);
    if (
      typeof row?.conversationId === "string" &&
      row.conversationId.length > 0
    ) {
      this.forceOrchestratorReminderOnNextTurn(row.conversationId);
    }
  }
  getThreadName(threadKey) {
    // Deliberately side-effect-free: callers probe arbitrary agent ids, and
    // creating implicit rows for
    // them would leak phantom threads into search results.
    const row = this.db
      .prepare(
        `
      SELECT name
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(threadKey);
    return typeof row?.name === "string" && row.name.length > 0
      ? row.name
      : undefined;
  }
  saveAgentRecord(record) {
    this.upsertSession(record.conversationId, record.updatedAt);
    this.db
      .prepare(
        `
      INSERT INTO runtime_agents (
        thread_id,
        conversation_id,
        agent_type,
        description,
        prompt,
        prompt_created_at,
        agent_depth,
        max_agent_depth,
        parent_agent_id,
        model_config_json,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at,
        root_run_id,
        attempt_generation
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        agent_type = excluded.agent_type,
        description = excluded.description,
        prompt = COALESCE(runtime_agents.prompt, excluded.prompt),
        prompt_created_at = COALESCE(runtime_agents.prompt_created_at, excluded.prompt_created_at),
        agent_depth = excluded.agent_depth,
        max_agent_depth = excluded.max_agent_depth,
        parent_agent_id = excluded.parent_agent_id,
        model_config_json = excluded.model_config_json,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        result = excluded.result,
        error = excluded.error,
        updated_at = excluded.updated_at,
        root_run_id = excluded.root_run_id,
        attempt_generation = excluded.attempt_generation
    `,
      )
      .run(
        record.threadId,
        record.conversationId,
        record.agentType,
        record.description,
        record.prompt ?? null,
        record.promptCreatedAt ?? null,
        record.agentDepth,
        record.maxAgentDepth ?? null,
        record.parentAgentId ?? null,
        toJsonValueString(record.modelConfigSnapshot) ?? null,
        record.status,
        record.startedAt,
        record.completedAt ?? null,
        record.result ?? null,
        record.error ?? null,
        record.updatedAt,
        record.rootRunId ?? null,
        record.attemptGeneration ?? 0,
      );
  }
  listAgentAssistantMessagesByThread(
    targetsInput,
    limit = AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
  ) {
    const seen = new Set();
    const targets = targetsInput
      .flatMap((target) => {
        const threadId = target.threadId.trim();
        if (!threadId || seen.has(threadId)) return [];
        seen.add(threadId);
        return [
          {
            threadId,
            startedAt: Math.max(0, Math.floor(target.startedAt)),
            attemptGeneration: Math.max(
              0,
              Math.floor(target.attemptGeneration ?? 0),
            ),
          },
        ];
      })
      .slice(0, AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads);
    if (targets.length === 0) return new Map();
    const cappedLimit = Math.max(
      1,
      Math.min(
        AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
        Math.floor(limit),
      ),
    );
    const scanLimit =
      cappedLimit * AGENT_ASSISTANT_UPDATE_LIMITS.scanRowsPerMessage;
    const byThread = new Map();
    let remainingChars = AGENT_ASSISTANT_UPDATE_LIMITS.totalChars;
    let remainingBytes = AGENT_ASSISTANT_UPDATE_LIMITS.totalBytes;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      const rows = this.db
        .prepare(
          `
          SELECT created_at AS atMs, insertion_sequence AS sequence, data_json AS dataJson
          FROM runtime_thread_entries
          WHERE thread_key = ?
            AND created_at >= ?
            AND entry_type = 'message'
            AND json_extract(data_json, '$.message.role') = 'assistant'
            AND COALESCE(json_extract(data_json, '$.message.stellaAttemptGeneration'), ?) = ?
          ORDER BY insertion_sequence DESC, rowid DESC
          LIMIT ?
        `,
        )
        .all(
          target.threadId,
          target.startedAt,
          target.attemptGeneration,
          target.attemptGeneration,
          scanLimit,
        );
      const candidates = [];
      for (const row of rows) {
        let payload;
        try {
          payload = JSON.parse(row.dataJson ?? "null")?.message;
        } catch {
          continue;
        }
        if (payload?.role !== "assistant") continue;
        const text = truncateAuthoredUpdate(
          authoredTextFromAssistantPayload(payload),
        );
        if (text)
          candidates.push({ text, atMs: row.atMs, sequence: row.sequence });
        if (candidates.length >= cappedLimit) break;
      }
      if (candidates.length === 0) continue;
      const targetsRemaining = Math.max(1, targets.length - targetIndex);
      let threadChars = 0;
      let threadBytes = 0;
      const selectedNewestFirst = [];
      for (const candidate of candidates) {
        const fairChars = Math.max(
          1,
          Math.floor(remainingChars / targetsRemaining),
        );
        const fairBytes = Math.max(
          1,
          Math.floor(remainingBytes / targetsRemaining),
        );
        const text = truncateAuthoredUpdate(
          candidate.text,
          Math.min(
            AGENT_ASSISTANT_UPDATE_LIMITS.messageChars,
            AGENT_ASSISTANT_UPDATE_LIMITS.threadChars - threadChars,
            fairChars,
          ),
          Math.min(
            AGENT_ASSISTANT_UPDATE_LIMITS.messageBytes,
            AGENT_ASSISTANT_UPDATE_LIMITS.threadBytes - threadBytes,
            fairBytes,
          ),
        );
        if (!text) continue;
        const chars = [...text].length;
        const bytes = Buffer.byteLength(text, "utf8");
        selectedNewestFirst.push({ ...candidate, text });
        threadChars += chars;
        threadBytes += bytes;
        remainingChars -= chars;
        remainingBytes -= bytes;
        if (remainingChars <= 0 || remainingBytes <= 0) break;
      }
      if (selectedNewestFirst.length > 0)
        byThread.set(target.threadId, selectedNewestFirst.reverse());
    }
    return byThread;
  }
  listAgentAssistantMessages(
    agentId,
    limit = AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
  ) {
    const record = this.getAgentRecord(agentId.trim());
    if (
      !record ||
      record.status !== "running" ||
      record.agentType !== "general"
    )
      return [];
    return (
      this.listAgentAssistantMessagesByThread(
        [
          {
            threadId: record.threadId,
            startedAt: record.startedAt,
            attemptGeneration: record.attemptGeneration,
          },
        ],
        limit,
      ).get(record.threadId) ?? []
    ).map(({ text, atMs }) => ({ text, atMs }));
  }
  emitThreadAssistantUpdate(threadId, atMs) {
    if (!this.options.onThreadAssistantUpdate) return;
    const record = this.getAgentRecord(threadId);
    if (
      !record ||
      record.status !== "running" ||
      record.agentType !== "general" ||
      atMs < record.startedAt
    )
      return;
    const entries =
      this.listAgentAssistantMessagesByThread([
        {
          threadId: record.threadId,
          startedAt: record.startedAt,
          attemptGeneration: record.attemptGeneration,
        },
      ]).get(record.threadId) ?? [];
    const latest = entries[entries.length - 1];
    if (!latest) return;
    const assistantMessages = entries.map((entry) => entry.text);
    this.options.onThreadAssistantUpdate({
      conversationId: record.conversationId,
      assistantUpdate: {
        threadId: record.threadId,
        assistantMessages,
        reasoningSummaries: [...assistantMessages],
        latestMessage: latest.text,
        atMs: latest.atMs,
        atSequence: latest.sequence,
        attemptGeneration: record.attemptGeneration,
        ...(record.rootRunId ? { rootRunId: record.rootRunId } : {}),
      },
    });
  }
  getAgentRecord(threadId) {
    const row = this.db
      .prepare(
        `
      SELECT
        thread_id,
        conversation_id,
        agent_type,
        description,
        prompt,
        prompt_created_at,
        agent_depth,
        max_agent_depth,
        parent_agent_id,
        model_config_json,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at,
        root_run_id,
        attempt_generation
      FROM runtime_agents
      WHERE thread_id = ?
      LIMIT 1
    `,
      )
      .get(threadId);
    if (!row) {
      return null;
    }
    const modelConfigSnapshot = parseJsonValue(row.model_config_json);
    return {
      threadId: row.thread_id,
      conversationId: row.conversation_id,
      agentType: normalizeRetiredAgentType(row.agent_type),
      description: row.description,
      ...(row.prompt
        ? {
            prompt: row.prompt,
            promptCreatedAt:
              typeof row.prompt_created_at === "number"
                ? row.prompt_created_at
                : row.started_at,
          }
        : {}),
      agentDepth: row.agent_depth,
      ...(row.max_agent_depth == null
        ? {}
        : { maxAgentDepth: row.max_agent_depth }),
      ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
      ...(modelConfigSnapshot ? { modelConfigSnapshot } : {}),
      status: row.status,
      attemptGeneration: row.attempt_generation,
      ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      ...(row.result ? { result: row.result } : {}),
      ...(row.error ? { error: row.error } : {}),
      updatedAt: row.updated_at,
    };
  }
  listAgentRecordsByStatus(status) {
    const rows = this.db
      .prepare(
        `
      SELECT
        thread_id,
        conversation_id,
        agent_type,
        description,
        prompt,
        prompt_created_at,
        agent_depth,
        max_agent_depth,
        parent_agent_id,
        model_config_json,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at,
        root_run_id,
        attempt_generation
      FROM runtime_agents
      WHERE status = ?
      ORDER BY updated_at DESC, thread_id ASC
    `,
      )
      .all(status);
    return rows.map((row) => {
      const modelConfigSnapshot = parseJsonValue(row.model_config_json);
      return {
        threadId: row.thread_id,
        conversationId: row.conversation_id,
        agentType: normalizeRetiredAgentType(row.agent_type),
        description: row.description,
        ...(row.prompt
          ? {
              prompt: row.prompt,
              promptCreatedAt:
                typeof row.prompt_created_at === "number"
                  ? row.prompt_created_at
                  : row.started_at,
            }
          : {}),
        agentDepth: row.agent_depth,
        ...(row.max_agent_depth == null
          ? {}
          : { maxAgentDepth: row.max_agent_depth }),
        ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
        ...(modelConfigSnapshot ? { modelConfigSnapshot } : {}),
        status: row.status,
        attemptGeneration: row.attempt_generation,
        ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
        startedAt: row.started_at,
        completedAt: row.completed_at,
        ...(row.result ? { result: row.result } : {}),
        ...(row.error ? { error: row.error } : {}),
        updatedAt: row.updated_at,
      };
    });
  }
  /**
   * Authoritative Activity read: one row per background-agent thread in the
   * conversation, straight from `runtime_agents` (the single writer is the
   * LocalAgentManager's `persistTask`). Ordered oldest-started first — the renderer sorts for
   * display. Truncated result/error previews keep the wire payload small;
   * the full result still rides the completion chat card.
   */
  listThreadActivity(conversationId) {
    const rows = this.db
      .prepare(
        `
      SELECT
        a.thread_id,
        a.conversation_id,
        a.agent_type,
        a.description,
        a.status,
        a.attempt_generation,
        a.parent_agent_id,
        a.model_config_json,
        a.started_at,
        a.completed_at,
        substr(a.result, 1, 2000) AS result,
        substr(a.error, 1, 2000) AS error,
        a.updated_at,
        a.root_run_id,
        t.group_key,
        t.group_label
      FROM runtime_agents a
      LEFT JOIN runtime_threads t ON t.thread_key = a.thread_id
      WHERE a.conversation_id = ?
      ORDER BY a.started_at ASC, a.thread_id ASC
    `,
      )
      .all(conversationId);
    const assistantTargets = rows
      .filter((row) => normalizeRetiredAgentType(row.agent_type) === "general")
      .sort(
        (a, b) =>
          Number(b.status === "running") - Number(a.status === "running") ||
          b.updated_at - a.updated_at ||
          a.thread_id.localeCompare(b.thread_id),
      )
      .slice(0, AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads)
      .map((row) => ({
        threadId: row.thread_id,
        startedAt: row.started_at,
        attemptGeneration: row.attempt_generation ?? 0,
      }));
    const assistantMessagesByThread =
      this.listAgentAssistantMessagesByThread(assistantTargets);
    return rows.map((row) => {
      const assistantEntries = assistantMessagesByThread.get(row.thread_id);
      const latestAssistantEntry =
        assistantEntries?.[assistantEntries.length - 1];
      const modelConfigSnapshot = parseJsonValue(row.model_config_json);
      return {
        source: "stella",
        threadId: row.thread_id,
        conversationId: row.conversation_id,
        agentType: normalizeRetiredAgentType(row.agent_type),
        description: row.description,
        status: row.status,
        attemptGeneration: row.attempt_generation ?? 0,
        ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
        ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
        ...(modelConfigSnapshot ? { modelConfigSnapshot } : {}),
        ...(row.group_key ? { groupKey: row.group_key } : {}),
        ...(row.group_label ? { groupLabel: row.group_label } : {}),
        startedAt: row.started_at,
        ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
        ...(row.result ? { result: row.result } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(assistantEntries
          ? {
              assistantMessages: assistantEntries.map((entry) => entry.text),
              ...(latestAssistantEntry
                ? {
                    assistantMessagesUpdatedAt: latestAssistantEntry.atMs,
                    assistantMessagesUpdatedSequence:
                      latestAssistantEntry.sequence,
                  }
                : {}),
            }
          : {}),
        updatedAt: row.updated_at,
      };
    });
  }
  getOrchestratorReminderState(conversationId) {
    const row = this.db
      .prepare(
        `
      SELECT
        reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection,
        force_reminder_on_next_turn AS forceReminderOnNextTurn
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `,
      )
      .get(conversationId);
    const current =
      typeof row?.reminderTokensSinceLastInjection === "number"
        ? Math.max(0, Math.floor(row.reminderTokensSinceLastInjection))
        : 0;
    const shouldInjectDynamicReminder = row?.forceReminderOnNextTurn === 1;
    return {
      shouldInjectDynamicReminder,
      reminderTokensSinceLastInjection: current,
    };
  }
  updateOrchestratorReminderCounter(args) {
    const currentState = this.db
      .prepare(
        `
      SELECT
        reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection,
        force_reminder_on_next_turn AS forceReminderOnNextTurn
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `,
      )
      .get(args.conversationId);
    const current =
      typeof currentState?.reminderTokensSinceLastInjection === "number"
        ? currentState.reminderTokensSinceLastInjection
        : 0;
    const nextValue =
      args.resetTo != null
        ? Math.max(0, Math.floor(args.resetTo))
        : Math.max(0, Math.floor(current + (args.incrementBy ?? 0)));
    const forceReminderOnNextTurn =
      args.resetTo != null
        ? 0
        : currentState?.forceReminderOnNextTurn === 1
          ? 1
          : 0;
    this.db
      .prepare(
        `
      INSERT INTO runtime_conversation_state (
        conversation_id,
        reminder_tokens_since_last_injection,
        force_reminder_on_next_turn
      )
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        reminder_tokens_since_last_injection = excluded.reminder_tokens_since_last_injection,
        force_reminder_on_next_turn = excluded.force_reminder_on_next_turn
    `,
      )
      .run(args.conversationId, nextValue, forceReminderOnNextTurn);
  }
  forceOrchestratorReminderOnNextTurn(conversationId) {
    const currentState = this.db
      .prepare(
        `
      SELECT reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `,
      )
      .get(conversationId);
    const reminderTokensSinceLastInjection =
      typeof currentState?.reminderTokensSinceLastInjection === "number"
        ? currentState.reminderTokensSinceLastInjection
        : 0;
    this.db
      .prepare(
        `
      INSERT INTO runtime_conversation_state (
        conversation_id,
        reminder_tokens_since_last_injection,
        force_reminder_on_next_turn
      )
      VALUES (?, ?, 1)
      ON CONFLICT(conversation_id) DO UPDATE SET
        reminder_tokens_since_last_injection = excluded.reminder_tokens_since_last_injection,
        force_reminder_on_next_turn = 1
    `,
      )
      .run(conversationId, reminderTokensSinceLastInjection);
  }
  /**
   * Increment the memory-review user-turn counter for the given conversation
   * and return the new value. Caller is responsible for gating on
   * `uiVisibility !== "hidden"` so that synthetic task-callback turns do not
   * inflate the count.
   */
  incrementUserTurnsSinceMemoryReview(conversationId) {
    const row = this.db
      .prepare(
        `
      SELECT user_turns_since_review AS userTurnsSinceReview
      FROM runtime_memory_review_state
      WHERE conversation_id = ?
      LIMIT 1
    `,
      )
      .get(conversationId);
    const current =
      typeof row?.userTurnsSinceReview === "number"
        ? Math.max(0, Math.floor(row.userTurnsSinceReview))
        : 0;
    const next = current + 1;
    this.db
      .prepare(
        `
      INSERT INTO runtime_memory_review_state (
        conversation_id,
        user_turns_since_review,
        last_review_at
      )
      VALUES (?, ?, NULL)
      ON CONFLICT(conversation_id) DO UPDATE SET
        user_turns_since_review = excluded.user_turns_since_review
    `,
      )
      .run(conversationId, next);
    return next;
  }
  /**
   * Current memory-review state for a conversation. `lastReviewedMessageTs`
   * is the timestamp of the newest message the last review consumed; the
   * review pass slices the transcript to messages newer than this so each
   * pass only sees the delta since the previous review. It is a message
   * timestamp (a value), not an array index, so it stays valid across
   * compaction rebuilds and worker restarts.
   */
  getMemoryReviewState(conversationId) {
    const row = this.db
      .prepare(
        `
      SELECT user_turns_since_review AS userTurnsSinceReview,
             last_reviewed_message_ts AS lastReviewedMessageTs
      FROM runtime_memory_review_state
      WHERE conversation_id = ?
      LIMIT 1
    `,
      )
      .get(conversationId);
    return {
      userTurnsSinceReview:
        typeof row?.userTurnsSinceReview === "number"
          ? Math.max(0, Math.floor(row.userTurnsSinceReview))
          : 0,
      lastReviewedMessageTs:
        typeof row?.lastReviewedMessageTs === "number"
          ? Math.max(0, Math.floor(row.lastReviewedMessageTs))
          : 0,
    };
  }
  /**
   * Reset the memory-review user-turn counter to zero and stamp the time of
   * the review. Call after a memory review fires so a quick second turn does
   * not double-trigger. When `lastReviewedMessageTs` is provided it advances
   * the review watermark so the next pass only reviews newer messages; when
   * omitted the existing watermark is preserved (never silently cleared).
   */
  resetUserTurnsSinceMemoryReview(conversationId, lastReviewedMessageTs) {
    const now = Date.now();
    const reviewedTs =
      typeof lastReviewedMessageTs === "number" &&
      Number.isFinite(lastReviewedMessageTs) &&
      lastReviewedMessageTs > 0
        ? Math.floor(lastReviewedMessageTs)
        : null;
    this.db
      .prepare(
        `
      INSERT INTO runtime_memory_review_state (
        conversation_id,
        user_turns_since_review,
        last_review_at,
        last_reviewed_message_ts
      )
      VALUES (?, 0, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        user_turns_since_review = 0,
        last_review_at = excluded.last_review_at,
        last_reviewed_message_ts = COALESCE(
          excluded.last_reviewed_message_ts,
          runtime_memory_review_state.last_reviewed_message_ts
        )
    `,
      )
      .run(conversationId, now, reviewedTs);
  }
  /**
   * Advance only the review watermark, without touching the user-turn counter.
   * Called after a review actually completes so a transient review failure does
   * not permanently skip the messages it failed on. Never regresses an existing
   * watermark.
   */
  advanceMemoryReviewWatermark(conversationId, lastReviewedMessageTs) {
    if (!Number.isFinite(lastReviewedMessageTs) || lastReviewedMessageTs <= 0) {
      return;
    }
    const reviewedTs = Math.floor(lastReviewedMessageTs);
    this.db
      .prepare(
        `
      INSERT INTO runtime_memory_review_state (
        conversation_id,
        user_turns_since_review,
        last_reviewed_message_ts
      )
      VALUES (?, 0, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_reviewed_message_ts = MAX(
          COALESCE(runtime_memory_review_state.last_reviewed_message_ts, 0),
          excluded.last_reviewed_message_ts
        )
    `,
      )
      .run(conversationId, reviewedTs);
  }
}
