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
import { isThreadCompactionForced } from "./agent-runtime/context-budget.js";
import { loadLocalPreferences } from "./preferences/local-preferences.js";

const logger = createRuntimeLogger("thread-runtime");

const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";
export const resolveThreadCompactionSystemPrompt = (
  _stellaDataDir?: string,
): string => readRuntimePrompt("thread-compaction") ?? "";
const THREAD_COMPACTION_RESERVE_TOKENS = 16_384;
/**
 * Fraction of the model's real context window at which the orchestrator
 * thread store compacts. Keyed off `route.model.contextWindow` (the real,
 * provider-catalog-derived window) so the trigger scales with the active model
 * instead of a fixed token budget.
 */
const THREAD_COMPACTION_TRIGGER_PCT = 0.7;
const THREAD_COMPACTION_PROTECT_HEAD_MESSAGES = 3;
const THREAD_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
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

const getContextWindow = (route: ResolvedLlmRoute): number => {
  const value = Number(route.model.contextWindow);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
  return Math.floor(value);
};

export const getCompactionTriggerTokens = (route: ResolvedLlmRoute): number =>
  Math.max(
    MIN_TRIGGER_TOKENS,
    Math.floor(getContextWindow(route) * THREAD_COMPACTION_TRIGGER_PCT),
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

const THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS = 2_000;
const THREAD_SUMMARY_MAX_GENERATION_ATTEMPTS = 2;
/**
 * A recursive summary covers the previous checkpoint plus the new middle, so
 * a candidate under half the previous summary's visible size is information
 * loss rather than successful compression.
 */
const THREAD_SUMMARY_NEVER_SHRINK_RATIO = 0.5;
/**
 * Refusing an invalid summary preserves history, but repeated failures near
 * the model's hard limit eventually require a marked best-effort checkpoint
 * before the provider truncates the head itself.
 */
const THREAD_COMPACTION_HARD_LIMIT_ESCALATION_PCT = 0.9;
const THREAD_COMPACTION_ESCALATION_MIN_FAILURES = 2;

const consecutiveSummaryFailures = new Map<string, number>();

/** Test seam: clear escalation failure tracking between test cases. */
export const resetThreadSummaryFailureTracking = (threadKey?: string): void => {
  if (threadKey === undefined) {
    consecutiveSummaryFailures.clear();
  } else {
    consecutiveSummaryFailures.delete(threadKey);
  }
};

const THREAD_SUMMARY_HEADINGS = [
  "Topic",
  "Key Points",
  "Current State",
  "Open Items",
] as const;

export type ThreadSummaryValidation = {
  valid: boolean;
  reason?: string;
  visibleCodePoints: number;
  wordCount: number;
  uniqueWordCount: number;
};

const normalizeSummaryForValidation = (summary: string): string =>
  summary
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[^\S\r\n]+/gu, " ")
    .trim();

const countVisibleCodePoints = (value: string): number =>
  Array.from(normalizeSummaryForValidation(value)).filter(
    (codePoint) => !/\s/u.test(codePoint),
  ).length;

const segmentSummaryWords = (summary: string): string[] => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  return Array.from(segmenter.segment(summary))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.toLocaleLowerCase());
};

const summarySectionBodies = (summary: string): Map<string, string> => {
  const matches = Array.from(
    summary.matchAll(
      /^##\s*(Topic|Key Points|Current State|Open Items)\s*$/gimu,
    ),
  );
  const sections = new Map<string, string>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const heading = match[1]!.toLocaleLowerCase();
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? summary.length;
    sections.set(heading, summary.slice(bodyStart, bodyEnd).trim());
  }
  return sections;
};

const longestRepeatedCodePointRun = (value: string): number => {
  let longest = 0;
  let current = 0;
  let previous = "";
  for (const codePoint of value) {
    if (codePoint === previous) current += 1;
    else {
      previous = codePoint;
      current = 1;
    }
    longest = Math.max(longest, current);
  }
  return longest;
};

/**
 * Validate the information carrier that will replace a folded thread span.
 * This uses normalized Unicode code points, requires all durable sections for
 * large spans, rejects template echoes/repetition/gibberish, and prevents a
 * recursive summary from shrinking below half its predecessor.
 */
export const validateThreadSummary = (
  summary: string,
  middleTokens: number,
  previousSummary?: string,
): ThreadSummaryValidation => {
  const normalized = normalizeSummaryForValidation(summary);
  const visible = Array.from(normalized).filter(
    (codePoint) => !/\s/u.test(codePoint),
  );
  const words = segmentSummaryWords(normalized);
  const uniqueWords = new Set(words);
  const base = {
    visibleCodePoints: visible.length,
    wordCount: words.length,
    uniqueWordCount: uniqueWords.size,
  };
  if (!normalized || visible.length === 0) {
    return { valid: false, reason: "no visible content", ...base };
  }

  const previousVisible = previousSummary
    ? countVisibleCodePoints(previousSummary)
    : 0;
  if (
    previousVisible > 0 &&
    visible.length < previousVisible * THREAD_SUMMARY_NEVER_SHRINK_RATIO
  ) {
    return {
      valid: false,
      reason: `shrank below never-shrink floor (${visible.length} visible vs previous ${previousVisible})`,
      ...base,
    };
  }

  if (middleTokens < THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS) {
    return { valid: true, ...base };
  }

  const sections = summarySectionBodies(normalized);
  const missingSection = THREAD_SUMMARY_HEADINGS.find(
    (heading) =>
      !segmentSummaryWords(sections.get(heading.toLowerCase()) ?? "").length,
  );
  if (missingSection) {
    return {
      valid: false,
      reason: `missing informative ## ${missingSection} section`,
      ...base,
    };
  }

  const scale = Math.max(
    0,
    Math.log2(middleTokens / THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS),
  );
  const minVisibleCodePoints = Math.min(150, Math.round(64 + scale * 14));
  const minWords = Math.min(24, Math.round(10 + scale * 2));
  if (visible.length < minVisibleCodePoints || words.length < minWords) {
    return {
      valid: false,
      reason: `insufficient information for ${middleTokens} folded tokens`,
      ...base,
    };
  }

  const placeholderFragments = [
    "[what the conversation is about]",
    "important information, decisions, and conclusions from the conversation",
    "where things stand now — what has been done, what is in progress",
    "unresolved questions, pending tasks, or next steps discussed",
  ];
  const lower = normalized.toLocaleLowerCase();
  if (placeholderFragments.some((fragment) => lower.includes(fragment))) {
    return { valid: false, reason: "template boilerplate", ...base };
  }

  const frequencies = new Map<string, number>();
  for (const word of words) {
    frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  }
  const mostCommonWord = Math.max(0, ...frequencies.values());
  const uniqueRatio = uniqueWords.size / Math.max(1, words.length);
  const withoutDividerRuns = normalized.replace(/[=\-_*#~─]{3,}/gu, " ");
  if (
    (words.length >= 12 && uniqueRatio < 0.3) ||
    mostCommonWord / Math.max(1, words.length) > 0.3 ||
    longestRepeatedCodePointRun(withoutDividerRuns) >= 16
  ) {
    return { valid: false, reason: "extreme repetition", ...base };
  }

  const longAsciiWords = words.filter((word) => /^[a-z]{5,}$/u.test(word));
  const vowelFreeWords = longAsciiWords.filter(
    (word) => !/[aeiouy]/u.test(word),
  );
  if (
    longAsciiWords.length >= 12 &&
    vowelFreeWords.length / longAsciiWords.length > 0.55
  ) {
    return {
      valid: false,
      reason: "gibberish-like token distribution",
      ...base,
    };
  }

  return { valid: true, ...base };
};

/**
 * Estimated chars-per-token used to cap the summary request input.
 */
const SUMMARY_INPUT_CHARS_PER_TOKEN = 4;

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

const getSummaryInputCharBudget = (route: ResolvedLlmRoute): number =>
  Math.max(
    MIN_TRIGGER_TOKENS,
    getContextWindow(route) - THREAD_COMPACTION_RESERVE_TOKENS,
  ) * SUMMARY_INPUT_CHARS_PER_TOKEN;

/**
 * Chunked compaction sizing. When the uncompacted middle cannot fit one
 * summary request in the current model's window (e.g. a thread built on a
 * large-window model continuing on a smaller-window one), the middle is
 * split into message-boundary chunks that are summarized independently in
 * parallel — every request stays bounded by the current model's window
 * regardless of total history size. The 0.5 input fraction leaves the
 * completion reserve plus slack for chars-per-token underestimation and the
 * summary prompt scaffolding.
 */
const CHUNKED_SUMMARY_INPUT_FRACTION = 0.5;
const CHUNKED_SUMMARY_MIN_CHUNK_CHARS = 20_000;
/** Char reserve for the prompt scaffolding and retry corrections. */
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
 * single message larger than the budget gets its own chunk (the per-request
 * input cap in `generateThreadSummary` still bounds it).
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
  correctiveReason?: string,
): string => {
  if (!formattedConversation) {
    return previousSummary?.trim() ?? "";
  }
  const guidelines = buildSummaryGuidelines(
    Boolean(durableMemoryReference?.trim()),
  );
  const alreadyKnown = buildAlreadyKnownSection(durableMemoryReference);
  const correction = correctiveReason
    ? `RETRY CORRECTION: The previous summary was rejected (${correctiveReason}). Return all four required headings with specific, non-repetitive facts. Do not return placeholders, invisible text, or a fragment.\n\n`
    : "";
  const footer = `${correction}${guidelines}

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
  correctiveReason?: string,
): string => {
  const guidelines = buildSummaryGuidelines(
    Boolean(durableMemoryReference?.trim()),
  );
  const alreadyKnown = buildAlreadyKnownSection(durableMemoryReference);
  const correction = correctiveReason
    ? `RETRY CORRECTION: The previous summary was rejected (${correctiveReason}). Return all four required headings with specific, non-repetitive facts. Do not return placeholders, invisible text, or a fragment.\n\n`
    : "";
  return `You are summarizing segment ${segment.index + 1} of ${segment.count} of a longer conversation. The other segments are summarized separately, and all segment summaries will be concatenated in chronological order to form one checkpoint — no model will merge them afterwards. Write a self-contained summary of THIS segment only: do not refer to a previous summary or to other segments' content, and when work in this segment clearly continues from before it or remains unfinished at its end, say so explicitly so the concatenation reads coherently.

${alreadyKnown}CONVERSATION SEGMENT TO SUMMARIZE:
${formattedConversation}

Use this structure:

${SUMMARY_STRUCTURE}

${correction}${guidelines}

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
  correctiveReason?: string;
  /** Chunked mode: summarize segment `index` of `count` standalone. */
  segment?: { index: number; count: number };
  /** Override for the ~token output target in the prompt. */
  outputBudgetTokens?: number;
}): Promise<{ text: string | null; retryable: boolean; reason?: string }> => {
  const apiKey = (await args.resolvedLlm.getApiKey())?.trim();
  if (!apiKey) {
    // Silent-null here previously hid every failed compaction; keep the
    // benign no-credential skip but make it diagnosable.
    logger.warn("thread.compaction.summary-skipped", {
      threadKey: args.threadKey,
      reason: "no-api-key",
      model: args.resolvedLlm.model.id,
    });
    return { text: null, retryable: false, reason: "no API key" };
  }

  const formattedConversation = capSummaryConversation(
    formatThreadMessagesForCompaction(args.messages).trim(),
    getSummaryInputCharBudget(args.resolvedLlm),
  );
  if (!formattedConversation) {
    return {
      text: args.previousSummary?.trim() || null,
      retryable: false,
      ...(!args.previousSummary?.trim()
        ? { reason: "empty formatted conversation" }
        : {}),
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
        args.correctiveReason,
      )
    : buildSummaryPrompt(
        formattedConversation,
        args.previousSummary,
        outputBudget,
        args.durableMemoryReference,
        args.correctiveReason,
      );

  // LLM failures propagate to `compactRuntimeThreadHistory`, which logs
  // `thread.compaction.failed` — a swallowed error here previously made
  // compaction fail invisibly on every turn (e.g. the Fable-5
  // `thinking.type.disabled` 400).
  const message = await completeSimple(
    args.resolvedLlm.model,
    {
      systemPrompt: resolveThreadCompactionSystemPrompt(args.stellaDataDir),
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
    logger.warn("thread.compaction.summary-failed", {
      threadKey: args.threadKey,
      model: args.resolvedLlm.model.id,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      partialChars: text.length,
    });
    return {
      text: null,
      retryable: true,
      reason: `unclean terminal reason ${String(message.stopReason)}`,
    };
  }
  if (!text) {
    logger.warn("thread.compaction.summary-empty", {
      threadKey: args.threadKey,
      model: args.resolvedLlm.model.id,
    });
    return { text: null, retryable: true, reason: "empty output" };
  }
  return { text, retryable: false };
};

/**
 * Parallel chunked compaction used when the middle cannot fit (or repeatedly
 * failed) a single summary request with the current model. Every chunk is
 * summarized independently and concurrently (bounded by
 * `CHUNKED_SUMMARY_MAX_CONCURRENCY`) with the standalone segment prompt, and
 * the results are combined mechanically — concatenated in chronological
 * order under "Part i/N" headings, with the previous checkpoint summary
 * carried verbatim up front — so no combiner LLM call is needed. Chunks that
 * still fail after retries are counted and disclosed in the final summary
 * instead of failing the whole compaction; the raw messages always remain in
 * thread storage.
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
  // Divide the overall summary budget across chunks so the mechanical
  // concatenation cannot exceed what a single-pass summary would have been
  // allowed, and always fits comfortably in the current model's window.
  const totalOutputBudgetTokens = Math.min(
    computeSummaryBudget(args.middleMessages),
    Math.floor(
      getContextWindow(args.resolvedLlm) *
        CHUNKED_SUMMARY_TOTAL_OUTPUT_WINDOW_FRACTION,
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
      const chunkTokens = chunkTokensList[chunkIndex]!;
      let chunkSummary: string | null = null;
      let correctiveReason: string | undefined;
      for (
        let attempt = 1;
        !chunkSummary && attempt <= THREAD_SUMMARY_MAX_GENERATION_ATTEMPTS;
        attempt += 1
      ) {
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
          ...(correctiveReason ? { correctiveReason } : {}),
        });
        if (generated.text) {
          const validation = validateThreadSummary(generated.text, chunkTokens);
          if (validation.valid) {
            chunkSummary = generated.text;
            break;
          }
          correctiveReason = validation.reason ?? "invalid summary";
          logger.warn("thread.compaction.chunk-summary-invalid", {
            threadKey: args.threadKey,
            model: args.resolvedLlm.model.id,
            chunkIndex,
            chunkCount,
            attempt,
            reason: validation.reason,
          });
        } else {
          correctiveReason = generated.reason ?? "summary generation failed";
          if (!generated.retryable) {
            // e.g. no API key: nothing else will succeed either; stop
            // pulling new chunks and report the failure instead of folding
            // the history unnarrated.
            abortReason = correctiveReason;
            return;
          }
        }
      }
      if (chunkSummary) {
        results[chunkIndex] = chunkSummary;
        continue;
      }
      lastFailureReason = correctiveReason;
      logger.warn("thread.compaction.chunk-summary-failed", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        chunkIndex,
        chunkCount,
        chunkTokens,
        reason: correctiveReason,
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
    : THREAD_COMPACTION_PROTECT_HEAD_MESSAGES;

/**
 * Last-resort checkpoint for repeated validation failures at the hard context
 * limit. Prefer the previous checkpoint, then the best rejected candidate,
 * and always mark the bridge as potentially stale. Raw entries remain stored.
 */
export const buildCompactionEscalationSummary = (args: {
  previousSummary?: string;
  bestInvalidCandidate?: string | null;
  middleTokens: number;
}): string => {
  const marker = `[compaction summary refresh failed ${new Date()
    .toISOString()
    .slice(0, 10)}; state may lag]`;
  const carried =
    args.previousSummary?.trim() || args.bestInvalidCandidate?.trim();
  if (carried) {
    return `${marker}\n\n${carried}`;
  }
  return [
    marker,
    "",
    "## Topic",
    "Fallback checkpoint written without a fresh summary.",
    "## Key Points",
    `Summary generation failed repeatedly while this thread approached its context limit; ~${args.middleTokens} tokens of history were folded without narration. The raw messages remain in thread storage and are searchable.`,
    "## Current State",
    "Rely on the visible recent messages and durable memory docs for standing context.",
    "## Open Items",
    "Produce a healthy checkpoint at the next compaction.",
  ].join("\n");
};

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
  if (
    !isThreadCompactionForced(args.threadKey) &&
    totalTokens < getCompactionTriggerTokens(args.resolvedLlm)
  ) {
    return { compacted: false };
  }

  const preserveLastN =
    Number.isFinite(args.preserveLastN) && args.preserveLastN !== undefined
      ? Math.max(0, Math.floor(args.preserveLastN))
      : THREAD_COMPACTION_MIN_TAIL_MESSAGES;
  const splitMessages = splitThreadMessagesForCompaction(
    storedMessages,
    resolveCompactionProtectHeadMessages(args.agentType, storedMessages),
    THREAD_COMPACTION_KEEP_RECENT_TOKENS,
    preserveLastN,
  );
  if (!splitMessages) {
    return { compacted: false };
  }

  const middleTokens = getThreadTokenEstimate(splitMessages.middleMessages);
  let summary: string | null = null;
  let correctiveReason: string | undefined;
  const overrideSummary = args.overrideSummary?.trim();
  if (overrideSummary) {
    const validation = validateThreadSummary(
      overrideSummary,
      middleTokens,
      splitMessages.previousSummary,
    );
    if (validation.valid) {
      summary = overrideSummary;
    } else {
      correctiveReason = `hook override: ${validation.reason ?? "invalid summary"}`;
      logger.warn("thread.compaction.override-invalid-fallback", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        reason: validation.reason,
        visibleCodePoints: validation.visibleCodePoints,
        wordCount: validation.wordCount,
        middleTokens,
      });
    }
  }

  const durableMemoryReference =
    args.agentType === AGENT_IDS.ORCHESTRATOR
      ? buildDurableMemoryReference(args.stellaDataDir)
      : undefined;
  let bestInvalidCandidate: string | null = null;
  // A middle too large for one summary request in the current model's window
  // (e.g. a large thread continuing on a smaller-context model) goes straight
  // to chunked compaction below; capping it into a single pass would silently
  // drop the oldest unsummarized history from the checkpoint.
  const needsChunkedCompaction =
    formatThreadMessagesForCompaction(splitMessages.middleMessages).trim()
      .length > getSummaryInputCharBudget(args.resolvedLlm);
  for (
    let attempt = 1;
    !summary &&
    !needsChunkedCompaction &&
    attempt <= THREAD_SUMMARY_MAX_GENERATION_ATTEMPTS;
    attempt += 1
  ) {
    const generated = await generateThreadSummary({
      threadKey: args.threadKey,
      messages: splitMessages.middleMessages,
      previousSummary: splitMessages.previousSummary,
      resolvedLlm: args.resolvedLlm,
      stellaDataDir: args.stellaDataDir,
      durableMemoryReference,
      ...(correctiveReason ? { correctiveReason } : {}),
    });
    if (generated.text) {
      const validation = validateThreadSummary(
        generated.text,
        middleTokens,
        splitMessages.previousSummary,
      );
      if (validation.valid) {
        summary = generated.text;
        break;
      }
      bestInvalidCandidate = generated.text;
      correctiveReason = validation.reason ?? "invalid summary";
      logger.warn("thread.compaction.summary-invalid", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        attempt,
        reason: validation.reason,
        visibleCodePoints: validation.visibleCodePoints,
        wordCount: validation.wordCount,
        uniqueWordCount: validation.uniqueWordCount,
        middleTokens,
      });
    } else {
      correctiveReason = generated.reason ?? "summary generation failed";
      if (!generated.retryable) break;
    }
  }
  if (!summary && needsChunkedCompaction && correctiveReason !== "no API key") {
    // Parallel chunked compaction is reserved for history that cannot fit a
    // single request. Invalid or unclean single-pass output must not fan out
    // into many equivalent retries; those failures keep the existing bounded
    // two-attempt behavior and escalation path.
    const chunked = await generateChunkedThreadSummary({
      threadKey: args.threadKey,
      middleMessages: splitMessages.middleMessages,
      ...(splitMessages.previousSummary
        ? { previousSummary: splitMessages.previousSummary }
        : {}),
      resolvedLlm: args.resolvedLlm,
      ...(durableMemoryReference ? { durableMemoryReference } : {}),
      ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
    });
    if (chunked.text) {
      // Every constituent segment was validated before mechanical assembly.
      // Re-validating the concatenation as one ordinary summary incorrectly
      // flags its intentionally repeated section headings as repetition.
      summary = chunked.text;
    } else if (chunked.reason) {
      correctiveReason = chunked.reason;
    }
  }
  if (!summary) {
    const countsTowardEscalation = correctiveReason !== "no API key";
    const failureCount = countsTowardEscalation
      ? (consecutiveSummaryFailures.get(args.threadKey) ?? 0) + 1
      : (consecutiveSummaryFailures.get(args.threadKey) ?? 0);
    if (countsTowardEscalation) {
      consecutiveSummaryFailures.set(args.threadKey, failureCount);
    }
    const hardLimitTokens = Math.floor(
      getContextWindow(args.resolvedLlm) *
        THREAD_COMPACTION_HARD_LIMIT_ESCALATION_PCT,
    );
    const shouldEscalate =
      countsTowardEscalation &&
      failureCount >= THREAD_COMPACTION_ESCALATION_MIN_FAILURES &&
      totalTokens >= hardLimitTokens;
    if (!shouldEscalate) {
      logger.error("thread.compaction.summary-invalid-final", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        reason: correctiveReason,
        middleTokens,
        consecutiveFailures: failureCount,
        totalTokens,
        hardLimitTokens,
      });
      return { compacted: false };
    }
    summary = buildCompactionEscalationSummary({
      previousSummary: splitMessages.previousSummary,
      bestInvalidCandidate,
      middleTokens,
    });
    logger.error("thread.compaction.summary-escalation", {
      threadKey: args.threadKey,
      model: args.resolvedLlm.model.id,
      reason: correctiveReason,
      consecutiveFailures: failureCount,
      totalTokens,
      hardLimitTokens,
      carriedForwardPrevious: Boolean(splitMessages.previousSummary?.trim()),
      usedInvalidCandidate:
        !splitMessages.previousSummary?.trim() &&
        Boolean(bestInvalidCandidate?.trim()),
    });
  }
  consecutiveSummaryFailures.delete(args.threadKey);

  args.store.compactThread({
    threadKey: args.threadKey,
    summary,
    fromEntryId: splitMessages.fromEntryId,
    toEntryId: splitMessages.toEntryId,
    tokensBefore: totalTokens,
  });
  args.store.updateThreadSummary(args.threadKey, summary);
  return { compacted: true };
};
