import { completeSimple, readAssistantText } from "../ai/stream.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "./storage/shared.js";
import type { RuntimeStore } from "./storage/runtime-store.js";
import type { ResolvedLlmRoute } from "./model-routing.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import fs from "node:fs";
import path from "node:path";
import { createRuntimeLogger } from "./debug.js";
import { redactMemoryText } from "./memory/redaction.js";
import { readRuntimePrompt } from "./prompts/home-prompts.js";
import {
  getLastProviderPayloadTokens,
  isThreadCompactionForced,
} from "./agent-runtime/context-budget.js";
import { resolveCanonicalContextWindow } from "./agent-runtime/canonical-history-budget.js";
import {
  RESIDENT_FOLD_ENTRY_ID_MARKER,
  buildResidentFold,
} from "./agent-runtime/resident-context.js";
import { loadLocalPreferences } from "./preferences/local-preferences.js";

const logger = createRuntimeLogger("thread-runtime");

const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";
export const resolveThreadCompactionSystemPrompt = (
  _stellaDataDir?: string,
): string => readRuntimePrompt("thread-compaction") ?? "";
const THREAD_COMPACTION_RESERVE_TOKENS = 49_152;
/**
 * Fraction of the model's real context window at which the orchestrator
 * thread store compacts. Keyed off `route.model.contextWindow` (the real,
 * provider-catalog-derived window) so the trigger scales with the active model
 * instead of a fixed token budget.
 */
const THREAD_COMPACTION_TRIGGER_PCT = 0.7;
const THREAD_COMPACTION_PROTECT_HEAD_MESSAGES = 3;
const THREAD_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
/**
 * Fraction of the model's window the kept tail may occupy. Bounds the fixed
 * keep-recent budget on small-window models so a compaction always frees
 * enough room for the retry to fit.
 */
const THREAD_COMPACTION_KEEP_RECENT_WINDOW_PCT = 0.1;
const THREAD_COMPACTION_MIN_TAIL_MESSAGES = 2;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MIN_TRIGGER_TOKENS = 8_000;
const MAX_BLOCK_CHARS = 100_000;
const TOOL_RESULT_MAX_CHARS = 2_000;
const ESTIMATED_IMAGE_TOKENS = 1_200;

type ThreadMessage = {
  timestamp: number;
  role: "user" | "assistant" | "runtimeInternal";
  content: string;
  toolCallId?: string;
};

type StoredThreadMessage = {
  entryId?: string;
  timestamp: number;
  role: string;
  content: string;
  toolCallId?: string;
  payload?: RuntimeThreadMessage["payload"];
  customMessage?: RuntimeThreadMessage["customMessage"];
};

type ThreadCheckpoint = {
  summary: string;
  previousThreadFile?: string;
};

export type ThreadCompactionPlan = {
  previousSummary?: string;
  fromEntryId: string;
  toEntryId: string;
  middleMessages: StoredThreadMessage[];
};

const truncateWithSuffix = (
  value: string,
  maxChars: number,
  suffix = "...(truncated)",
): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}${suffix}`;

const ellipsize = (value: string): string =>
  truncateWithSuffix(value.trim(), MAX_BLOCK_CHARS);

const truncateForSummary = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n\n[... ${value.length - maxChars} more characters truncated]`;

const stringifyMessage = (message: ThreadMessage): string => {
  const content = message.content.trim();
  if (!content) {
    return "";
  }
  if (message.role === "user") {
    return `[User] ${ellipsize(content)}`;
  }
  if (message.role === "runtimeInternal") {
    return `[Runtime] ${ellipsize(content)}`;
  }
  return `[Assistant] ${ellipsize(content)}`;
};

const stringifyPayloadMessage = (
  payload: PersistedRuntimeThreadPayload,
): string[] => {
  if (payload.role === "user") {
    const content =
      typeof payload.content === "string"
        ? payload.content
        : payload.content
            .map((block) =>
              block.type === "text" ? block.text : `[Image: ${block.mimeType}]`,
            )
            .join("\n");
    return content.trim() ? [`[User] ${content.trim()}`] : [];
  }

  if (payload.role === "assistant") {
    const parts: string[] = [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: string[] = [];

    for (const block of payload.content) {
      if (block.type === "text") {
        if (block.text.trim()) {
          textParts.push(block.text);
        }
        continue;
      }
      if (block.type === "thinking") {
        if (block.thinking.trim()) {
          thinkingParts.push(block.thinking);
        }
        continue;
      }
      toolCalls.push(
        `${block.name}(${Object.entries(block.arguments ?? {})
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(", ")})`,
      );
    }

    if (thinkingParts.length > 0) {
      parts.push(`[Assistant thinking] ${thinkingParts.join("\n")}`);
    }
    if (textParts.length > 0) {
      parts.push(`[Assistant] ${textParts.join("\n")}`);
    }
    if (toolCalls.length > 0) {
      parts.push(`[Assistant tool calls] ${toolCalls.join("; ")}`);
    }
    return parts;
  }

  const content = payload.content
    .map((block) =>
      block.type === "text" ? block.text : `[Image: ${block.mimeType}]`,
    )
    .join("\n")
    .trim();
  return content
    ? [`[Tool result] ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`]
    : [];
};

const stringifyStoredMessage = (message: StoredThreadMessage): string[] => {
  if (message.payload) {
    return stringifyPayloadMessage(message.payload);
  }
  if (message.role === "toolResult") {
    const content = message.content.trim();
    return content
      ? [`[Tool result] ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`]
      : [];
  }
  return [stringifyMessage(message as ThreadMessage)].filter(
    (entry) => entry.length > 0,
  );
};

export const formatThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
): string =>
  messages
    .flatMap((message) => stringifyStoredMessage(message))
    .filter((entry) => entry.length > 0)
    .join("\n\n");

const estimateMessageTokens = (message: ThreadMessage): number =>
  Math.max(1, Math.ceil((message.content ?? "").length / 4));

const estimatePayloadTokens = (
  payload: PersistedRuntimeThreadPayload,
): number => {
  if (payload.role === "user") {
    if (typeof payload.content === "string") {
      return Math.max(1, Math.ceil(payload.content.length / 4));
    }
    let tokens = 0;
    for (const block of payload.content) {
      tokens +=
        block.type === "text"
          ? Math.max(1, Math.ceil(block.text.length / 4))
          : ESTIMATED_IMAGE_TOKENS;
    }
    return tokens;
  }

  if (payload.role === "assistant") {
    let tokens = 0;
    for (const block of payload.content) {
      if (block.type === "text") {
        tokens += Math.max(1, Math.ceil(block.text.length / 4));
        continue;
      }
      if (block.type === "thinking") {
        tokens += Math.max(1, Math.ceil(block.thinking.length / 4));
        continue;
      }
      tokens += Math.max(
        1,
        Math.ceil(
          (block.name.length + JSON.stringify(block.arguments ?? {}).length) /
            4,
        ),
      );
    }
    return tokens;
  }

  let tokens = 0;
  for (const block of payload.content) {
    tokens +=
      block.type === "text"
        ? Math.max(1, Math.ceil(block.text.length / 4))
        : ESTIMATED_IMAGE_TOKENS;
  }
  return tokens;
};

const estimateStoredMessageTokens = (message: StoredThreadMessage): number =>
  message.payload
    ? estimatePayloadTokens(message.payload)
    : estimateMessageTokens(message as ThreadMessage);

const getRealContextWindow = (route: ResolvedLlmRoute): number => {
  const value = Number(route.model.contextWindow);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
  return Math.floor(value);
};

const getContextWindow = (route: ResolvedLlmRoute): number =>
  resolveCanonicalContextWindow(getRealContextWindow(route));

export const getCompactionTriggerTokens = (route: ResolvedLlmRoute): number =>
  Math.max(
    MIN_TRIGGER_TOKENS,
    Math.floor(getContextWindow(route) * THREAD_COMPACTION_TRIGGER_PCT),
  );

/**
 * Fraction of the window at which the last measured full outbound payload (system
 * prompt + tool schemas + resident context + history, captured at preflight) forces
 * a proactive compaction. `getCompactionTriggerTokens` compares only the history
 * estimate against 0.7x the window, but the provider actually receives the whole
 * payload — on large-toolset engines (the Codex Responses path) that dispatched
 * payload runs ~2x the history estimate, so a thread can blow the input budget while
 * its history sits well under the trigger. Sitting below the 0.7 preflight-reject
 * fraction leaves headroom for the next turn's own growth before the hard limit.
 */
const PAYLOAD_COMPACTION_TRIGGER_PCT = 0.6;
export const getCompactionPayloadTriggerTokens = (
  route: ResolvedLlmRoute,
): number =>
  Math.max(
    MIN_TRIGGER_TOKENS,
    Math.floor(getRealContextWindow(route) * PAYLOAD_COMPACTION_TRIGGER_PCT),
  );

export const getThreadTokenEstimate = (
  messages: StoredThreadMessage[],
): number =>
  messages.reduce(
    (sum, message) => sum + estimateStoredMessageTokens(message),
    0,
  );

const isCompactionMessage = (message: StoredThreadMessage): boolean =>
  message.role === "assistant" &&
  parseThreadCheckpoint(message.content) !== null;

const hasToolCalls = (message: StoredThreadMessage): boolean =>
  message.role === "assistant" &&
  message.payload?.role === "assistant" &&
  message.payload.content.some((block) => block.type === "toolCall");

const getToolCallIds = (message: StoredThreadMessage): Set<string> => {
  const ids = new Set<string>();
  if (message.role !== "assistant" || message.payload?.role !== "assistant") {
    return ids;
  }
  for (const block of message.payload.content) {
    if (block.type === "toolCall" && typeof block.id === "string") {
      ids.add(block.id);
    }
  }
  return ids;
};

const getToolResultId = (message: StoredThreadMessage): string | undefined => {
  if (message.role !== "toolResult") {
    return undefined;
  }
  if (
    message.payload?.role === "toolResult" &&
    message.payload.toolCallId.trim()
  ) {
    return message.payload.toolCallId.trim();
  }
  return message.toolCallId?.trim();
};

const isToolResultFor = (
  message: StoredThreadMessage,
  callIds: Set<string>,
): boolean => {
  const toolCallId = getToolResultId(message);
  return Boolean(toolCallId && callIds.has(toolCallId));
};

const alignBoundaryForward = (
  messages: StoredThreadMessage[],
  index: number,
): number => {
  if (index <= 0 || index >= messages.length) {
    return index;
  }
  const previous = messages[index - 1];
  if (!previous || !hasToolCalls(previous)) {
    return index;
  }
  const callIds = getToolCallIds(previous);
  let nextIndex = index;
  while (
    nextIndex < messages.length &&
    isToolResultFor(messages[nextIndex]!, callIds)
  ) {
    nextIndex += 1;
  }
  return nextIndex;
};

const alignBoundaryBackward = (
  messages: StoredThreadMessage[],
  index: number,
): number => {
  if (index <= 0 || index >= messages.length) {
    return index;
  }
  let nextIndex = index;
  while (nextIndex > 0) {
    const message = messages[nextIndex];
    if (!message) {
      break;
    }
    if (hasToolCalls(message)) {
      break;
    }
    const previous = messages[nextIndex - 1];
    if (!previous || !hasToolCalls(previous)) {
      break;
    }
    if (!isToolResultFor(message, getToolCallIds(previous))) {
      break;
    }
    nextIndex -= 1;
  }
  return nextIndex;
};

const findTailStartIndexByTokenBudget = (
  messages: StoredThreadMessage[],
  headEnd: number,
  keepRecentTokens = THREAD_COMPACTION_KEEP_RECENT_TOKENS,
  minTailMessages = THREAD_COMPACTION_MIN_TAIL_MESSAGES,
): number => {
  let accumulatedTokens = 0;
  let tailStartIndex = messages.length;

  for (let index = messages.length - 1; index >= headEnd; index -= 1) {
    const messageTokens = estimateStoredMessageTokens(messages[index]!);
    if (
      accumulatedTokens + messageTokens > keepRecentTokens &&
      tailStartIndex < messages.length
    ) {
      break;
    }
    accumulatedTokens += messageTokens;
    tailStartIndex = index;
  }

  const minCutIndex = messages.length - minTailMessages;
  const cutIndex =
    minCutIndex >= headEnd
      ? Math.min(tailStartIndex, minCutIndex)
      : tailStartIndex;
  return alignBoundaryBackward(messages, cutIndex);
};

export const splitThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
  protectHeadMessages = THREAD_COMPACTION_PROTECT_HEAD_MESSAGES,
  keepRecentTokens = THREAD_COMPACTION_KEEP_RECENT_TOKENS,
  minTailMessages = THREAD_COMPACTION_MIN_TAIL_MESSAGES,
): ThreadCompactionPlan | null => {
  if (messages.length <= protectHeadMessages + minTailMessages) {
    return null;
  }

  let compressionStart = Math.min(protectHeadMessages, messages.length);
  compressionStart = alignBoundaryForward(messages, compressionStart);
  const tailStartIndex = findTailStartIndexByTokenBudget(
    messages,
    compressionStart,
    keepRecentTokens,
    minTailMessages,
  );
  if (tailStartIndex <= compressionStart) {
    return null;
  }

  const middleMessages = messages
    .slice(compressionStart, tailStartIndex)
    .filter((message) => !isCompactionMessage(message));
  if (middleMessages.length === 0) {
    return null;
  }

  const previousSummary = messages
    .map((message) => parseThreadCheckpoint(message.content)?.summary)
    .find(
      (summary): summary is string =>
        typeof summary === "string" && summary.trim().length > 0,
    );
  const fromEntryId = middleMessages[0]?.entryId?.trim();
  const toEntryId = middleMessages[middleMessages.length - 1]?.entryId?.trim();
  if (!fromEntryId || !toEntryId) {
    return null;
  }
  // Fold-materialized doc entries carry synthetic entryIds that don't exist
  // in the raw entry log; an overlay anchored on one could never be applied.
  // Head protection keeps them out of the middle in practice; this guard
  // makes a corrupt overlay impossible even in degenerate splits.
  if (
    fromEntryId.includes(RESIDENT_FOLD_ENTRY_ID_MARKER) ||
    toEntryId.includes(RESIDENT_FOLD_ENTRY_ID_MARKER)
  ) {
    return null;
  }

  return {
    ...(previousSummary ? { previousSummary } : {}),
    fromEntryId,
    toEntryId,
    middleMessages,
  };
};

export const resolveOrchestratorThreadKey = (conversationId: string): string =>
  conversationId;

export const buildRuntimeThreadKey = (args: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
}): string => {
  const existing = args.threadId?.trim();
  if (existing) {
    return existing;
  }
  if (args.agentType === "orchestrator") {
    return resolveOrchestratorThreadKey(args.conversationId);
  }
  const threadKey = `run:${args.runId}`;
  return `${args.conversationId}::subagent::${args.agentType}::${threadKey}`;
};

export const parseThreadCheckpoint = (
  content: string,
): ThreadCheckpoint | null => {
  const trimmed = content.trim();
  if (!trimmed.startsWith(THREAD_CHECKPOINT_MARKER)) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/);
  let previousThreadFile: string | undefined;
  let bodyStart = 1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) {
      bodyStart = index + 1;
      break;
    }
    if (line.toLowerCase().startsWith("previous thread file:")) {
      const value = line.slice("previous thread file:".length).trim();
      previousThreadFile = value || undefined;
    }
  }

  const summary = lines.slice(bodyStart).join("\n").trim();
  if (!summary) {
    return null;
  }
  return {
    summary,
    ...(previousThreadFile ? { previousThreadFile } : {}),
  };
};

export const formatThreadCheckpointMessage = (
  checkpoint: ThreadCheckpoint,
): string =>
  [
    THREAD_CHECKPOINT_MARKER,
    ...(checkpoint.previousThreadFile
      ? [`Previous thread file: ${checkpoint.previousThreadFile}`]
      : []),
    "",
    checkpoint.summary.trim(),
  ].join("\n");

const computeSummaryBudget = (messages: StoredThreadMessage[]): number =>
  Math.max(100, Math.floor(getThreadTokenEstimate(messages) * 0.2));

/**
 * Retry backoff for the summary request. Compaction runs at the moment of
 * heaviest provider usage, so transient failures (429/overloaded/network,
 * a credential-refresh blip) are expected — every attempt re-resolves the
 * API key and retries after the delay instead of failing the compaction.
 */
const THREAD_SUMMARY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

let summaryRetryDelaysMs: readonly number[] = THREAD_SUMMARY_RETRY_DELAYS_MS;

/** Test seam: shorten (or restore) the summary retry backoff. */
export const setThreadSummaryRetryDelaysForTest = (
  delays?: readonly number[],
): void => {
  summaryRetryDelaysMs = delays ?? THREAD_SUMMARY_RETRY_DELAYS_MS;
};

const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

/**
 * Estimated chars-per-token used to cap the summary request input. Deliberately
 * conservative (dense code/JSON runs ~3–3.5 chars per token, CJK far less) so
 * the capped request can never itself overflow the summarizer's window.
 */
const SUMMARY_INPUT_CHARS_PER_TOKEN = 3;

/**
 * Cap the formatted conversation fed to the summary model so a large backlog
 * of uncompacted turns can never push the request over the summarizer's
 * context window. Without this, one failed compaction lets the middle grow
 * turn over turn until every subsequent attempt overflows the window and
 * fails too — compaction then never recovers. Keeps the most recent tail
 * (the previous checkpoint summary already covers older ground) and notes
 * the elision.
 */
const capSummaryConversation = (
  formatted: string,
  maxChars: number,
): string => {
  if (maxChars <= 0 || formatted.length <= maxChars) {
    return formatted;
  }
  const omittedChars = formatted.length - maxChars;
  return [
    `[Compaction input truncated: the oldest ~${Math.round(
      omittedChars / SUMMARY_INPUT_CHARS_PER_TOKEN,
    )} tokens of unsummarized conversation were omitted so this request fits the summary model's context window. Rely on the previous summary (when present) for older details.]`,
    formatted.slice(formatted.length - maxChars),
  ].join("\n\n");
};

/**
 * Char budget for the formatted conversation in one summary request.
 * `overheadChars` accounts for everything else riding along in the request —
 * the system prompt, the previous checkpoint summary, the durable-memory
 * reference, and the prompt template — so the whole request stays inside
 * the model's window, not just the conversation part.
 */
const getSummaryInputCharBudget = (
  route: ResolvedLlmRoute,
  overheadChars: number,
): number =>
  Math.max(
    MIN_TRIGGER_TOKENS * SUMMARY_INPUT_CHARS_PER_TOKEN,
    Math.max(
      MIN_TRIGGER_TOKENS,
      getContextWindow(route) - THREAD_COMPACTION_RESERVE_TOKENS,
    ) *
      SUMMARY_INPUT_CHARS_PER_TOKEN -
      overheadChars,
  );

/**
 * Chunked compaction sizing. When the uncompacted middle cannot fit one
 * summary request in the current model's window (e.g. a thread built on a
 * large-window model continuing on a much smaller-window one after a model
 * switch), the middle is split into message-boundary chunks that are
 * summarized independently in parallel — every request stays bounded by the
 * current model's window regardless of total history size. The 0.5 input
 * fraction leaves the completion reserve plus slack for chars-per-token
 * underestimation and the summary prompt scaffolding.
 */
const CHUNKED_SUMMARY_INPUT_FRACTION = 0.5;
const CHUNKED_SUMMARY_MIN_CHUNK_CHARS = 20_000;
/** Char reserve for the prompt scaffolding riding along each chunk request. */
const CHUNKED_SUMMARY_PROMPT_OVERHEAD_CHARS = 40_000;
/**
 * Chunk summaries run in parallel; this caps how many near-window summary
 * requests are in flight at once so a huge history doesn't blast the
 * provider with a dozen simultaneous max-size requests (rate limits,
 * memory, and fairness to the user's own in-flight turns).
 */
const CHUNKED_SUMMARY_MAX_CONCURRENCY = 3;
/**
 * Bounds for the concatenated result: the final checkpoint must fit
 * comfortably inside the current model's window next turn, so the overall
 * output budget is capped to this fraction of the window and divided across
 * chunks; each chunk summary is also mechanically trimmed (no extra LLM
 * call) to its share plus slack.
 */
const CHUNKED_SUMMARY_TOTAL_OUTPUT_WINDOW_FRACTION = 0.2;
const CHUNKED_SUMMARY_MAX_CHUNK_OUTPUT_TOKENS = 6_000;
const CHUNKED_SUMMARY_MIN_CHUNK_OUTPUT_TOKENS = 200;
const CHUNKED_SUMMARY_TRIM_SLACK = 1.5;

/**
 * Non-conversation chars that ride along every summary request (system
 * prompt, previous checkpoint summary, durable-memory reference, and the
 * fixed prompt template). Shared by the single-pass budget check and
 * `generateThreadSummary` so the "does the middle fit one pass?" decision
 * uses the same accounting the request itself does.
 */
const estimateSummaryOverheadChars = (args: {
  systemPromptChars: number;
  previousSummary?: string;
  durableMemoryReference?: string;
}): number =>
  args.systemPromptChars +
  (args.previousSummary?.length ?? 0) +
  (args.durableMemoryReference?.length ?? 0) +
  SUMMARY_PROMPT_TEMPLATE_CHARS;

/**
 * Per-chunk char budget: half the model's usable window (leaving the
 * completion reserve and slack), minus the durable-memory reference and the
 * prompt scaffolding, floored at a minimum so a tiny window still makes
 * forward progress. Each chunk's own request is still capped by
 * `getSummaryInputCharBudget` inside `generateThreadSummary`.
 */
const getChunkedSummaryChunkCharBudget = (
  route: ResolvedLlmRoute,
  durableMemoryReference?: string,
): number =>
  Math.max(
    CHUNKED_SUMMARY_MIN_CHUNK_CHARS,
    Math.floor(
      Math.max(0, getContextWindow(route) - THREAD_COMPACTION_RESERVE_TOKENS) *
        CHUNKED_SUMMARY_INPUT_FRACTION,
    ) *
      SUMMARY_INPUT_CHARS_PER_TOKEN -
      (durableMemoryReference?.length ?? 0) -
      CHUNKED_SUMMARY_PROMPT_OVERHEAD_CHARS,
  );

/**
 * Split middle messages into chunks whose formatted representation fits
 * `chunkCharBudget`. Boundaries always land between stored messages; a
 * single message larger than the budget gets its own chunk (its request is
 * still bounded by the per-request input cap in `generateThreadSummary`).
 */
export const chunkThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
  chunkCharBudget: number,
): StoredThreadMessage[][] => {
  const chunks: StoredThreadMessage[][] = [];
  let current: StoredThreadMessage[] = [];
  let currentChars = 0;
  for (const message of messages) {
    const formattedChars = stringifyStoredMessage(message).reduce(
      (sum, entry) => sum + entry.length + 2,
      0,
    );
    if (current.length > 0 && currentChars + formattedChars > chunkCharBudget) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(message);
    currentChars += formattedChars;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

/** Char slack for the fixed prompt template (structure, guidelines, footer). */
const SUMMARY_PROMPT_TEMPLATE_CHARS = 4_000;

const SUMMARY_STRUCTURE = `## Topic
[What the conversation is about]

## Key Points
[Important information, decisions, and conclusions from the conversation]

## Current State
[Where things stand now — what has been done, what is in progress]

## Open Items
[Unresolved questions, pending tasks, or next steps discussed]`;

const buildSummaryGuidelines = (hasDurableMemoryReference: boolean): string =>
  [
    "Guidelines:",
    '- Thread ids: delegated/background work appears in the conversation as spawn_agent / send_input / check-status tool calls and results carrying a `thread_id`. Name that exact thread_id alongside every workstream you mention (e.g. "shell redesign polish — thread_id: shell-redesign-v2-full-polish") so follow-ups after this checkpoint route to the existing thread instead of spawning a duplicate.',
    "- Pending user decisions: any question posed to the user that was not yet answered by the end of the conversation goes under Open Items with the exact question quoted verbatim; if the user gave a partial or nuanced answer, quote the user's exact relevant words too. Never paraphrase half-answered decisions — quote them.",
    "- Resume-critical state: preserve the task objective and constraints; every working path, branch, and commit SHA; every child thread id with its status and concrete result; completed and unresolved work; and the latest user instruction. Quote the latest user instruction verbatim when its wording affects how work must resume.",
    "- Never return an empty or near-empty summary. After compaction this summary is the only carrier of the compacted span's thread-specific context, so it must stand alone: even if most of the conversation is already covered by durable memory or the previous summary, restate the thread-specific workstreams, decisions, current state, and open items. A bare heading or a one-line fragment is never an acceptable summary.",
    // The durable-memory rule only applies when the always-loaded docs are
    // actually injected for this agent (orchestrator); for other agents the
    // summary is the only carrier of such facts, so omitting them would lose
    // information.
    ...(hasDurableMemoryReference
      ? [
          "- Do not restate durable memory: facts already present in the ALREADY KNOWN section below (user profile facts, addresses, standing rules, workflow tiers, long-term preferences) must be omitted from the summary — the assistant is given that section separately on every turn. Summarize only thread-specific state.",
        ]
      : []),
  ].join("\n");

const buildAlreadyKnownSection = (
  durableMemoryReference: string | undefined,
): string =>
  durableMemoryReference?.trim()
    ? `ALREADY KNOWN (durable memory, injected separately on every turn — do NOT repeat any of this in the summary):
${durableMemoryReference.trim()}

`
    : "";

const buildSummaryPrompt = (
  formattedConversation: string,
  previousSummary: string | undefined,
  budget: number,
  durableMemoryReference?: string,
): string => {
  if (!formattedConversation) {
    return previousSummary?.trim() ?? "";
  }
  const guidelines = buildSummaryGuidelines(
    Boolean(durableMemoryReference?.trim()),
  );
  const alreadyKnown = buildAlreadyKnownSection(durableMemoryReference);
  const footer = `${guidelines}

Target ~${budget} tokens. Be factual — only include information that was explicitly discussed in the conversation. Do NOT invent file paths, commands, or details that were not mentioned. Write only the summary body.`;
  if (previousSummary?.trim()) {
    return `You are updating a conversation summary. A previous summary exists below. New conversation turns have occurred since then and need to be incorporated.

${alreadyKnown}PREVIOUS SUMMARY:
${previousSummary.trim()}

NEW TURNS TO INCORPORATE:
${formattedConversation}

Update the summary. PRESERVE existing information that is still relevant. ADD new information. Remove information only if it is clearly obsolete.

${SUMMARY_STRUCTURE}

${footer}`;
  }

  return `Create a concise summary of this conversation that preserves the important information for future context.

${alreadyKnown}CONVERSATION TO SUMMARIZE:
${formattedConversation}

Use this structure:

${SUMMARY_STRUCTURE}

${footer}`;
};

/**
 * Standalone per-segment prompt for chunked compaction. Unlike
 * `buildSummaryPrompt` there is no previous summary to update: each segment
 * is summarized independently (in parallel) and the segment summaries are
 * concatenated mechanically in chronological order, so the prompt tells the
 * model exactly that and asks for self-contained, chronology-friendly
 * output. Shares the structure, guidelines, and factuality footer with the
 * single-pass prompt so chunked checkpoints keep the same conventions.
 */
const buildChunkSummaryPrompt = (
  formattedConversation: string,
  segment: { index: number; count: number },
  budget: number,
  durableMemoryReference?: string,
): string => {
  const guidelines = buildSummaryGuidelines(
    Boolean(durableMemoryReference?.trim()),
  );
  const alreadyKnown = buildAlreadyKnownSection(durableMemoryReference);
  return `You are summarizing segment ${segment.index + 1} of ${segment.count} of a longer conversation. The other segments are summarized separately, and all segment summaries will be concatenated in chronological order to form one checkpoint — no model will merge them afterwards. Write a self-contained summary of THIS segment only: do not refer to a previous summary or to other segments' content, and when work in this segment clearly continues from before it or remains unfinished at its end, say so explicitly so the concatenation reads coherently.

${alreadyKnown}CONVERSATION SEGMENT TO SUMMARIZE:
${formattedConversation}

Use this structure:

${SUMMARY_STRUCTURE}

${guidelines}

Target ~${budget} tokens. Be factual — only include information that was explicitly discussed in this segment. Do NOT invent file paths, commands, or details that were not mentioned. Write only the summary body.`;
};

// Per-doc cap for the ALREADY KNOWN reference. The docs are small
// always-loaded files; the cap only guards against a runaway doc inflating
// the compaction request.
const DURABLE_MEMORY_DOC_MAX_CHARS = 8_000;

/**
 * Read one always-loaded durable-memory doc. Mirrors
 * `readResidentMemoryDoc` in runner/shared.ts, which cannot be imported here
 * without creating a module cycle (runner/shared → local-agent-manager →
 * subagent-session → pi-session-core → thread-memory → thread-runtime).
 */
const readDurableMemoryDoc = (filePath: string): string | undefined => {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content ? redactMemoryText(content) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Build the "already known — do not repeat" reference from the always-loaded
 * durable-memory docs (user profile + Dream memory summary), so the
 * summarizer can skip restating facts the assistant sees on every turn.
 */
export const buildDurableMemoryReference = (
  stellaDataDir: string | undefined,
): string | undefined => {
  if (!stellaDataDir?.trim()) {
    return undefined;
  }
  if (loadLocalPreferences(stellaDataDir).memoryEnabled === false) {
    return undefined;
  }
  const sections = [
    {
      label: "User profile (memories/profile.md)",
      docPath: path.join(stellaDataDir, "memories", "profile.md"),
    },
    {
      label: "Memory summary (memories/memory_summary.md)",
      docPath: path.join(stellaDataDir, "memories", "memory_summary.md"),
    },
  ]
    .map(({ label, docPath }) => {
      const text = readDurableMemoryDoc(docPath);
      if (!text) return "";
      const capped =
        text.length > DURABLE_MEMORY_DOC_MAX_CHARS
          ? `${text.slice(0, DURABLE_MEMORY_DOC_MAX_CHARS)}\n[truncated]`
          : text;
      return `### ${label}\n${capped}`;
    })
    .filter((section) => section.length > 0);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
};

const generateThreadSummary = async (args: {
  threadKey: string;
  messages: StoredThreadMessage[];
  previousSummary?: string;
  resolvedLlm: ResolvedLlmRoute;
  durableMemoryReference?: string;
  stellaDataDir?: string;
  requireAllChunks?: boolean;
  /**
   * Chunked mode: summarize segment `index` of `count` as a self-contained
   * standalone summary (no previous-summary update). The caller concatenates
   * the segment summaries mechanically in chronological order.
   */
  segment?: { index: number; count: number };
  /** Override for the ~token output target passed into the prompt. */
  outputBudgetTokens?: number;
}): Promise<{ text: string | null; reason?: string }> => {
  const systemPrompt = resolveThreadCompactionSystemPrompt(args.stellaDataDir);
  const previousSummary = args.previousSummary?.trim();
  const overheadChars = estimateSummaryOverheadChars({
    systemPromptChars: systemPrompt.length,
    previousSummary,
    durableMemoryReference: args.durableMemoryReference,
  });
  const formattedConversation = capSummaryConversation(
    formatThreadMessagesForCompaction(args.messages).trim(),
    getSummaryInputCharBudget(args.resolvedLlm, overheadChars),
  );
  if (!formattedConversation) {
    return {
      text: previousSummary || null,
      ...(!previousSummary ? { reason: "empty formatted conversation" } : {}),
    };
  }

  const outputBudget =
    args.outputBudgetTokens ?? computeSummaryBudget(args.messages);
  const promptBody = args.segment
    ? buildChunkSummaryPrompt(
        formattedConversation,
        args.segment,
        outputBudget,
        args.durableMemoryReference,
      )
    : buildSummaryPrompt(
        formattedConversation,
        previousSummary,
        outputBudget,
        args.durableMemoryReference,
      );

  // Every failure mode is treated as transient and retried with backoff:
  // provider errors (429/overloaded/network/400), thrown transport errors,
  // and a missing credential (the key is re-resolved per attempt so an
  // OAuth-refresh blip recovers). Only after the full schedule is exhausted
  // does compaction report failure.
  let reason = "summary generation failed";
  for (let attempt = 0; attempt <= summaryRetryDelaysMs.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(summaryRetryDelaysMs[attempt - 1]!);
    }
    try {
      const apiKey = (await args.resolvedLlm.getApiKey())?.trim();
      if (!apiKey) {
        reason = "no API key";
        logger.warn("thread.compaction.summary-attempt-failed", {
          threadKey: args.threadKey,
          model: args.resolvedLlm.model.id,
          attempt: attempt + 1,
          reason,
        });
        continue;
      }
      const message = await completeSimple(
        args.resolvedLlm.model,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: promptBody }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
        },
      );
      const text = readAssistantText(message);
      if (message.stopReason !== "stop") {
        reason = `unclean terminal reason ${String(message.stopReason)}`;
        logger.warn("thread.compaction.summary-attempt-failed", {
          threadKey: args.threadKey,
          model: args.resolvedLlm.model.id,
          attempt: attempt + 1,
          reason,
          errorMessage: message.errorMessage,
          partialChars: text.length,
        });
        continue;
      }
      if (!text) {
        reason = "empty output";
        logger.warn("thread.compaction.summary-attempt-failed", {
          threadKey: args.threadKey,
          model: args.resolvedLlm.model.id,
          attempt: attempt + 1,
          reason,
        });
        continue;
      }
      return { text };
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      logger.warn("thread.compaction.summary-attempt-failed", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        attempt: attempt + 1,
        reason,
      });
    }
  }
  return { text: null, reason };
};

/**
 * Parallel chunked compaction used when the middle cannot fit a single
 * summary request in the current model's window (e.g. a large thread
 * continuing on a smaller-context model after a model switch). Every chunk
 * is summarized independently and concurrently (bounded by
 * `CHUNKED_SUMMARY_MAX_CONCURRENCY`) with the standalone segment prompt, and
 * the results are combined mechanically — concatenated in chronological
 * order under "Part i/N" headings, with the previous checkpoint summary
 * carried verbatim up front — so no combiner LLM call is needed. Chunks that
 * still fail after their own retry schedule are counted and disclosed in the
 * final summary instead of failing the whole compaction; the raw messages
 * always remain in thread storage. The loop is strictly bounded: each chunk
 * is attempted exactly once by exactly one worker, and workers stop when the
 * chunk index is exhausted or a non-retryable failure aborts the run.
 */
const generateChunkedThreadSummary = async (args: {
  threadKey: string;
  middleMessages: StoredThreadMessage[];
  previousSummary?: string;
  resolvedLlm: ResolvedLlmRoute;
  durableMemoryReference?: string;
  stellaDataDir?: string;
}): Promise<{ text: string | null; reason?: string }> => {
  const chunkCharBudget = getChunkedSummaryChunkCharBudget(
    args.resolvedLlm,
    args.durableMemoryReference,
  );
  const chunks = chunkThreadMessagesForCompaction(
    args.middleMessages,
    chunkCharBudget,
  );
  const chunkCount = chunks.length;
  if (chunkCount === 0) {
    return { text: null, reason: "no chunks to summarize" };
  }
  // Cap the overall summary budget to a fraction of the CURRENT model's
  // window (not the — potentially enormous — middle) and divide it across
  // chunks, so the mechanically concatenated checkpoint fits the target
  // window with room for the kept tail and head. `perChunkOutputBudgetTokens`
  // applies its own minimum floor per chunk, so this only needs a small
  // positive floor to stay well-defined; it deliberately does not scale with
  // the middle.
  const totalOutputBudgetTokens = Math.max(
    CHUNKED_SUMMARY_MIN_CHUNK_OUTPUT_TOKENS,
    Math.min(
      computeSummaryBudget(args.middleMessages),
      Math.floor(
        getContextWindow(args.resolvedLlm) *
          CHUNKED_SUMMARY_TOTAL_OUTPUT_WINDOW_FRACTION,
      ),
    ),
  );
  const perChunkOutputBudgetTokens = Math.max(
    CHUNKED_SUMMARY_MIN_CHUNK_OUTPUT_TOKENS,
    Math.min(
      CHUNKED_SUMMARY_MAX_CHUNK_OUTPUT_TOKENS,
      Math.floor(totalOutputBudgetTokens / chunkCount),
    ),
  );
  const concurrency = Math.min(CHUNKED_SUMMARY_MAX_CONCURRENCY, chunkCount);
  logger.info("thread.compaction.chunked-start", {
    threadKey: args.threadKey,
    model: args.resolvedLlm.model.id,
    chunkCount,
    chunkCharBudget,
    perChunkOutputBudgetTokens,
    concurrency,
    middleTokens: getThreadTokenEstimate(args.middleMessages),
  });
  const chunkTokensList = chunks.map((chunkMessages) =>
    getThreadTokenEstimate(chunkMessages),
  );
  const results: Array<string | null> = new Array(chunkCount).fill(null);
  let lastFailureReason: string | undefined;
  let abortReason: string | undefined;
  let nextChunkIndex = 0;
  const worker = async (): Promise<void> => {
    while (abortReason === undefined) {
      const chunkIndex = nextChunkIndex;
      if (chunkIndex >= chunkCount) return;
      nextChunkIndex += 1;
      const chunkMessages = chunks[chunkIndex]!;
      const generated = await generateThreadSummary({
        threadKey: args.threadKey,
        messages: chunkMessages,
        resolvedLlm: args.resolvedLlm,
        segment: { index: chunkIndex, count: chunkCount },
        outputBudgetTokens: perChunkOutputBudgetTokens,
        ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
        ...(args.durableMemoryReference
          ? { durableMemoryReference: args.durableMemoryReference }
          : {}),
      });
      if (generated.text) {
        results[chunkIndex] = generated.text;
        continue;
      }
      lastFailureReason = generated.reason ?? "summary generation failed";
      // A missing credential can never succeed on any chunk either; stop
      // pulling new chunks and report the failure instead of folding most of
      // the history unnarrated.
      if (generated.reason === "no API key") {
        abortReason = generated.reason;
        return;
      }
      logger.warn("thread.compaction.chunk-summary-failed", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        chunkIndex,
        chunkCount,
        chunkTokens: chunkTokensList[chunkIndex],
        reason: lastFailureReason,
      });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (abortReason !== undefined) {
    return { text: null, reason: abortReason };
  }
  const successfulChunks = results.filter((text) => text !== null).length;
  if (successfulChunks === 0) {
    return {
      text: null,
      reason: lastFailureReason ?? "all chunk summaries failed",
    };
  }
  if (args.requireAllChunks && successfulChunks !== chunkCount) {
    return {
      text: null,
      reason: lastFailureReason ?? "one or more chunk summaries failed",
    };
  }
  // Mechanical combine: chronological concatenation, no combiner LLM call.
  const previousSummary = args.previousSummary?.trim();
  const perChunkTrimChars = Math.floor(
    perChunkOutputBudgetTokens *
      SUMMARY_INPUT_CHARS_PER_TOKEN *
      CHUNKED_SUMMARY_TRIM_SLACK,
  );
  let foldedWithoutNarrationTokens = 0;
  const parts: string[] = [];
  if (previousSummary) {
    parts.push(
      `## Earlier context (previous checkpoint summary)\n\n${previousSummary}`,
    );
  }
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const text = results[chunkIndex];
    const partLabel =
      chunkCount > 1 ? `## Part ${chunkIndex + 1}/${chunkCount}\n\n` : "";
    if (text === null) {
      foldedWithoutNarrationTokens += chunkTokensList[chunkIndex]!;
      parts.push(
        `${partLabel}[~${chunkTokensList[chunkIndex]} tokens of history in this segment were folded without narration after repeated summary failures; the raw messages remain in thread storage.]`,
      );
      continue;
    }
    parts.push(`${partLabel}${truncateForSummary(text, perChunkTrimChars)}`);
  }
  const summary = (
    chunkCount > 1
      ? [
          `[This checkpoint was compacted in ${chunkCount} parallel segment summaries; the parts below are in chronological order.]`,
          ...parts,
        ]
      : parts
  ).join("\n\n");
  if (foldedWithoutNarrationTokens > 0) {
    logger.warn("thread.compaction.chunked-partial", {
      threadKey: args.threadKey,
      model: args.resolvedLlm.model.id,
      chunkCount,
      successfulChunks,
      foldedWithoutNarrationTokens,
    });
  }
  return { text: summary };
};

export const summarizeCanonicalCatchUp = async (args: {
  threadKey: string;
  messages: StoredThreadMessage[];
  resolvedLlm: ResolvedLlmRoute;
  stellaDataDir?: string;
}): Promise<{ text: string | null; reason?: string }> =>
  generateChunkedThreadSummary({
    threadKey: args.threadKey,
    middleMessages: args.messages,
    resolvedLlm: args.resolvedLlm,
    requireAllChunks: true,
    ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
  });

/**
 * Result of an attempted thread compaction.
 *
 * Returns `compacted: true` only when an overlay was actually written
 * to the store; every short-circuit path (empty thread, below trigger,
 * no valid cut point, summary generation produced an empty string)
 * returns `compacted: false` so the caller can avoid downstream
 * side-effects (e.g. flagging a long-lived `OrchestratorSession`'s
 * in-memory mirror as stale, which forces a full rebuild of
 * `agent.state.messages` from the store and defeats the prompt-cache
 * stability the long-lived session was meant to provide).
 */
export type ThreadCompactionResult = {
  compacted: boolean;
};

/**
 * Count the contiguous bootstrap startup docs (personality, core memory) at
 * the very top of a thread. These are hidden `runtimeInternal` messages
 * injected once on the first turn and persisted as `bootstrap.*` custom
 * messages — they must stay pinned at the top across compactions.
 */
export const countLeadingBootstrapStartupDocs = (
  messages: StoredThreadMessage[],
): number => {
  let count = 0;
  for (const message of messages) {
    const customType = message.customMessage?.customType;
    if (
      message.role === "runtimeInternal" &&
      typeof customType === "string" &&
      customType.startsWith("bootstrap.")
    ) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
};

/**
 * Head-message protection differs by agent role. Subagents are short-lived
 * task sessions, so we pin a fixed window of leading messages to keep their
 * task framing intact. The orchestrator is one long-lived conversation where
 * the first user turn is just old history — only its bootstrap startup docs
 * (personality + core memory) stay pinned at the top; everything after them is
 * fair game for compaction.
 */
export const resolveCompactionProtectHeadMessages = (
  agentType: string,
  messages: StoredThreadMessage[],
): number =>
  agentType === AGENT_IDS.ORCHESTRATOR
    ? countLeadingBootstrapStartupDocs(messages)
    : // Subagents pin their fixed task-framing window AND any leading
      // bootstrap docs (which can exceed the fixed window once a resident
      // fold has re-pinned the full doc set at the head).
      Math.max(
        THREAD_COMPACTION_PROTECT_HEAD_MESSAGES,
        countLeadingBootstrapStartupDocs(messages),
      );

/**
 * Retry schedule for the final overlay write. `compactThread` is a local
 * SQLite write; a busy/locked database is transient and must not fail a
 * compaction whose summary already generated successfully.
 */
const COMPACTION_STORE_WRITE_RETRY_DELAYS_MS = [250, 1_000];

const resolveKeepRecentTokens = (route: ResolvedLlmRoute): number =>
  Math.min(
    THREAD_COMPACTION_KEEP_RECENT_TOKENS,
    Math.floor(
      getContextWindow(route) * THREAD_COMPACTION_KEEP_RECENT_WINDOW_PCT,
    ),
  );

export const maybeCompactRuntimeThread = async (args: {
  store: RuntimeStore;
  threadKey: string;
  resolvedLlm: ResolvedLlmRoute;
  agentType: string;
  overrideSummary?: string;
  preserveLastN?: number;
  /**
   * When set, the always-loaded durable-memory docs under this data dir are
   * passed to the summarizer as an "already known — do not repeat" reference.
   */
  stellaDataDir?: string;
}): Promise<ThreadCompactionResult> => {
  const storedMessages = args.store.loadThreadMessages(args.threadKey);
  if (storedMessages.length === 0) {
    return { compacted: false };
  }

  const totalTokens = getThreadTokenEstimate(storedMessages);
  const forced = isThreadCompactionForced(args.threadKey);
  // Compaction fires on whichever ceiling is reached first: the history-only estimate
  // hitting 0.7x the window, OR the last measured full outbound payload (system prompt
  // + tool schemas + resident context + history, captured at preflight) reaching the
  // payload-pressure trigger. The second condition closes the
  // history-under-trigger-but-payload-over-budget gap on large-toolset engines (Codex)
  // that would otherwise only ever be caught reactively by the pre-dispatch preflight.
  const lastPayloadTokens = getLastProviderPayloadTokens(args.threadKey);
  const historyOverTrigger =
    totalTokens >= getCompactionTriggerTokens(args.resolvedLlm);
  const payloadOverTrigger =
    lastPayloadTokens !== undefined &&
    lastPayloadTokens >= getCompactionPayloadTriggerTokens(args.resolvedLlm);
  if (!forced && !historyOverTrigger && !payloadOverTrigger) {
    return { compacted: false };
  }

  const preserveLastN =
    Number.isFinite(args.preserveLastN) && args.preserveLastN !== undefined
      ? Math.max(0, Math.floor(args.preserveLastN))
      : THREAD_COMPACTION_MIN_TAIL_MESSAGES;
  let splitMessages = splitThreadMessagesForCompaction(
    storedMessages,
    resolveCompactionProtectHeadMessages(args.agentType, storedMessages),
    resolveKeepRecentTokens(args.resolvedLlm),
    preserveLastN,
  );
  if (!splitMessages && forced) {
    // Emergency split for an overflow that the standard cut points cannot
    // relieve (e.g. a few enormous messages inside the protected head or
    // tail). Only the orchestrator's bootstrap docs stay pinned; everything
    // up to the last message is compactable.
    splitMessages = splitThreadMessagesForCompaction(
      storedMessages,
      // Even in the emergency split, leading bootstrap docs stay pinned for
      // every agent type — they are resident context, and cutting through
      // them would anchor the overlay on a fold-synthetic entryId.
      countLeadingBootstrapStartupDocs(storedMessages),
      0,
      1,
    );
  }
  if (!splitMessages) {
    return { compacted: false };
  }

  const durableMemoryReference =
    args.agentType === AGENT_IDS.ORCHESTRATOR
      ? buildDurableMemoryReference(args.stellaDataDir)
      : undefined;
  let summary = args.overrideSummary?.trim() || null;
  if (!summary) {
    // Single-pass compaction is the default. When the uncompacted middle is
    // too large to fit one summary request in the current model's window
    // (e.g. a big thread continuing on a smaller-context model after a model
    // switch), capping it into a single pass would silently drop the oldest
    // unsummarized history from the checkpoint — so route to parallel chunked
    // compaction, which fits every request to the window without losing the
    // over-budget span. The threshold uses the same input accounting the
    // single-pass request itself does.
    const systemPromptChars = resolveThreadCompactionSystemPrompt(
      args.stellaDataDir,
    ).length;
    const singlePassBudget = getSummaryInputCharBudget(
      args.resolvedLlm,
      estimateSummaryOverheadChars({
        systemPromptChars,
        previousSummary: splitMessages.previousSummary,
        durableMemoryReference,
      }),
    );
    const formattedMiddleChars = formatThreadMessagesForCompaction(
      splitMessages.middleMessages,
    ).trim().length;
    const generated =
      formattedMiddleChars > singlePassBudget
        ? await generateChunkedThreadSummary({
            threadKey: args.threadKey,
            middleMessages: splitMessages.middleMessages,
            previousSummary: splitMessages.previousSummary,
            resolvedLlm: args.resolvedLlm,
            stellaDataDir: args.stellaDataDir,
            durableMemoryReference,
          })
        : await generateThreadSummary({
            threadKey: args.threadKey,
            messages: splitMessages.middleMessages,
            previousSummary: splitMessages.previousSummary,
            resolvedLlm: args.resolvedLlm,
            stellaDataDir: args.stellaDataDir,
            durableMemoryReference,
          });
    summary = generated.text;
    if (!summary) {
      logger.error("thread.compaction.summary-failed-final", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        reason: generated.reason,
        middleTokens: getThreadTokenEstimate(splitMessages.middleMessages),
        totalTokens,
      });
      return { compacted: false };
    }
  }

  // Resident-block fold-in: compaction is the one moment the prompt-cache
  // prefix is legitimately dead, so re-render every resident block from
  // current state and carry the fresh copies on the compaction entry. The
  // overlay materializer (`storage/session-store.js`) pins exactly one
  // fresh copy of each block at the head of the rebuilt window and sweeps
  // all older copies + accumulated `runtime.context_delta.*` appends —
  // which also heals legacy threads that accumulated duplicate doc appends.
  // Best-effort: a fold failure must never fail a compaction.
  let residentFold: unknown = null;
  try {
    residentFold = buildResidentFold({
      messages: storedMessages,
      ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
      refreshMemoryDocsFromDisk: args.stellaDataDir
        ? loadLocalPreferences(args.stellaDataDir).memoryEnabled !== false
        : false,
    });
  } catch (error) {
    residentFold = null;
    logger.warn("thread.compaction.resident-fold-failed", {
      threadKey: args.threadKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (
    let attempt = 0;
    attempt <= COMPACTION_STORE_WRITE_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    if (attempt > 0) {
      await sleep(COMPACTION_STORE_WRITE_RETRY_DELAYS_MS[attempt - 1]!);
    }
    try {
      args.store.compactThread({
        threadKey: args.threadKey,
        summary,
        fromEntryId: splitMessages.fromEntryId,
        toEntryId: splitMessages.toEntryId,
        tokensBefore: totalTokens,
        ...(residentFold ? { details: { residentFold } } : {}),
      });
      args.store.updateThreadSummary(args.threadKey, summary);
      return { compacted: true };
    } catch (error) {
      if (attempt === COMPACTION_STORE_WRITE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      logger.warn("thread.compaction.store-write-retry", {
        threadKey: args.threadKey,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { compacted: true };
};
