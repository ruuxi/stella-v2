import { completeSimple, readAssistantText } from "../ai/stream.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "./storage/shared.js";
import { ORCHESTRATOR_ROSTER_CUSTOM_TYPE } from "./storage/shared.js";
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
import {
  CONTEXT_DELTA_CUSTOM_TYPE_PREFIX,
  PINNED_INSTRUCTION_ENTRY_ID_MARKER,
  RESIDENT_FOLD_ENTRY_ID_MARKER,
  buildResidentFold,
} from "./agent-runtime/resident-context.js";
import {
  QUARANTINE_CUSTOM_TYPE,
  QUARANTINE_PLACEHOLDER,
  parseQuarantineRecord,
  toolResultQuarantineKey,
} from "./agent-runtime/provider-abort-containment.js";
import { loadLocalPreferences } from "./preferences/local-preferences.js";

const logger = createRuntimeLogger("thread-runtime");

const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";
export const resolveThreadCompactionSystemPrompt = (): string =>
  readRuntimePrompt("thread-compaction") ?? "";
const THREAD_COMPACTION_RESERVE_TOKENS = 49_152;
/**
 * Fraction of the model's real context window at which a thread compacts.
 * Keyed off `route.model.contextWindow` (the real, provider-catalog-derived
 * window) so the trigger scales with the active model. Compared against the
 * full model-visible request — the last preflight-measured outbound payload
 * (system prompt + tool schemas + resident context + history) when one has
 * been captured, with the history-only estimate as the floor for threads
 * that have not dispatched a turn yet (e.g. right after a worker restart).
 */
const THREAD_COMPACTION_TRIGGER_PCT = 0.5;
const THREAD_COMPACTION_PROTECT_HEAD_MESSAGES = 3;
const THREAD_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
/**
 * Fraction of the model's window the kept tail may occupy. Bounds the fixed
 * keep-recent budget on small-window models so a compaction always frees
 * enough room for the retry to fit.
 *
 * Orchestrator-only. General/subagent compaction uses a fixed 20k tail
 * (pi-mono) with a small-window safety clamp instead of this 10% policy.
 */
const THREAD_COMPACTION_KEEP_RECENT_WINDOW_PCT = 0.1;
const THREAD_COMPACTION_MIN_TAIL_MESSAGES = 2;
/**
 * Char cap for the pinned copy of the latest user instruction carried
 * verbatim across a compaction checkpoint (~3-4k tokens). The pin never
 * moves the tail cut — its cost is exactly one capped message.
 *
 * Orchestrator-only. General/subagent compaction follows pi-mono and does
 * not emit a synthetic pin.
 */
const THREAD_COMPACTION_PINNED_INSTRUCTION_MAX_CHARS = 12_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MIN_TRIGGER_TOKENS = 8_000;
/**
 * General/subagent compaction trigger. Deliberately not pi-mono's
 * `window - 16k` and not the orchestrator's 50%.
 */
const GENERAL_COMPACTION_TRIGGER_PCT = 0.6;
/** Fixed verbatim tail for general/subagent compaction (pi-mono). */
const GENERAL_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
/**
 * Smallest compatibility guard for a fixed 20k tail on tiny windows: if
 * keeping 20k would leave fewer than this many tokens for the checkpoint
 * summary and remaining head, shrink the tail so compaction can still free
 * space. Never used on typical 80k+ windows and not the orchestrator's 10%
 * policy.
 */
const GENERAL_COMPACTION_SMALL_WINDOW_RESERVE_TOKENS = 4_096;
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
  checkpointQuarantineKeys?: string[];
};

type ThreadCheckpoint = {
  summary: string;
};

export type ThreadCompactionPlan = {
  previousSummary?: string;
  fromEntryId: string;
  toEntryId: string;
  middleMessages: StoredThreadMessage[];
  /**
   * The latest role=user message of the thread when it falls inside the
   * summarized middle (a follow-up `description\n\nmessage` turn or an
   * active-steer `Task update:` turn). The overlay re-emits a capped verbatim
   * copy of it right after the checkpoint so the agent never loses its
   * current instruction to a summary. The tail cut is never moved for it.
   *
   * Orchestrator-only. General/subagent compaction follows pi-mono and does
   * not carry a synthetic pin.
   */
  latestUserMessage?: StoredThreadMessage;
  /**
   * General/subagent split-turn: messages from the current turn start up to
   * (but not including) the retained tail. Summarized with the turn-prefix
   * prompt; the suffix stays verbatim.
   */
  turnPrefixMessages?: StoredThreadMessage[];
  isSplitTurn?: boolean;
};

export type ThreadCompactionSplitPolicy = "orchestrator" | "general";

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
  if (message.customMessage?.customType === QUARANTINE_CUSTOM_TYPE) {
    return [];
  }
  if (message.payload) {
    if (
      message.payload.role === "assistant" &&
      (message.payload.stopReason === "error" ||
        message.payload.stopReason === "aborted" ||
        !message.payload.content.some(
          (block) =>
            block.type === "toolCall" ||
            (block.type === "text" && block.text.trim().length > 0),
        ))
    ) {
      return [];
    }
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

const formatThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
): string =>
  messages
    .filter((message) => {
      const customType = message.customMessage?.customType;
      return (
        !customType?.startsWith("bootstrap.") &&
        !customType?.startsWith(CONTEXT_DELTA_CUSTOM_TYPE_PREFIX) &&
        customType !== ORCHESTRATOR_ROSTER_CUSTOM_TYPE
      );
    })
    .flatMap((message) => stringifyStoredMessage(message))
    .filter((entry) => entry.length > 0)
    .join("\n\n");

const quarantinedToolResultKeys = (
  messages: StoredThreadMessage[],
): Set<string> =>
  new Set(
    messages.flatMap((message) => {
      if (message.customMessage?.customType !== QUARANTINE_CUSTOM_TYPE) {
        return [];
      }
      const record = parseQuarantineRecord(message.customMessage.content);
      return record ? [record.key] : [];
    }),
  );

const latestCheckpointQuarantineKeys = (
  messages: StoredThreadMessage[],
): Set<string> => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (parseThreadCheckpoint(message.content)) {
      return new Set(message.checkpointQuarantineKeys ?? []);
    }
  }
  return new Set();
};

const maskQuarantinedCompactionMessages = (
  messages: StoredThreadMessage[],
  quarantinedKeys: Set<string>,
): StoredThreadMessage[] => {
  if (quarantinedKeys.size === 0) return messages;
  return messages.map((message) => {
    const payload = message.payload;
    if (
      payload?.role !== "toolResult" ||
      !quarantinedKeys.has(toolResultQuarantineKey(payload))
    ) {
      return message;
    }
    return {
      ...message,
      content: QUARANTINE_PLACEHOLDER,
      payload: {
        ...payload,
        content: [{ type: "text", text: QUARANTINE_PLACEHOLDER }],
      },
    };
  });
};

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

export const resolveCompactionSplitPolicy = (
  agentType?: string,
): ThreadCompactionSplitPolicy =>
  !agentType || agentType === AGENT_IDS.ORCHESTRATOR
    ? "orchestrator"
    : "general";

export const getCompactionTriggerTokens = (
  route: ResolvedLlmRoute,
  agentType?: string,
): number => {
  const triggerPct =
    resolveCompactionSplitPolicy(agentType) === "general"
      ? GENERAL_COMPACTION_TRIGGER_PCT
      : THREAD_COMPACTION_TRIGGER_PCT;
  return Math.max(
    MIN_TRIGGER_TOKENS,
    Math.floor(getContextWindow(route) * triggerPct),
  );
};

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

/**
 * A pinned latest-user-instruction copy materialized by a previous overlay.
 * Like checkpoint messages, these are overlay artifacts: they are excluded
 * from the summarized middle (their content already reached the summarizer
 * the first time around) and must never anchor a compaction span.
 */
const isPinnedInstructionMessage = (message: StoredThreadMessage): boolean =>
  message.entryId?.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER) ?? false;

/** Plain text of a user message, preferring the persisted payload blocks. */
const extractUserMessageText = (message: StoredThreadMessage): string => {
  if (message.payload?.role === "user") {
    const content = message.payload.content;
    if (typeof content === "string") {
      return content;
    }
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return message.content;
};

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

const findContainingToolCallGroup = (
  messages: StoredThreadMessage[],
  messageIndex: number,
): { startIndex: number; endIndex: number } | null => {
  for (let startIndex = messageIndex; startIndex >= 0; startIndex -= 1) {
    const assistant = messages[startIndex];
    if (!assistant) return null;
    if (assistant.role !== "assistant") continue;
    if (!hasToolCalls(assistant)) return null;

    const callIds = getToolCallIds(assistant);
    const matchedCallIds = new Set<string>();
    let endIndex = startIndex;
    for (let index = startIndex + 1; index < messages.length; index += 1) {
      const message = messages[index]!;
      // Live user steering and runtime notices are persisted immediately and
      // can therefore appear between an assistant tool call and the result
      // that the running Agent records later. Only a newer assistant turn ends
      // ownership of the tool-call group.
      if (message.role === "assistant") break;
      endIndex = index;
      const toolCallId = getToolResultId(message);
      if (toolCallId && callIds.has(toolCallId)) {
        matchedCallIds.add(toolCallId);
        if (matchedCallIds.size === callIds.size) break;
      }
    }
    return messageIndex <= endIndex ? { startIndex, endIndex } : null;
  }
  return null;
};

const alignBoundaryForward = (
  messages: StoredThreadMessage[],
  index: number,
): number => {
  if (index <= 0 || index >= messages.length) {
    return index;
  }
  const containingGroup = findContainingToolCallGroup(messages, index);
  return containingGroup && index > containingGroup.startIndex
    ? containingGroup.endIndex + 1
    : index;
};

const alignBoundaryBackward = (
  messages: StoredThreadMessage[],
  index: number,
): number => {
  if (index <= 0 || index >= messages.length) {
    return index;
  }
  const containingGroup = findContainingToolCallGroup(messages, index);
  return containingGroup && index > containingGroup.startIndex
    ? containingGroup.startIndex
    : index;
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
    .filter(
      (message) =>
        !isCompactionMessage(message) && !isPinnedInstructionMessage(message),
    );
  if (middleMessages.length === 0) {
    return null;
  }

  // The latest user instruction must survive compaction verbatim, but with
  // bounded cost: when it sits inside the summarized middle it is carried
  // across the checkpoint as one capped pinned copy (re-emitted by the
  // overlay materializer) — the tail cut is never moved back for it.
  let latestUserMessage: StoredThreadMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") {
      continue;
    }
    if (index >= compressionStart && index < tailStartIndex) {
      latestUserMessage = message;
    }
    break;
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
    toEntryId.includes(RESIDENT_FOLD_ENTRY_ID_MARKER) ||
    fromEntryId.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER) ||
    toEntryId.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER)
  ) {
    return null;
  }

  return {
    ...(previousSummary ? { previousSummary } : {}),
    fromEntryId,
    toEntryId,
    middleMessages,
    ...(latestUserMessage ? { latestUserMessage } : {}),
  };
};

const isValidGeneralCutMessage = (message: StoredThreadMessage): boolean => {
  if (isCompactionMessage(message) || isPinnedInstructionMessage(message)) {
    return false;
  }
  if (message.role === "toolResult") {
    return false;
  }
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "runtimeInternal" ||
    Boolean(message.customMessage)
  );
};

const findGeneralTurnStartIndex = (
  messages: StoredThreadMessage[],
  cutIndex: number,
  startIndex: number,
): number => {
  for (let index = cutIndex; index >= startIndex; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      return index;
    }
    if (message.customMessage) {
      return index;
    }
  }
  return -1;
};

const findGeneralCutPoint = (
  messages: StoredThreadMessage[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): { firstKeptIndex: number; turnStartIndex: number; isSplitTurn: boolean } => {
  const cutPoints: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const message = messages[index];
    if (message && isValidGeneralCutMessage(message)) {
      cutPoints.push(index);
    }
  }
  if (cutPoints.length === 0) {
    return {
      firstKeptIndex: startIndex,
      turnStartIndex: -1,
      isSplitTurn: false,
    };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;
  if (keepRecentTokens <= 0) {
    cutIndex = cutPoints[cutPoints.length - 1]!;
  } else {
    for (let index = endIndex - 1; index >= startIndex; index -= 1) {
      const message = messages[index];
      if (!message) {
        continue;
      }
      accumulatedTokens += estimateStoredMessageTokens(message);
      if (accumulatedTokens >= keepRecentTokens) {
        for (const candidate of cutPoints) {
          if (candidate >= index) {
            cutIndex = candidate;
            break;
          }
        }
        break;
      }
    }
  }

  cutIndex = alignBoundaryForward(messages, cutIndex);
  const cutMessage = messages[cutIndex];
  const isUserMessage = cutMessage?.role === "user";
  const turnStartIndex = isUserMessage
    ? -1
    : findGeneralTurnStartIndex(messages, cutIndex, startIndex);
  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
};

const extractFilePathFromToolArgs = (
  args: Record<string, unknown> | undefined,
): string | undefined => {
  if (!args) {
    return undefined;
  }
  for (const key of ["file_path", "path"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const extractFileOpsFromStoredMessage = (
  message: StoredThreadMessage,
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
): void => {
  if (message.role !== "assistant" || message.payload?.role !== "assistant") {
    return;
  }
  for (const block of message.payload.content) {
    if (block.type !== "toolCall") {
      continue;
    }
    const pathArg = extractFilePathFromToolArgs(
      (block.arguments ?? {}) as Record<string, unknown>,
    );
    if (!pathArg) {
      continue;
    }
    const name = block.name.toLowerCase();
    if (name === "read") {
      fileOps.read.add(pathArg);
    } else if (name === "write") {
      fileOps.written.add(pathArg);
    } else if (name === "edit") {
      fileOps.edited.add(pathArg);
    }
  }
};

const collectFileOperations = (
  messages: StoredThreadMessage[],
): { readFiles: string[]; modifiedFiles: string[] } => {
  const fileOps = {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
  for (const message of messages) {
    extractFileOpsFromStoredMessage(message, fileOps);
  }
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
};

export const formatFileOperationsForSummary = (
  readFiles: string[],
  modifiedFiles: string[],
): string => {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
};

/**
 * Pi-mono-style compaction plan for general agents and subagents.
 * Never used by the orchestrator. Does not pin the latest user instruction.
 */
export const splitGeneralThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
  protectHeadMessages = THREAD_COMPACTION_PROTECT_HEAD_MESSAGES,
  keepRecentTokens = GENERAL_COMPACTION_KEEP_RECENT_TOKENS,
): ThreadCompactionPlan | null => {
  if (messages.length <= protectHeadMessages + 1) {
    return null;
  }

  let lastCheckpointIndex = -1;
  let previousSummary: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const summary = parseThreadCheckpoint(
      messages[index]?.content ?? "",
    )?.summary;
    if (typeof summary === "string" && summary.trim().length > 0) {
      lastCheckpointIndex = index;
      previousSummary = summary;
      break;
    }
  }

  let compressionStart = Math.min(protectHeadMessages, messages.length);
  if (lastCheckpointIndex >= compressionStart) {
    // Chained compaction (pi-mono): only summarize messages after the latest
    // checkpoint; the previous structured summary is updated in place.
    compressionStart = lastCheckpointIndex + 1;
  }
  compressionStart = alignBoundaryForward(messages, compressionStart);
  if (compressionStart >= messages.length) {
    return null;
  }

  const cut = findGeneralCutPoint(
    messages,
    compressionStart,
    messages.length,
    keepRecentTokens,
  );
  if (cut.firstKeptIndex <= compressionStart) {
    return null;
  }

  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex;
  const middleMessages = messages
    .slice(compressionStart, historyEnd)
    .filter(
      (message) =>
        !isCompactionMessage(message) && !isPinnedInstructionMessage(message),
    );
  const turnPrefixMessages = cut.isSplitTurn
    ? messages
        .slice(cut.turnStartIndex, cut.firstKeptIndex)
        .filter(
          (message) =>
            !isCompactionMessage(message) &&
            !isPinnedInstructionMessage(message),
        )
    : [];
  const summarizedMessages = [...middleMessages, ...turnPrefixMessages];
  if (summarizedMessages.length === 0) {
    return null;
  }

  const fromEntryId = summarizedMessages[0]?.entryId?.trim();
  const toEntryId =
    summarizedMessages[summarizedMessages.length - 1]?.entryId?.trim();
  if (!fromEntryId || !toEntryId) {
    return null;
  }
  if (
    fromEntryId.includes(RESIDENT_FOLD_ENTRY_ID_MARKER) ||
    toEntryId.includes(RESIDENT_FOLD_ENTRY_ID_MARKER) ||
    fromEntryId.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER) ||
    toEntryId.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER)
  ) {
    return null;
  }

  return {
    ...(previousSummary ? { previousSummary } : {}),
    fromEntryId,
    toEntryId,
    middleMessages,
    ...(cut.isSplitTurn && turnPrefixMessages.length > 0
      ? { turnPrefixMessages, isSplitTurn: true }
      : {}),
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
  // Skip legacy header lines (e.g. "Previous thread file: …") up to the
  // blank separator; the summary body is everything after it.
  let bodyStart = 1;
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index]!.trim()) {
      bodyStart = index + 1;
      break;
    }
  }

  const summary = lines.slice(bodyStart).join("\n").trim();
  if (!summary) {
    return null;
  }
  return { summary };
};

export const formatThreadCheckpointMessage = (
  checkpoint: ThreadCheckpoint,
): string =>
  [THREAD_CHECKPOINT_MARKER, "", checkpoint.summary.trim()].join("\n");

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
    '- Current task/instruction: the newest user message in the conversation (a follow-up request or a "Task update:" steer) defines what the agent is doing RIGHT NOW. Preserve it faithfully — quote it verbatim (or near-verbatim if very long) under Current State or Open Items so the agent resumes exactly that work after compaction, not an earlier task.',
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

const GENERAL_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const GENERAL_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Preserve exact \`thread_id\` values from spawn_agent / send_input / check-status tool calls so follow-ups can resume existing threads.`;

const GENERAL_UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Preserve exact \`thread_id\` values from spawn_agent / send_input / check-status tool calls so follow-ups can resume existing threads.`;

const GENERAL_TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export const buildGeneralSummaryPrompt = (
  formattedConversation: string,
  previousSummary?: string,
): string => {
  const basePrompt = previousSummary
    ? GENERAL_UPDATE_SUMMARIZATION_PROMPT
    : GENERAL_SUMMARIZATION_PROMPT;
  let promptText = `<conversation>\n${formattedConversation}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  return `${promptText}${basePrompt}`;
};

export const buildGeneralTurnPrefixPrompt = (
  formattedConversation: string,
): string =>
  `<conversation>\n${formattedConversation}\n</conversation>\n\n${GENERAL_TURN_PREFIX_SUMMARIZATION_PROMPT}`;

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
 * durable-memory docs (user profile + Dream memory map), so the
 * summarizer can skip restating facts the assistant sees on every turn.
 */
const buildDurableMemoryReference = (
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
      label: "Memory map (memories/memory_map.md)",
      docPath: path.join(stellaDataDir, "memories", "memory_map.md"),
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
  policy?: ThreadCompactionSplitPolicy;
  promptKind?: "history" | "turnPrefix";
}): Promise<{ text: string | null; reason?: string }> => {
  const policy = args.policy ?? "orchestrator";
  const systemPrompt =
    policy === "general"
      ? GENERAL_SUMMARIZATION_SYSTEM_PROMPT
      : resolveThreadCompactionSystemPrompt();
  const previousSummary = args.previousSummary?.trim();
  const overheadChars = estimateSummaryOverheadChars({
    systemPromptChars: systemPrompt.length,
    previousSummary,
    durableMemoryReference:
      policy === "general" ? undefined : args.durableMemoryReference,
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

  const promptBody =
    policy === "general"
      ? args.promptKind === "turnPrefix"
        ? buildGeneralTurnPrefixPrompt(formattedConversation)
        : buildGeneralSummaryPrompt(formattedConversation, previousSummary)
      : buildSummaryPrompt(
          formattedConversation,
          previousSummary,
          computeSummaryBudget(args.messages),
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

const generateThreadSummaryWithoutElision = async (args: {
  threadKey: string;
  messages: StoredThreadMessage[];
  resolvedLlm: ResolvedLlmRoute;
  durableMemoryReference?: string;
  policy?: ThreadCompactionSplitPolicy;
}): Promise<{ text: string | null; reason?: string }> => {
  const policy = args.policy ?? "orchestrator";
  const systemPrompt =
    policy === "general"
      ? GENERAL_SUMMARIZATION_SYSTEM_PROMPT
      : resolveThreadCompactionSystemPrompt();
  let previousSummary: string | undefined;
  let offset = 0;

  while (offset < args.messages.length) {
    const maxChars = getSummaryInputCharBudget(
      args.resolvedLlm,
      estimateSummaryOverheadChars({
        systemPromptChars: systemPrompt.length,
        previousSummary,
        durableMemoryReference:
          policy === "general" ? undefined : args.durableMemoryReference,
      }),
    );
    let end = offset;
    while (end < args.messages.length) {
      const candidate = formatThreadMessagesForCompaction(
        args.messages.slice(offset, end + 1),
      ).trim();
      if (candidate.length > maxChars) {
        break;
      }
      end += 1;
    }
    if (end === offset) {
      return {
        text: null,
        reason: "one compaction message exceeds the summary input budget",
      };
    }

    const generated = await generateThreadSummary({
      ...args,
      messages: args.messages.slice(offset, end),
      previousSummary,
    });
    if (!generated.text) {
      return generated;
    }
    previousSummary = generated.text;
    offset = end;
  }

  return {
    text: previousSummary ?? null,
    ...(!previousSummary ? { reason: "empty formatted conversation" } : {}),
  };
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

const resolveKeepRecentTokens = (
  route: ResolvedLlmRoute,
  policy: ThreadCompactionSplitPolicy = "orchestrator",
): number => {
  if (policy === "orchestrator") {
    return Math.min(
      THREAD_COMPACTION_KEEP_RECENT_TOKENS,
      Math.floor(
        getContextWindow(route) * THREAD_COMPACTION_KEEP_RECENT_WINDOW_PCT,
      ),
    );
  }
  const window = getContextWindow(route);
  const triggerTokens = Math.max(
    MIN_TRIGGER_TOKENS,
    Math.floor(window * GENERAL_COMPACTION_TRIGGER_PCT),
  );
  // Smallest compatibility guard: keep the fixed 20k tail on any window
  // where that tail still leaves room under the 60% trigger. Only shrink
  // when a 20k tail would itself sit at/above the trigger (tiny windows),
  // so compaction can still free space. This is not the orchestrator's 10%
  // policy.
  const maxKeep = Math.max(
    1,
    window - GENERAL_COMPACTION_SMALL_WINDOW_RESERVE_TOKENS,
  );
  let keep = Math.min(GENERAL_COMPACTION_KEEP_RECENT_TOKENS, maxKeep);
  if (keep >= triggerTokens) {
    keep = Math.max(
      1,
      triggerTokens - GENERAL_COMPACTION_SMALL_WINDOW_RESERVE_TOKENS,
    );
  }
  return keep;
};

export const resolveKeepRecentTokensForAgent = (
  route: ResolvedLlmRoute,
  agentType?: string,
): number =>
  resolveKeepRecentTokens(route, resolveCompactionSplitPolicy(agentType));

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
  let storedMessages = args.store.loadThreadMessages(args.threadKey);
  if (storedMessages.length === 0) {
    return { compacted: false };
  }

  const rawStoredMessages =
    typeof args.store.loadRawThreadMessages === "function"
      ? args.store.loadRawThreadMessages(args.threadKey)
      : null;
  // Quarantine records are durable control data, not summary content. An
  // effective checkpoint may cover their custom rows, so always discover keys
  // from the append-only view when the store provides one.
  let quarantineKeys = quarantinedToolResultKeys(
    rawStoredMessages ?? storedMessages,
  );
  const effectiveToolResultKeys = new Set(
    storedMessages
      .filter((message) => message.payload?.role === "toolResult")
      .map((message) => toolResultQuarantineKey(message)),
  );
  const checkpointQuarantineKeys =
    latestCheckpointQuarantineKeys(storedMessages);
  const rebuildUnsafeCheckpoint =
    quarantineKeys.size > 0 &&
    storedMessages.some((message) => parseThreadCheckpoint(message.content)) &&
    [...quarantineKeys].some(
      (key) =>
        !effectiveToolResultKeys.has(key) && !checkpointQuarantineKeys.has(key),
    );
  if (
    rebuildUnsafeCheckpoint &&
    typeof args.store.loadRawThreadMessages === "function"
  ) {
    // A checkpoint that covered a now-quarantined result may already summarize
    // the suspect provider payload. Rebuild from the append-only raw log so the
    // historical context is retained while the offending result is masked.
    storedMessages =
      rawStoredMessages ?? args.store.loadRawThreadMessages(args.threadKey);
    quarantineKeys = quarantinedToolResultKeys(storedMessages);
  }

  const policy = resolveCompactionSplitPolicy(args.agentType);
  const totalTokens = getThreadTokenEstimate(storedMessages);
  const forced = isThreadCompactionForced(args.threadKey);
  // The trigger measures what the provider actually receives: the last
  // preflight-measured full outbound payload (system prompt + tool schemas +
  // resident context + history). The history-only estimate is the floor for
  // threads with no measured dispatch yet (e.g. the first turn after a
  // worker restart, where the in-memory payload estimate is gone).
  const measuredTokens = Math.max(
    totalTokens,
    getLastProviderPayloadTokens(args.threadKey) ?? 0,
  );
  if (
    !forced &&
    !rebuildUnsafeCheckpoint &&
    measuredTokens <
      getCompactionTriggerTokens(args.resolvedLlm, args.agentType)
  ) {
    return { compacted: false };
  }

  const protectHead = resolveCompactionProtectHeadMessages(
    args.agentType,
    storedMessages,
  );
  const keepRecentTokens = resolveKeepRecentTokens(args.resolvedLlm, policy);
  let splitMessages =
    policy === "general"
      ? splitGeneralThreadMessagesForCompaction(
          storedMessages,
          protectHead,
          keepRecentTokens,
        )
      : splitThreadMessagesForCompaction(
          storedMessages,
          protectHead,
          keepRecentTokens,
          Number.isFinite(args.preserveLastN) &&
            args.preserveLastN !== undefined
            ? Math.max(0, Math.floor(args.preserveLastN))
            : THREAD_COMPACTION_MIN_TAIL_MESSAGES,
        );
  if (!splitMessages && (forced || rebuildUnsafeCheckpoint)) {
    // Emergency split for an overflow that the standard cut points cannot
    // relieve (e.g. a few enormous messages inside the protected head or
    // tail). Only the orchestrator's bootstrap docs stay pinned; everything
    // up to the last message is compactable.
    const emergencyHead = countLeadingBootstrapStartupDocs(storedMessages);
    splitMessages =
      policy === "general"
        ? splitGeneralThreadMessagesForCompaction(
            storedMessages,
            emergencyHead,
            0,
          )
        : splitThreadMessagesForCompaction(
            storedMessages,
            // Even in the emergency split, leading bootstrap docs stay pinned for
            // every agent type — they are resident context, and cutting through
            // them would anchor the overlay on a fold-synthetic entryId.
            emergencyHead,
            0,
            1,
          );
  }
  if (!splitMessages) {
    return { compacted: false };
  }

  const summaryMiddleMessages = maskQuarantinedCompactionMessages(
    splitMessages.middleMessages,
    quarantineKeys,
  );
  const summaryTurnPrefixMessages = maskQuarantinedCompactionMessages(
    splitMessages.turnPrefixMessages ?? [],
    quarantineKeys,
  );

  const durableMemoryReference =
    args.agentType === AGENT_IDS.ORCHESTRATOR
      ? buildDurableMemoryReference(args.stellaDataDir)
      : undefined;
  // Hook summaries are produced outside this quarantine-aware snapshot and
  // may already contain suspect tool content. Regenerate from masked rows
  // whenever any quarantine is active.
  let summary =
    quarantineKeys.size === 0 ? args.overrideSummary?.trim() || null : null;
  if (!summary) {
    // One single-pass summary request. A middle too large for the current
    // model's summarizer window is normally prevented up front: a shrinking
    // model switch runs a blocking compaction on the previous (larger-window)
    // route before the new route takes over. If an oversized middle still
    // reaches this point, `capSummaryConversation` bounds the request to the
    // window and discloses the elided span rather than failing.
    const skipHistorySummary =
      policy === "general" && splitMessages.middleMessages.length === 0;
    const generated = skipHistorySummary
      ? {
          text: splitMessages.previousSummary?.trim() || null,
          reason: splitMessages.previousSummary?.trim()
            ? undefined
            : "empty formatted conversation",
        }
      : rebuildUnsafeCheckpoint
        ? await generateThreadSummaryWithoutElision({
            threadKey: args.threadKey,
            messages: summaryMiddleMessages,
            resolvedLlm: args.resolvedLlm,
            durableMemoryReference,
            policy,
          })
        : await generateThreadSummary({
            threadKey: args.threadKey,
            messages: summaryMiddleMessages,
            previousSummary: splitMessages.previousSummary,
            resolvedLlm: args.resolvedLlm,
            durableMemoryReference,
            policy,
          });
    summary = generated.text;
    if (
      policy === "general" &&
      splitMessages.isSplitTurn &&
      (splitMessages.turnPrefixMessages?.length ?? 0) > 0
    ) {
      const prefix = await generateThreadSummary({
        threadKey: args.threadKey,
        messages: summaryTurnPrefixMessages,
        resolvedLlm: args.resolvedLlm,
        policy,
        promptKind: "turnPrefix",
      });
      if (!prefix.text) {
        logger.error("thread.compaction.summary-failed-final", {
          threadKey: args.threadKey,
          model: args.resolvedLlm.model.id,
          reason: prefix.reason,
          middleTokens: getThreadTokenEstimate(
            splitMessages.turnPrefixMessages ?? [],
          ),
          totalTokens,
        });
        return { compacted: false };
      }
      const historyText = summary?.trim() || "No prior history.";
      summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
    }
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
    if (policy === "general") {
      const fileOps = collectFileOperations([
        ...splitMessages.middleMessages,
        ...(splitMessages.turnPrefixMessages ?? []),
      ]);
      summary += formatFileOperationsForSummary(
        fileOps.readFiles,
        fileOps.modifiedFiles,
      );
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

  // Pin the latest user instruction across the checkpoint: the middle
  // (including that instruction) is summarized as usual, but the overlay
  // additionally re-emits one capped verbatim copy of it right after the
  // checkpoint message. Bounded by construction — the tail cut never moves.
  // Orchestrator-only: general/subagent compaction follows pi-mono and
  // does not emit a synthetic pin.
  const pinnedInstructionText =
    policy === "orchestrator" && splitMessages.latestUserMessage
      ? truncateForSummary(
          extractUserMessageText(splitMessages.latestUserMessage).trim(),
          THREAD_COMPACTION_PINNED_INSTRUCTION_MAX_CHARS,
        )
      : "";
  const generalFileOps =
    policy === "general"
      ? collectFileOperations([
          ...splitMessages.middleMessages,
          ...(splitMessages.turnPrefixMessages ?? []),
        ])
      : null;
  const details = {
    // Compaction replaces derived bootstrap context even when this particular
    // thread has no resident documents to fold.
    replaceDerivedContext: true,
    ...(residentFold ? { residentFold } : {}),
    ...(pinnedInstructionText
      ? { pinnedUserInstruction: { text: pinnedInstructionText } }
      : {}),
    ...(quarantineKeys.size > 0
      ? { quarantinedToolResultKeys: [...quarantineKeys].sort() }
      : {}),
    ...(generalFileOps
      ? {
          readFiles: generalFileOps.readFiles,
          modifiedFiles: generalFileOps.modifiedFiles,
        }
      : {}),
  };

  // Quarantine can engage while the summary provider call is in flight. A
  // summary generated from the earlier snapshot is then unsafe to publish,
  // even though the quarantine row may have been appended before this write.
  // Re-check synchronously immediately before the synchronous SQLite write;
  // the next compaction will regenerate from the masked snapshot.
  for (
    let attempt = 0;
    attempt <= COMPACTION_STORE_WRITE_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    if (attempt > 0) {
      await sleep(COMPACTION_STORE_WRITE_RETRY_DELAYS_MS[attempt - 1]!);
    }
    try {
      const latestQuarantineKeys = quarantinedToolResultKeys(
        typeof args.store.loadRawThreadMessages === "function"
          ? args.store.loadRawThreadMessages(args.threadKey)
          : args.store.loadThreadMessages(args.threadKey),
      );
      if ([...latestQuarantineKeys].some((key) => !quarantineKeys.has(key))) {
        logger.warn("thread.compaction.quarantine-changed-before-write", {
          threadKey: args.threadKey,
          quarantineCountBefore: quarantineKeys.size,
          quarantineCountAfter: latestQuarantineKeys.size,
        });
        return { compacted: false };
      }
      args.store.compactThread({
        threadKey: args.threadKey,
        summary,
        fromEntryId: splitMessages.fromEntryId,
        toEntryId: splitMessages.toEntryId,
        tokensBefore: totalTokens,
        ...(Object.keys(details).length > 0 ? { details } : {}),
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
