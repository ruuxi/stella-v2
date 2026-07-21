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
import { readHomePrompt } from "./prompts/home-prompts.js";
import {
  THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS,
  validateThreadSummary,
} from "./thread-summary-validation.js";
export { validateThreadSummary } from "./thread-summary-validation.js";
export type { ThreadSummaryValidation } from "./thread-summary-validation.js";

const logger = createRuntimeLogger("thread-runtime");

const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";
export const resolveThreadCompactionSystemPrompt = (
  stellaDataDir?: string,
): string =>
  stellaDataDir
    ? (readHomePrompt(stellaDataDir, "thread-compaction") ?? "")
    : "";
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

const THREAD_SUMMARY_MAX_GENERATION_ATTEMPTS = 2;
const THREAD_COMPACTION_HARD_LIMIT_ESCALATION_PCT = 0.9;
const THREAD_COMPACTION_ESCALATION_MIN_FAILURES = 2;
const THREAD_COMPACTION_FALLBACK_EXCERPT_CHARS = 1_200;

/**
 * Consecutive eligible summary failures per thread. This state is deliberately
 * process-local: a restart requires another bounded failed cycle before the
 * near-ceiling fallback can run. Only the latest-started cycle may mutate the
 * streak or write an overlay, so overlapping scheduler/manual attempts cannot
 * manufacture two "consecutive" failures or let a stale completion win.
 * Successful generation, abort, and no-credential skips break the streak.
 */
const consecutiveSummaryFailures = new Map<string, number>();
const latestSummaryCycle = new Map<string, number>();
let nextSummaryCycle = 0;

const beginSummaryCycle = (threadKey: string): number => {
  nextSummaryCycle += 1;
  latestSummaryCycle.set(threadKey, nextSummaryCycle);
  return nextSummaryCycle;
};

const isLatestSummaryCycle = (threadKey: string, cycle: number): boolean =>
  latestSummaryCycle.get(threadKey) === cycle;

const clearSummaryFailureStreak = (threadKey: string, cycle: number): void => {
  if (!isLatestSummaryCycle(threadKey, cycle)) return;
  consecutiveSummaryFailures.delete(threadKey);
};

const recordSummaryFailure = (threadKey: string, cycle: number): number => {
  if (!isLatestSummaryCycle(threadKey, cycle)) return 0;
  const count = (consecutiveSummaryFailures.get(threadKey) ?? 0) + 1;
  consecutiveSummaryFailures.set(threadKey, count);
  return count;
};

/** Test seam for isolating near-ceiling failure tracking. */
export const resetThreadSummaryFailureTracking = (threadKey?: string): void => {
  if (threadKey === undefined) {
    consecutiveSummaryFailures.clear();
    latestSummaryCycle.clear();
    return;
  }
  consecutiveSummaryFailures.delete(threadKey);
  latestSummaryCycle.delete(threadKey);
};

const isAbortLikeSummaryFailure = (
  error: unknown,
  abortSignal?: AbortSignal,
): boolean => {
  if (abortSignal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    /^(?:request was aborted|request aborted|aborted|canceled|cancelled)\.?$/i.test(
      error.message.trim(),
    )
  );
};

/**
 * Estimated chars-per-token used to cap the summary request input.
 */
const SUMMARY_INPUT_CHARS_PER_TOKEN = 4;
const THREAD_SUMMARY_OUTPUT_MAX_TOKENS = 2_048;
const THREAD_SUMMARY_OUTPUT_MIN_TOKENS = 512;
const THREAD_SUMMARY_OUTPUT_CONTEXT_RATIO = 0.125;
const THREAD_SUMMARY_REQUEST_MIN_SAFETY_TOKENS = 512;
const THREAD_SUMMARY_REQUEST_MAX_RESERVE_TOKENS = 16_384;

const fitTextToCharLimit = (
  value: string,
  maxChars: number,
  suffix = "\n[truncated]",
): string => {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (suffix.length >= maxChars) return suffix.slice(0, maxChars);
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
};

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
  if (maxChars <= 0) {
    return "";
  }
  if (formatted.length <= maxChars) {
    return formatted;
  }
  const omittedChars = formatted.length - maxChars;
  const marker = `[Compaction input truncated: the oldest ~${Math.round(
    omittedChars / SUMMARY_INPUT_CHARS_PER_TOKEN,
  )} tokens of unsummarized conversation were omitted so this request fits the summary model's context window. Rely on the previous summary (when present) for older details.]`;
  const separator = "\n\n";
  const tailChars = Math.max(0, maxChars - marker.length - separator.length);
  return fitTextToCharLimit(
    `${marker}${separator}${formatted.slice(-tailChars)}`,
    maxChars,
    "",
  );
};

export type ThreadSummaryRequestLimits = {
  contextTokens: number;
  maxOutputTokens: number;
  safetyTokens: number;
  maxInputChars: number;
};

export const getThreadSummaryRequestLimits = (
  route: ResolvedLlmRoute,
): ThreadSummaryRequestLimits => {
  const contextTokens = Math.max(MIN_TRIGGER_TOKENS, getContextWindow(route));
  const maxOutputTokens = Math.min(
    THREAD_SUMMARY_OUTPUT_MAX_TOKENS,
    Math.max(
      THREAD_SUMMARY_OUTPUT_MIN_TOKENS,
      Math.floor(contextTokens * THREAD_SUMMARY_OUTPUT_CONTEXT_RATIO),
    ),
  );
  // Preserve the historical 16k request reserve on normal/large windows,
  // while scaling it down on the smallest supported window. The reserve is
  // explicit output allowance plus framing/token-estimation safety; output is
  // deliberately small so compaction cannot crowd its own input off the wire.
  const reservedTokens = Math.min(
    THREAD_SUMMARY_REQUEST_MAX_RESERVE_TOKENS,
    Math.max(
      maxOutputTokens + THREAD_SUMMARY_REQUEST_MIN_SAFETY_TOKENS,
      Math.floor(contextTokens * 0.25),
    ),
  );
  const safetyTokens = reservedTokens - maxOutputTokens;
  const inputTokens = Math.max(
    0,
    contextTokens - maxOutputTokens - safetyTokens,
  );
  return {
    contextTokens,
    maxOutputTokens,
    safetyTokens,
    maxInputChars: inputTokens * SUMMARY_INPUT_CHARS_PER_TOKEN,
  };
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
    "- Never return an empty or near-empty summary. After compaction this summary is the only visible carrier of the compacted span's thread-specific context, so it must stand alone. A bare heading, template echo, or one-line fragment is never acceptable.",
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

export const buildThreadSummaryRequest = (args: {
  formattedConversation: string;
  previousSummary?: string;
  summaryBudget: number;
  durableMemoryReference?: string;
  correctiveReason?: string;
  systemPrompt: string;
  resolvedLlm: ResolvedLlmRoute;
}): {
  systemPrompt: string;
  promptBody: string;
  maxOutputTokens: number;
  limits: ThreadSummaryRequestLimits;
} => {
  const limits = getThreadSummaryRequestLimits(args.resolvedLlm);
  const systemPrompt = fitTextToCharLimit(
    args.systemPrompt,
    Math.floor(limits.maxInputChars * 0.1),
  );
  const previousSummary = args.previousSummary?.trim()
    ? fitTextToCharLimit(
        args.previousSummary.trim(),
        Math.floor(limits.maxInputChars * 0.2),
      )
    : undefined;
  const durableMemoryReference = args.durableMemoryReference?.trim()
    ? fitTextToCharLimit(
        args.durableMemoryReference.trim(),
        Math.floor(limits.maxInputChars * 0.2),
      )
    : undefined;
  const correctiveReason = args.correctiveReason?.trim()
    ? fitTextToCharLimit(args.correctiveReason.trim(), 512, "")
    : undefined;
  const targetBudget = Math.min(
    limits.maxOutputTokens,
    Math.max(100, Math.floor(args.summaryBudget)),
  );

  // Build once with a one-character conversation to measure every fixed
  // component: scaffolding, previous summary, durable-memory reference,
  // correction text, and output instructions. The remaining input allowance
  // belongs to the newest conversation tail.
  const fixedPrompt = buildSummaryPrompt(
    "x",
    previousSummary,
    targetBudget,
    durableMemoryReference,
    correctiveReason,
  );
  const conversationChars = Math.max(
    0,
    limits.maxInputChars - systemPrompt.length - (fixedPrompt.length - 1),
  );
  const formattedConversation = capSummaryConversation(
    args.formattedConversation,
    conversationChars,
  );
  let promptBody = buildSummaryPrompt(
    formattedConversation ||
      "[No conversation text retained within the request budget.]",
    previousSummary,
    targetBudget,
    durableMemoryReference,
    correctiveReason,
  );

  // Defensive final fence for future scaffold growth. The safety-token reserve
  // accounts for provider message framing/JSON beyond these two strings.
  const promptCharLimit = Math.max(
    0,
    limits.maxInputChars - systemPrompt.length,
  );
  promptBody = fitTextToCharLimit(promptBody, promptCharLimit, "");

  return {
    systemPrompt,
    promptBody,
    maxOutputTokens: limits.maxOutputTokens,
    limits,
  };
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
  abortSignal?: AbortSignal;
}): Promise<{
  text: string | null;
  retryable: boolean;
  reason?: string;
}> => {
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

  const formattedConversation = formatThreadMessagesForCompaction(
    args.messages,
  ).trim();
  if (!formattedConversation) {
    return {
      text: args.previousSummary?.trim() || null,
      retryable: false,
      ...(!args.previousSummary?.trim()
        ? { reason: "empty formatted conversation" }
        : {}),
    };
  }

  const request = buildThreadSummaryRequest({
    formattedConversation,
    previousSummary: args.previousSummary,
    summaryBudget: computeSummaryBudget(args.messages),
    durableMemoryReference: args.durableMemoryReference,
    correctiveReason: args.correctiveReason,
    systemPrompt: resolveThreadCompactionSystemPrompt(args.stellaDataDir),
    resolvedLlm: args.resolvedLlm,
  });

  // LLM failures propagate to `compactRuntimeThreadHistory`, which logs
  // `thread.compaction.failed` — a swallowed error here previously made
  // compaction fail invisibly on every turn (e.g. the Fable-5
  // `thinking.type.disabled` 400).
  const message = await completeSimple(
    args.resolvedLlm.model,
    {
      systemPrompt: request.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.promptBody }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      maxTokens: request.maxOutputTokens,
      ...(args.abortSignal ? { signal: args.abortSignal } : {}),
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
      retryable: message.stopReason !== "aborted",
      reason:
        message.stopReason === "aborted"
          ? "aborted"
          : `unclean terminal reason ${String(message.stopReason)}`,
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
export type ThreadCompactionResult =
  | { compacted: false }
  | {
      compacted: true;
      /** Exact summary written to the checkpoint overlay and summary index. */
      summary: string;
      /** True only when the persisted summary was the accepted hook override. */
      fromOverride: boolean;
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
 * Last-resort checkpoint for a thread that repeatedly failed summary
 * validation while approaching the provider's context ceiling. Provider text
 * is intentionally excluded: a malformed or incomplete candidate must never
 * become the durable checkpoint. A known-good previous checkpoint is carried
 * forward when available; otherwise a bounded mechanical skeleton records the
 * loss of narration while raw entries remain in thread storage.
 */
export const buildCompactionEscalationSummary = (args: {
  previousSummary?: string;
  middleTokens: number;
}): string => {
  const marker = `[compaction summary refresh failed ${new Date()
    .toISOString()
    .slice(0, 10)}; state may lag]`;
  const previousSummary = args.previousSummary?.trim();
  const previousSummaryIsSafe = Boolean(
    previousSummary &&
    validateThreadSummary(previousSummary, THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS)
      .valid,
  );
  if (previousSummary && previousSummaryIsSafe) {
    return [
      marker,
      "",
      previousSummary,
      "",
      "## Compaction Recovery Note",
      `A fresh summary could not be accepted near the context ceiling. The prior validated checkpoint was carried forward; ~${args.middleTokens} newly folded tokens are not narrated here. Their raw entries remain in thread storage.`,
    ].join("\n");
  }
  const boundedTokenCount = Math.max(
    0,
    Math.min(args.middleTokens, Number.MAX_SAFE_INTEGER),
  );
  const summary = [
    marker,
    "",
    "## Topic",
    "Mechanical fallback checkpoint after repeated summary failures.",
    "",
    "## Key Points",
    `About ${boundedTokenCount} tokens were folded without accepting provider-generated summary text. The raw messages remain in thread storage.`,
    "",
    "## Current State",
    "Recent visible messages and durable memory remain authoritative while summary generation recovers.",
    "",
    "## Open Items",
    "Produce a healthy validated checkpoint at the next compaction opportunity.",
  ].join("\n");
  return truncateWithSuffix(
    summary,
    THREAD_COMPACTION_FALLBACK_EXCERPT_CHARS,
    "",
  );
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
  /** Aborts the summarization LLM call on scheduler shutdown. */
  abortSignal?: AbortSignal;
}): Promise<ThreadCompactionResult> => {
  const storedMessages = args.store.loadThreadMessages(args.threadKey);
  if (storedMessages.length === 0) {
    return { compacted: false };
  }

  const totalTokens = getThreadTokenEstimate(storedMessages);
  if (totalTokens < getCompactionTriggerTokens(args.resolvedLlm)) {
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

  const summaryCycle = beginSummaryCycle(args.threadKey);
  const middleTokens = getThreadTokenEstimate(splitMessages.middleMessages);
  let summary: string | null = null;
  let summaryFromOverride = false;
  let correctiveReason: string | undefined;
  let summaryGenerationError: unknown;
  const overrideSummary = args.overrideSummary?.trim();
  if (overrideSummary) {
    const validation = validateThreadSummary(
      overrideSummary,
      middleTokens,
      splitMessages.previousSummary,
    );
    if (validation.valid) {
      summary = overrideSummary;
      summaryFromOverride = true;
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
  for (
    let attempt = 1;
    !summary && attempt <= THREAD_SUMMARY_MAX_GENERATION_ATTEMPTS;
    attempt += 1
  ) {
    if (args.abortSignal?.aborted) {
      correctiveReason = "aborted";
      break;
    }
    let generated: Awaited<ReturnType<typeof generateThreadSummary>>;
    try {
      generated = await generateThreadSummary({
        threadKey: args.threadKey,
        messages: splitMessages.middleMessages,
        previousSummary: splitMessages.previousSummary,
        resolvedLlm: args.resolvedLlm,
        stellaDataDir: args.stellaDataDir,
        durableMemoryReference,
        ...(correctiveReason ? { correctiveReason } : {}),
        ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      });
    } catch (error) {
      if (isAbortLikeSummaryFailure(error, args.abortSignal)) {
        correctiveReason = "aborted";
        break;
      }
      summaryGenerationError = error;
      correctiveReason = `provider failure: ${error instanceof Error ? error.message : String(error)}`;
      logger.warn("thread.compaction.summary-provider-failed", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
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
      continue;
    }
    correctiveReason = generated.reason ?? "summary generation failed";
    if (generated.reason === "aborted") {
      break;
    }
    if (!generated.retryable) {
      break;
    }
  }
  if (!summary) {
    const countsTowardEscalation =
      correctiveReason !== "no API key" &&
      correctiveReason !== "aborted" &&
      !args.abortSignal?.aborted;
    const failureCount = countsTowardEscalation
      ? recordSummaryFailure(args.threadKey, summaryCycle)
      : 0;
    if (!countsTowardEscalation) {
      clearSummaryFailureStreak(args.threadKey, summaryCycle);
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
      if (summaryGenerationError !== undefined) {
        throw summaryGenerationError;
      }
      return { compacted: false };
    }
    summary = buildCompactionEscalationSummary({
      previousSummary: splitMessages.previousSummary,
      middleTokens,
    });
    const carriedForwardPrevious = Boolean(
      splitMessages.previousSummary?.trim() &&
      validateThreadSummary(
        splitMessages.previousSummary,
        THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS,
      ).valid,
    );
    logger.error("thread.compaction.summary-escalation", {
      threadKey: args.threadKey,
      model: args.resolvedLlm.model.id,
      reason: correctiveReason,
      consecutiveFailures: failureCount,
      totalTokens,
      hardLimitTokens,
      carriedForwardPrevious,
    });
  }
  clearSummaryFailureStreak(args.threadKey, summaryCycle);
  // Shutdown abort landed after the summary settled: skip the store write
  // rather than racing SQLite teardown.
  if (args.abortSignal?.aborted) {
    return { compacted: false };
  }
  if (!isLatestSummaryCycle(args.threadKey, summaryCycle)) {
    logger.warn("thread.compaction.stale-cycle-skipped", {
      threadKey: args.threadKey,
      model: args.resolvedLlm.model.id,
      summaryCycle,
      latestCycle: latestSummaryCycle.get(args.threadKey),
    });
    return { compacted: false };
  }

  args.store.compactThread({
    threadKey: args.threadKey,
    summary,
    fromEntryId: splitMessages.fromEntryId,
    toEntryId: splitMessages.toEntryId,
    tokensBefore: totalTokens,
    summaryValidation: {
      middleTokens,
      ...(splitMessages.previousSummary !== undefined
        ? { previousSummary: splitMessages.previousSummary }
        : {}),
    },
    fromHook: summaryFromOverride,
  });
  args.store.updateThreadSummary(args.threadKey, summary);
  return { compacted: true, summary, fromOverride: summaryFromOverride };
};
