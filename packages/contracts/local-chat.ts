import type { OfficePreviewRef } from "./office-preview.js";
import type { FileChangeRecord, ProducedFileRecord } from "./file-changes.js";
import type { AgentModelConfigSnapshot } from "./agent-engine.js";

export type EventRecord = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
  channelEnvelope?: ChannelEnvelope;
};

export type LocalChatUpdatedPayload = {
  conversationId?: string;
  event?: EventRecord;
};

/** Stable keyset cursor for the conversation-history list. */
export type ConversationSummaryCursor = {
  updatedAt: number;
  conversationId: string;
};

/** Lightweight conversation metadata for history and top-bar tabs. */
export type ConversationSummary = {
  conversationId: string;
  title: string;
  latestMessageId?: string;
  latestMessageAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type ConversationSummaryPage = {
  conversations: ConversationSummary[];
  nextCursor?: ConversationSummaryCursor;
  hasMore: boolean;
};

/** One locally persisted provider call, attributed to its runtime thread. */
export type LocalModelUsageRecord = {
  id: string;
  timestamp: number;
  conversationId: string;
  conversationTitle: string;
  threadId: string;
  threadName: string;
  agentType: string;
  agentDescription?: string;
  agentDepth?: number;
  parentAgentId?: string;
  rootRunId?: string;
  provider: string;
  api: string;
  model: string;
  responseModel?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  inputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  stopReason: string;
  errorMessage?: string;
};

export type LocalModelUsagePage = {
  records: LocalModelUsageRecord[];
  truncated: boolean;
};

/**
 * One background-agent thread's authoritative activity state — a direct
 * projection of the runtime's `runtime_agents` row. This is the single source of truth the Activity
 * UI renders; lifecycle *events* remain the per-occurrence history for chat
 * cards, but never drive thread state.
 */
export type ThreadActivityRecord = {
  /** Execution authority for this row. Native Claude rows are passive. */
  source: "stella" | "claude-native";
  threadId: string;
  conversationId: string;
  agentType: string;
  description: string;
  status: "running" | "completed" | "error" | "canceled";
  /** Durable attempt epoch for reused threads. */
  attemptGeneration?: number;
  /** Root run that owns the thread's latest lifecycle. */
  rootRunId?: string;
  /** Exact engine/model configuration captured for this thread's run. */
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  parentAgentId?: string;
  /** Native projections are inspectable but are not Stella-controlled. */
  readOnly?: boolean;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  /** Recent persisted prose authored by this agent, oldest to newest. */
  assistantMessages?: string[];
  assistantMessagesUpdatedAt?: number;
  assistantMessagesUpdatedSequence?: number;
  updatedAt: number;
};

/** Bounded current-attempt assistant prose for incremental Activity updates. */
export type ThreadActivityAssistantUpdate = {
  threadId: string;
  assistantMessages: string[];
  /** Legacy mobile alias. Contains authored prose, never generated summaries. */
  reasoningSummaries: string[];
  latestMessage: string;
  atMs: number;
  atSequence?: number;
  attemptGeneration: number;
  rootRunId?: string;
};

export type ThreadTranscriptUpdate = {
  source?: "stella" | "claude-native";
  threadId: string;
  entryId: string;
  atMs: number;
};

export type ThreadActivityUpdatedPayload = {
  conversationId: string;
  assistantUpdate?: ThreadActivityAssistantUpdate;
  transcriptUpdate?: ThreadTranscriptUpdate;
};

/**
 * Snapshot of the renderer's ephemeral per-thread status decoration, mirrored
 * to the mobile bridge. Authored assistant updates travel through the durable
 * thread projection instead of this renderer-owned channel.
 */
export type TaskDecorationUpdatedPayload = {
  statusTextByAgentId: Record<string, string>;
};

export type ToolRequestPayload = {
  toolName: string;
  args?: Record<string, unknown>;
  targetDeviceId?: string;
  agentType?: string;
};

/**
 * One web search hit as surfaced to the chat UI. Mirrors the backend
 * `SearchHit` (Exa) shape; `image`/`favicon` are only present when the
 * source provided them.
 */
export type WebSearchResultHit = {
  title: string;
  url: string;
  snippet: string;
  image?: string;
  favicon?: string;
};

/**
 * UI-only browser state emitted after a Node REPL cell's last successful
 * visual browser action. This deliberately lives outside the model-facing
 * tool result text: the desktop can update its browser surface without
 * feeding an automatic screenshot back into the agent.
 */
export type BrowserUseResponseMeta = {
  "stella/browserUse": true;
  "stella/toolSurface": {
    kind: "browserUse";
    backend: "iab" | "extension";
    browserId: string;
    openTabIds: string[];
    sessionEnded: boolean;
    screenshot?: {
      tabId: string;
      url: string;
      /** Origin only; query strings, fragments, and paths stay out of UI metadata. */
      pageUrl?: string;
    };
  };
  browser_use?: {
    /** Sanitized page URL with credentials, query parameters, and fragments removed. */
    url?: string;
  };
};

export type ToolResultPayload = {
  toolName: string;
  /** Absent on historical rows; false must not be inferred from absence. */
  isError?: boolean;
  result?: unknown;
  resultPreview?: string;
  error?: string;
  requestId?: string;
  agentType?: string;
  officePreviewRef?: OfficePreviewRef;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  /**
   * Structured `web` tool fields, spread onto the persisted payload when
   * the tool ran in search mode (see `runtime/kernel/tools/defs/web.ts`).
   */
  mode?: string;
  query?: string;
  results?: WebSearchResultHit[];
  /** Host/UI response metadata. Never included in model-visible tool text. */
  _meta?: BrowserUseResponseMeta;
};

export type Attachment = {
  id?: string;
  url?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  kind?: string;
  /**
   * On-disk source path when the attachment came from a disk-backed File
   * (picker / drag-drop). Sent-message file chips use it to open the
   * original in its default app; absent for synthetic files.
   */
  path?: string;
  providerMeta?: unknown;
};

export type ChannelReaction = {
  emoji: string;
  action: "add" | "remove";
  targetMessageId?: string;
};

export type ChannelEnvelope = {
  provider: string;
  kind: "message" | "reaction" | "edit" | "delete" | "system";
  chatType?: string;
  externalUserId?: string;
  externalChatId?: string;
  externalMessageId?: string;
  threadId?: string;
  text?: string;
  attachments?: Attachment[];
  reactions?: ChannelReaction[];
  sourceTimestamp?: number;
  providerPayload?: unknown;
};

export type MessagePayload = {
  text?: string;
  contextText?: string;
  role?: string;
  source?: string;
  agentType?: string;
  attachments?: Attachment[];
  mode?: string;
  userMessageId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  metadata?: MessageMetadata;
};

export type MessageMetadata = {
  ui?: {
    visibility?: "visible" | "hidden";
  };
  context?: {
    windowLabel?: string;
    windowPreviewImageUrl?: string;
    /** Legacy single label (joined when multiple areas were attached). */
    appSelectionLabel?: string;
    /** One label per attached selected-area context, in attach order. */
    appSelectionLabels?: string[];
    activityLabel?: string;
    /**
     * Descriptors for each "Pasted text" chip on this turn. `text` is a
     * bounded preview (capped at `PASTED_TEXT_PREVIEW_MAX_CHARS`) so the
     * sent-message chip can show the pasted content on hover, matching the
     * composer chip; `lines`/`chars` describe the full paste.
     */
    pastedTexts?: { text?: string; lines: number; chars: number }[];
    /**
     * Bounded preview of the quoted / "Ask Stella" context attached to this
     * turn. Rendered as a chip on the sent message instead of being folded
     * into the visible body; the model receives the quote as a dedicated
     * hidden context message at prompt-assembly time.
     */
    quotedText?: string;
  };
  trigger?: {
    kind?: string;
    source?: string;
    targetAgentId?: string;
  };
  /**
   * Set on the single visible assistant message a realtime voice session
   * writes when it ends. Lets the chat surface render a polished
   * "Voice session" summary card instead of parsing the duration back out
   * of the message text.
   */
  voiceSession?: VoiceSessionSummaryMetadata;
};

export type VoiceSessionSummaryMetadata = {
  /** Total wall-clock length of the voice session, in milliseconds. */
  durationMs: number;
};

/**
 * Chat-timeline view over the underlying append-only event log.
 *
 * `listMessages` projects `user_message` / `assistant_message` rows into
 * `MessageRecord` and attaches each turn's tool/agent lifecycle events
 * to the turn's anchor — first assistant when one exists, otherwise the
 * user_message of the turn. Turn-scoped decoration data (inline
 * artifacts, schedule receipts, file-change
 * previews) lives on the anchor's `toolEvents` rather than being
 * recovered from a flat event stream at render time.
 *
 * The full event log remains accessible via `listEvents` / `listEventsBefore`
 * for activity/files/debug surfaces.
 */
export type MessageRecord = {
  _id: string;
  timestamp: number;
  /**
   * Dedicated monotonic ordering key assigned by the authoritative desktop
   * (chat-ordering re-architecture). Present only when the ordering-sequence
   * migration is active; clients order by it when the sequence flip is enabled,
   * else they keep using `(timestamp, _id)`.
   */
  sequence?: number;
  /**
   * Underlying event type — currently `"user_message"` or
   * `"assistant_message"`. Kept as the raw string (rather than narrowed)
   * so future visible-message kinds don't need a contract bump.
   */
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
  channelEnvelope?: ChannelEnvelope;
  /**
   * Tool/agent lifecycle events that fired during this message's turn,
   * attached when this message is the turn anchor (first assistant of
   * the turn, or — when no assistant fires — the user_message of the
   * turn). Empty for secondary assistants, hidden messages, and any
   * message that is not the anchor of its turn.
   */
  toolEvents: EventRecord[];
};
