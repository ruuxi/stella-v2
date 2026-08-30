/**
 * Pure projection and view helpers for the storage layer.
 *
 * Everything in this file is a pure function over already-loaded rows:
 * payload previews, row-size bounding, eager-event projection, compaction
 * checkpoint splicing, and search tokenization. No SQL lives here.
 */

import type {
  AssistantMessage,
  ImageContent,
  TextContent,
} from "../../ai/types.js";
import {
  CONTEXT_DELTA_CUSTOM_TYPE_PREFIX,
  PINNED_INSTRUCTION_ENTRY_ID_MARKER,
  RESIDENT_FOLD_ENTRY_ID_MARKER,
  isRetiredMemoryCustomMessage,
  parseResidentFold,
  residentIdentityForCustomMessage,
} from "../agent-runtime/resident-context.js";
import {
  estimateProviderPayloadTokens,
  getProviderPayloadImageStats,
} from "../agent-runtime/context-budget.js";
import {
  ORCHESTRATOR_ROSTER_CUSTOM_TYPE,
  asFiniteNumber,
  asObject,
  asTrimmedString,
  isUserContent,
  parseRuntimeThreadPayload,
  type LocalChatEventRecord,
  type PersistedRuntimeThreadPayload,
  type RuntimeThreadCustomMessageEntry,
} from "./shared.js";

export const EAGER_TOOL_EVENT_LIMIT = 32;
export const EAGER_TOOL_EVENT_PAYLOAD_BYTES = 4096;
export const EAGER_TOOL_EVENT_SIDE_LIMIT = EAGER_TOOL_EVENT_LIMIT / 2;

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

export const RECALL_THREAD_RESULT_EXCERPT_CHARS = 1_600;
export const RECALL_THREAD_ERROR_EXCERPT_CHARS = 300;
export const TRANSCRIPT_SEARCH_TEXT_CAP = 4_000;
export const THREAD_SEARCH_FTS_CANDIDATE_CAP = 200;

export class FtsSearchUnavailableError extends Error {
  index: string;
  override name = "FtsSearchUnavailableError";
  constructor(index: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.index = index;
  }
}

export const throwFtsSearchUnavailable = (
  index: string,
  reason: string,
  cause?: unknown,
): never => {
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

export const parseJsonValue = (value: unknown): any => {
  if (!value || typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

export const eventRoleForType = (type: string): string => {
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

export const toIsoTimestamp = (timestamp: number): string =>
  new Date(timestamp).toISOString();

/* ------------------------------------------------------------------ */
/* Timeline cursors                                                    */
/* ------------------------------------------------------------------ */

export type Cursor = {
  timestamp: number;
  id: string;
  sequence?: number;
};

export const compareTimelineCursor = (a: Cursor, b: Cursor): number => {
  if (
    typeof a.sequence === "number" &&
    Number.isFinite(a.sequence) &&
    typeof b.sequence === "number" &&
    Number.isFinite(b.sequence)
  ) {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.id.localeCompare(b.id);
  }
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id.localeCompare(b.id);
};

/* ------------------------------------------------------------------ */
/* Eager tool-event payload projection                                 */
/* ------------------------------------------------------------------ */

type ProjectionLimits = {
  stringChars: number;
  arrayItems: number;
  objectKeys: number;
};

const projectBoundedJsonValue = (
  value: any,
  depth: number,
  limits: ProjectionLimits,
): any => {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= limits.stringChars
      ? value
      : `${value.slice(0, limits.stringChars)}…`;
  }
  if (depth <= 0) return "[detail omitted]";
  if (Array.isArray(value)) {
    return value
      .slice(0, limits.arrayItems)
      .map((item) => projectBoundedJsonValue(item, depth - 1, limits));
  }
  if (typeof value === "object") {
    const projected: Record<string, unknown> = {};
    const allEntries = Object.entries(value);
    const entries = [
      ...allEntries.filter(
        ([key]) => key === "fileChanges" || key === "producedFiles",
      ),
      ...allEntries.filter(
        ([key]) => key !== "fileChanges" && key !== "producedFiles",
      ),
    ].slice(0, limits.objectKeys);
    for (const [key, item] of entries) {
      projected[key] =
        (key === "fileChanges" || key === "producedFiles") && Array.isArray(item)
          ? item.slice(0, limits.arrayItems)
          : projectBoundedJsonValue(item, depth - 1, limits);
    }
    if (Object.keys(value).length > entries.length) {
      projected.__truncatedKeys = Object.keys(value).length - entries.length;
    }
    return projected;
  }
  return String(value);
};

const projectEagerEventPayload = (
  payload: any,
): { payload: any; projected: boolean } => {
  if (!payload) return { payload, projected: false };
  const markProjected = (value: any) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? {
          ...value,
          __stellaEagerProjection: {
            truncated: true,
            fullDetailAvailable: true,
          },
        }
      : value;
  const fitsEnvelope = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    EAGER_TOOL_EVENT_PAYLOAD_BYTES;
  try {
    if (fitsEnvelope(payload)) {
      return { payload, projected: false };
    }
  } catch {
    /* fall through to projection */
  }
  const projected = markProjected(
    projectBoundedJsonValue(payload, 5, {
      stringChars: 768,
      arrayItems: 10,
      objectKeys: 32,
    }),
  );
  try {
    if (fitsEnvelope(projected)) {
      return { payload: projected, projected: true };
    }
  } catch {
    /* fall through */
  }
  const minimal = markProjected(
    projectBoundedJsonValue(payload, 3, {
      stringChars: 192,
      arrayItems: 4,
      objectKeys: 16,
    }),
  );
  try {
    if (fitsEnvelope(minimal)) {
      return { payload: minimal, projected: true };
    }
  } catch {
    /* fall through */
  }
  const artifactFallback: Record<string, unknown> = {};
  for (const key of ["fileChanges", "producedFiles"]) {
    if (Array.isArray(payload[key]) && payload[key].length > 0) {
      artifactFallback[key] = payload[key].slice(0, 1);
    }
  }
  if (Object.keys(artifactFallback).length > 0) {
    const projectedArtifacts = markProjected(artifactFallback);
    try {
      if (fitsEnvelope(projectedArtifacts)) {
        return { payload: projectedArtifacts, projected: true };
      }
    } catch {
      /* fall through */
    }
  }
  return {
    payload: {
      detailOmitted: true,
      __stellaEagerProjection: {
        truncated: true,
        fullDetailAvailable: true,
      },
    },
    projected: true,
  };
};

export const projectLocalChatUpdateEventWithMetadata = (
  event: LocalChatEventRecord,
): { event: LocalChatEventRecord; payloadProjected: boolean } => {
  if (
    !event?.payload ||
    event.type === "user_message" ||
    event.type === "assistant_message"
  ) {
    return { event, payloadProjected: false };
  }
  const projected = projectEagerEventPayload(event.payload);
  return {
    event: { ...event, payload: projected.payload },
    payloadProjected: projected.projected,
  };
};

export const projectLocalChatUpdateEvent = (
  event: LocalChatEventRecord,
): LocalChatEventRecord =>
  projectLocalChatUpdateEventWithMetadata(event).event;

/* ------------------------------------------------------------------ */
/* Search tokenization                                                 */
/* ------------------------------------------------------------------ */

const SEARCH_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at",
  "for", "with", "from", "by", "about", "into", "over", "after", "before",
  "during", "between", "is", "am", "are", "was", "were", "be", "been",
  "being", "do", "does", "did", "doing", "have", "has", "had", "having",
  "will", "would", "can", "could", "should", "shall", "may", "might",
  "i", "me", "my", "we", "us", "our", "you", "your", "it", "its", "they",
  "them", "their", "he", "him", "his", "she", "her", "that", "this",
  "these", "those", "there", "here", "what", "which", "who", "whom",
  "whose", "when", "where", "why", "how", "not", "no", "so", "if",
  "then", "than", "too", "very", "just", "also", "any", "some", "thing",
  "stuff", "one", "ago", "last", "recent",
]);

export const tokenizeSearchQuery = (query: string | undefined): string[] => {
  const rawTokens = (query ?? "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const meaningful = rawTokens.filter(
    (token) => !SEARCH_STOPWORDS.has(token.toLowerCase()),
  );
  return (meaningful.length > 0 ? meaningful : rawTokens).slice(0, 12);
};

/* ------------------------------------------------------------------ */
/* Message previews                                                    */
/* ------------------------------------------------------------------ */

export const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";

export const formatThreadCheckpointMessage = (
  summary: string,
  imageReceipts: unknown[] = [],
): string =>
  [
    THREAD_CHECKPOINT_MARKER,
    "",
    summary.trim(),
    ...(imageReceipts.length > 0
      ? [
          "",
          '<image-receipts version="1">',
          JSON.stringify(imageReceipts),
          "</image-receipts>",
        ]
      : []),
  ].join("\n");

export const previewFromTextAndImages = (
  content: string | (TextContent | ImageContent)[],
): string => {
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

export const previewFromAssistantPayload = (payload: AssistantMessage): string =>
  payload.content
    .flatMap((block: any) => {
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

export const authoredTextFromAssistantPayload = (payload: any): string =>
  payload.content
    .flatMap((block: any) =>
      block.type === "text" && block.text.trim() ? [block.text] : [],
    )
    .join("\n\n")
    .trim();

export const truncateAuthoredUpdate = (
  value: string,
  maxChars = AGENT_ASSISTANT_UPDATE_LIMITS.messageChars,
  maxBytes = AGENT_ASSISTANT_UPDATE_LIMITS.messageBytes,
): string => {
  const codePoints = [...value.trim()];
  let end = Math.min(codePoints.length, Math.max(0, maxChars));
  while (end > 0) {
    const candidate = codePoints.slice(0, end).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
    end -= 1;
  }
  return "";
};

export const previewFromPayload = (
  payload: PersistedRuntimeThreadPayload,
): string => {
  if (payload.role === "assistant") {
    return previewFromAssistantPayload(payload as AssistantMessage);
  }
  if (payload.role === "toolResult") {
    const body = previewFromTextAndImages(payload.content);
    return [`[Tool result] ${payload.toolName}`, ...(body ? [body] : [])]
      .join("\n")
      .trim();
  }
  return previewFromTextAndImages(payload.content);
};

export type ThreadMessageInput = {
  timestamp: number;
  threadKey: string;
  role: "user" | "assistant" | "toolResult" | "runtimeInternal";
  content: string;
  toolCallId?: string;
  payload?: PersistedRuntimeThreadPayload;
  preservePayloadExactly?: boolean;
};

export const buildFallbackThreadPayload = (
  message: ThreadMessageInput,
): PersistedRuntimeThreadPayload => {
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
    } as PersistedRuntimeThreadPayload;
  }
  if (message.role === "toolResult") {
    const legacyIsError = /^\s*Error:\s*(?:\[TOOL_ERROR\])?/i.test(
      message.content,
    );
    return {
      role: "toolResult",
      toolCallId: message.toolCallId ?? "",
      toolName: "tool",
      content:
        message.content.trim().length > 0
          ? [{ type: "text", text: message.content }]
          : [],
      isError: legacyIsError,
      timestamp: message.timestamp,
    } as PersistedRuntimeThreadPayload;
  }
  return {
    role: "user",
    content: message.content,
    timestamp: message.timestamp,
  } as PersistedRuntimeThreadPayload;
};

/* ------------------------------------------------------------------ */
/* Row-size bounding for durable thread payloads                       */
/* ------------------------------------------------------------------ */

const rowSizeTextEncoder = new TextEncoder();

export const THREAD_ROW_MAX_BYTES = 6_000_000;
const THREAD_ROW_MAX_TEXT_CHARS = 1_000;
const THREAD_ROW_PREVIEW_CHARS = 500;

export const payloadByteLength = (payload: unknown): number =>
  rowSizeTextEncoder.encode(JSON.stringify(payload)).byteLength;

export const jsonByteLength = (json: string): number =>
  rowSizeTextEncoder.encode(json).byteLength;

const truncatePreview = (
  value: string,
  maxChars = THREAD_ROW_PREVIEW_CHARS,
): string => (value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`);

const truncateTextBlockForStorage = (text: string, label = "Text"): string =>
  `[${label} truncated for storage (${text.length} chars). First ${Math.min(text.length, THREAD_ROW_PREVIEW_CHARS)} chars: ${truncatePreview(text)}]`;

const truncateToolOutputForStorage = (text: string): string =>
  `This tool output was too large to persist in storage (${text.length} chars). If the user asks about this data, suggest re-running the tool. Preview: ${truncatePreview(text)}`;

const strippedImageStorageNote = (image: any): TextContent => {
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

export const payloadContainsImage = (payload: any): boolean =>
  typeof payload?.content !== "string" &&
  Array.isArray(payload?.content) &&
  payload.content.some((block: any) => block?.type === "image");

export const customMessageContainsImage = (message: any): boolean =>
  Array.isArray(message?.content) &&
  message.content.some((block: any) => block?.type === "image");

export type ThreadContextPressure = {
  version: 1;
  estimatedTokens: number;
  imageCount: number;
  imageDecodedBytes: number;
};

export const buildThreadContextPressure = (
  value: unknown,
): ThreadContextPressure => {
  const images = getProviderPayloadImageStats({ messages: [value] });
  return {
    version: 1,
    estimatedTokens: estimateProviderPayloadTokens(
      { messages: [value] },
      Number.POSITIVE_INFINITY,
    ),
    imageCount: images.count,
    imageDecodedBytes: images.decodedBytes,
  };
};

const truncateObjectForStorage = (value: unknown, label: string) => {
  const json = JSON.stringify(value);
  return {
    __truncated: `${label} truncated for storage (${json.length} chars). Preview: ${truncatePreview(json)}`,
  };
};

export const enforceThreadPayloadRowSizeLimit = (
  payload: PersistedRuntimeThreadPayload,
): PersistedRuntimeThreadPayload => {
  if (payloadByteLength(payload) <= THREAD_ROW_MAX_BYTES) {
    return payload;
  }
  if (payload.role === "user") {
    const content =
      typeof payload.content === "string"
        ? truncateTextBlockForStorage(payload.content, "User content")
        : payload.content.map((block) =>
            block.type === "text" && block.text.length > THREAD_ROW_MAX_TEXT_CHARS
              ? {
                  ...block,
                  text: truncateTextBlockForStorage(block.text, "User content"),
                }
              : block,
          );
    const candidate = { ...payload, content } as PersistedRuntimeThreadPayload;
    if (payloadByteLength(candidate) <= THREAD_ROW_MAX_BYTES) {
      return candidate;
    }
    if (typeof content !== "string") {
      const withoutImageData = {
        ...payload,
        content: content.map((block: any) =>
          block.type === "image" ? strippedImageStorageNote(block) : block,
        ),
      } as PersistedRuntimeThreadPayload;
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
    } as PersistedRuntimeThreadPayload;
  }
  if (payload.role === "assistant") {
    const compacted = {
      ...payload,
      content: payload.content.map((block: any) => {
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
    } as PersistedRuntimeThreadPayload;
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
    } as PersistedRuntimeThreadPayload;
  }
  const compacted = {
    ...payload,
    content: payload.content.map((block: any) =>
      block.type === "text" && block.text.length > THREAD_ROW_MAX_TEXT_CHARS
        ? { ...block, text: truncateToolOutputForStorage(block.text) }
        : block,
    ),
  } as PersistedRuntimeThreadPayload;
  if (payloadByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
    return compacted;
  }
  const withoutImageData = {
    ...compacted,
    content: (compacted.content as any[]).map((block: any) => {
      if (block.type !== "image") {
        return block;
      }
      return strippedImageStorageNote(block);
    }),
  } as PersistedRuntimeThreadPayload;
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
  } as PersistedRuntimeThreadPayload;
};

export type StoredCustomMessage = Pick<
  RuntimeThreadCustomMessageEntry,
  "customType" | "content" | "display" | "eventId"
>;

export const enforceCustomMessageRowSizeLimit = (
  message: StoredCustomMessage,
): StoredCustomMessage => {
  if (payloadByteLength(message) <= THREAD_ROW_MAX_BYTES) {
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
  const compacted = { ...message, content } as StoredCustomMessage;
  if (payloadByteLength(compacted) <= THREAD_ROW_MAX_BYTES) {
    return compacted;
  }
  const withoutImageData = {
    ...compacted,
    content:
      typeof compacted.content === "string"
        ? compacted.content
        : compacted.content.map((block: any) => {
            if (block.type !== "image") {
              return block;
            }
            const sizeKb = Math.round(((block.data?.length ?? 0) * 0.75) / 1024);
            return {
              type: "text",
              text: `[image content block stripped for storage: mime=${block.mimeType ?? "image/png"} approx_kb=${sizeKb}]`,
            };
          }),
  } as StoredCustomMessage;
  if (payloadByteLength(withoutImageData) <= THREAD_ROW_MAX_BYTES) {
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
  } as StoredCustomMessage;
};

/* ------------------------------------------------------------------ */
/* Stored thread-entry parsing                                         */
/* ------------------------------------------------------------------ */

const THREAD_LIFECYCLE_EVENT_TYPES = new Set([
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
]);

export const parseStoredThreadLifecycleEvent = (
  value: unknown,
): LocalChatEventRecord | null => {
  const record = asObject(value);
  const id = asTrimmedString(record?._id);
  const type = asTrimmedString(record?.type);
  const timestamp = asFiniteNumber(record?.timestamp);
  if (!id || !type || !THREAD_LIFECYCLE_EVENT_TYPES.has(type) || timestamp === null) {
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

export type ThreadEntryRow = {
  entryId: string;
  parentEntryId?: string | null;
  entryType: string;
  timestampIso: string;
  createdAt: number;
  dataJson: string | null;
};

export type ParsedThreadEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
};

export const parseThreadSessionEntry = (
  row: ThreadEntryRow,
): ParsedThreadEntry | null => {
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
        parentId: row.parentEntryId ?? null,
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
        parentId: row.parentEntryId ?? null,
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
        parentId: row.parentEntryId ?? null,
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
        parentId: row.parentEntryId ?? null,
        timestamp: row.timestampIso,
        event,
      };
    }
    default:
      return null;
  }
};

export type ThreadMessageRecord = {
  entryId: string;
  threadKey: string;
  timestamp: number;
  role: string;
  content: string;
  toolCallId?: string;
  payload?: PersistedRuntimeThreadPayload;
  customMessage?: StoredCustomMessage;
  checkpointQuarantineKeys?: string[];
  checkpointImageReceipts?: unknown[];
};

export const toThreadMessageRecord = (
  entry: ParsedThreadEntry,
): ThreadMessageRecord | null => {
  if (entry.type === "message") {
    const payload = entry.message as PersistedRuntimeThreadPayload;
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
      content: previewFromTextAndImages(entry.content as any),
      customMessage: {
        customType: entry.customType as string,
        content: entry.content as any,
        display: entry.display as boolean,
        ...(entry.eventId ? { eventId: entry.eventId as string } : {}),
      },
    };
  }
  return null;
};

export const buildRawThreadMessages = (
  entries: ParsedThreadEntry[],
): ThreadMessageRecord[] =>
  entries
    .map((entry) => toThreadMessageRecord(entry))
    .filter((message): message is ThreadMessageRecord => message !== null);

/* ------------------------------------------------------------------ */
/* Compaction checkpoint details                                       */
/* ------------------------------------------------------------------ */

export const parsePinnedUserInstruction = (
  details: unknown,
): { text: string } | null => {
  const pinned =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as any).pinnedUserInstruction
      : undefined;
  const text =
    pinned && typeof pinned === "object" && typeof pinned.text === "string"
      ? pinned.text.trim()
      : "";
  return text ? { text } : null;
};

export const parseCheckpointQuarantineKeys = (details: unknown): string[] => {
  const keys =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as any).quarantinedToolResultKeys
      : undefined;
  if (!Array.isArray(keys)) return [];
  return [
    ...new Set(
      keys.flatMap((key) =>
        typeof key === "string" && key.trim() ? [key.trim()] : [],
      ),
    ),
  ];
};

export const parseImageReceipts = (details: unknown): any[] => {
  const receipts =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as any).imageReceipts
      : undefined;
  if (!Array.isArray(receipts)) return [];
  return receipts.flatMap((receipt) => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      return [];
    }
    const id = typeof receipt.id === "string" ? receipt.id.trim() : "";
    const mimeType =
      typeof receipt.mimeType === "string" ? receipt.mimeType.trim() : "";
    const decodedBytes = Number(receipt.decodedBytes);
    const origin = receipt.origin;
    const artifact = receipt.artifact;
    if (
      !/^sha256:[a-f0-9]{64}$/.test(id) ||
      !mimeType.startsWith("image/") ||
      !Number.isFinite(decodedBytes) ||
      decodedBytes < 0 ||
      !origin ||
      typeof origin !== "object" ||
      !Number.isFinite(Number(origin.timestamp)) ||
      typeof origin.role !== "string" ||
      !artifact ||
      typeof artifact !== "object" ||
      !["durable", "non-durable"].includes(artifact.durability)
    ) {
      return [];
    }
    return [receipt];
  });
};

export type CheckpointOverlay = {
  id: string;
  summary: string;
  timestamp: number;
  replaceDerivedContext?: true;
  residentFold?: ReturnType<typeof parseResidentFold>;
  pinnedUserInstruction?: { text: string };
  checkpointQuarantineKeys?: string[];
  imageReceipts?: any[];
};

export const buildCheckpointOverlay = (args: {
  entryId: string;
  summary: string;
  timestampIso: string;
  details: unknown;
}): CheckpointOverlay => {
  const timestamp = Date.parse(args.timestampIso) || Date.now();
  const residentFold = parseResidentFold(args.details);
  const replaceDerivedContext =
    args.details !== null &&
    typeof args.details === "object" &&
    (args.details as any).replaceDerivedContext === true;
  const pinnedUserInstruction = parsePinnedUserInstruction(args.details);
  const checkpointQuarantineKeys = parseCheckpointQuarantineKeys(args.details);
  const imageReceipts = parseImageReceipts(args.details);
  return {
    id: args.entryId,
    summary: args.summary,
    timestamp,
    ...(replaceDerivedContext ? { replaceDerivedContext: true as const } : {}),
    ...(residentFold ? { residentFold } : {}),
    ...(pinnedUserInstruction ? { pinnedUserInstruction } : {}),
    ...(checkpointQuarantineKeys.length > 0 ? { checkpointQuarantineKeys } : {}),
    ...(imageReceipts.length > 0 ? { imageReceipts } : {}),
  };
};

export const applyResidentFold = (
  messages: ThreadMessageRecord[],
  overlay: CheckpointOverlay,
): ThreadMessageRecord[] => {
  const fold = overlay.residentFold ?? {
    docs: [],
    identities: new Set<string>(),
  };
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
    if (isRetiredMemoryCustomMessage(message.customMessage)) {
      return false;
    }
    if (message.timestamp > overlay.timestamp) {
      return true;
    }
    const customType = message.customMessage.customType;
    if (customType === ORCHESTRATOR_ROSTER_CUSTOM_TYPE) {
      return false;
    }
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
  const docMessages: ThreadMessageRecord[] = fold.docs.map(
    (doc: any, docIndex: number) => ({
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
    }),
  );
  swept.splice(insertIndex, 0, ...docMessages);
  return swept;
};

/** Build the synthetic checkpoint rows (summary + optional pinned instruction). */
export const buildCheckpointMessages = (
  overlay: CheckpointOverlay,
): ThreadMessageRecord[] => [
  {
    entryId: overlay.id,
    threadKey: "",
    timestamp: overlay.timestamp,
    role: "assistant",
    content: formatThreadCheckpointMessage(
      overlay.summary,
      overlay.imageReceipts ?? [],
    ),
    ...(overlay.checkpointQuarantineKeys
      ? { checkpointQuarantineKeys: overlay.checkpointQuarantineKeys }
      : {}),
    ...(overlay.imageReceipts
      ? { checkpointImageReceipts: overlay.imageReceipts }
      : {}),
  },
  ...(overlay.pinnedUserInstruction
    ? [
        {
          entryId: `${overlay.id}${PINNED_INSTRUCTION_ENTRY_ID_MARKER}`,
          threadKey: "",
          timestamp: overlay.timestamp,
          role: "user",
          content: overlay.pinnedUserInstruction.text,
          payload: {
            role: "user",
            content: overlay.pinnedUserInstruction.text,
            timestamp: overlay.timestamp,
          } as PersistedRuntimeThreadPayload,
        } satisfies ThreadMessageRecord,
      ]
    : []),
];
