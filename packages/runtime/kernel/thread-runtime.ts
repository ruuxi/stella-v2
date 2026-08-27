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
import crypto from "node:crypto";
import { createRuntimeLogger } from "./debug.js";
import { redactMemoryText } from "./memory/redaction.js";
import { readRuntimePrompt } from "./prompts/home-prompts.js";
import {
  decodedBase64ByteLength,
  estimateModelVisibleImageTokens,
  getLastProviderPayloadTokens,
  isThreadCompactionForced,
} from "./agent-runtime/context-budget.js";
import {
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

const THREAD_COMPACTION_TRIGGER_PCT = 0.5;
const THREAD_COMPACTION_PROTECT_HEAD_MESSAGES = 3;
const THREAD_COMPACTION_KEEP_RECENT_TOKENS = 20_000;

const THREAD_COMPACTION_KEEP_RECENT_WINDOW_PCT = 0.1;
const THREAD_COMPACTION_MIN_TAIL_MESSAGES = 2;

const THREAD_COMPACTION_PINNED_INSTRUCTION_MAX_CHARS = 12_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MIN_TRIGGER_TOKENS = 8_000;

const GENERAL_COMPACTION_TRIGGER_PCT = 0.6;

const GENERAL_COMPACTION_KEEP_RECENT_TOKENS = 20_000;

const GENERAL_COMPACTION_SMALL_WINDOW_RESERVE_TOKENS = 4_096;
const MAX_BLOCK_CHARS = 100_000;
const TOOL_RESULT_MAX_CHARS = 2_000;
export const MAX_ACTIVE_THREAD_IMAGES = 8;
export const ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET = 12 * 1024 * 1024;

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
  checkpointImageReceipts?: ThreadImageReceipt[];
};

type ThreadCheckpoint = {
  summary: string;
};

export type ThreadCompactionPlan = {
  previousSummary?: string;
  fromEntryId: string;
  toEntryId: string;
  middleMessages: StoredThreadMessage[];

  latestUserMessage?: StoredThreadMessage;

  turnPrefixMessages?: StoredThreadMessage[];
  isSplitTurn?: boolean;

  imagePressure?: true;
};

type ThreadImageReceipt = {
  id: string;
  mimeType: string;
  decodedBytes: number;
  width?: number;
  height?: number;
  origin: {
    timestamp: number;
    role: string;
    toolName?: string;
  };
  artifact:
    | { durability: "durable"; path: string }
    | { durability: "non-durable"; path?: string; reason: string };
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
              block.type === "text"
                ? block.text
                : `[Image receipt: ${block.mimeType}${block.sourcePath ? ` path=${block.sourcePath}` : ""}]`,
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
      block.type === "text"
        ? block.text
        : `[Image receipt: ${block.mimeType}${block.sourcePath ? ` path=${block.sourcePath}` : ""}]`,
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
          : estimateModelVisibleImageTokens(block);
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
        : estimateModelVisibleImageTokens(block);
  }
  return tokens;
};

const storedMessageImageBlocks = (message: StoredThreadMessage) => {
  const payload = message.payload;
  if (payload && typeof payload.content !== "string") {
    return payload.content.filter((block) => block.type === "image");
  }
  const customContent = message.customMessage?.content;
  if (Array.isArray(customContent)) {
    return customContent.filter((block) => block.type === "image");
  }
  return [];
};

const estimateStoredMessageTokens = (message: StoredThreadMessage): number => {
  if (message.payload) return estimatePayloadTokens(message.payload);
  const imageTokens = storedMessageImageBlocks(message).reduce(
    (sum, block) => sum + estimateModelVisibleImageTokens(block),
    0,
  );
  return estimateMessageTokens(message as ThreadMessage) + imageTokens;
};

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

export const getThreadImageHistoryStats = (
  messages: StoredThreadMessage[],
): Readonly<{ count: number; decodedBytes: number; overBudget: boolean }> => {
  let count = 0;
  let decodedBytes = 0;
  for (const message of messages) {
    for (const block of storedMessageImageBlocks(message)) {
      count += 1;
      decodedBytes += decodedBase64ByteLength(block.data);
    }
  }
  return {
    count,
    decodedBytes,
    overBudget:
      count > MAX_ACTIVE_THREAD_IMAGES ||
      decodedBytes > ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET,
  };
};

const isCompactionMessage = (message: StoredThreadMessage): boolean =>
  message.role === "assistant" &&
  parseThreadCheckpoint(message.content) !== null;

const isPinnedInstructionMessage = (message: StoredThreadMessage): boolean =>
  message.entryId?.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER) ?? false;

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

const imageStatsPlus = (
  left: Readonly<{ count: number; decodedBytes: number }>,
  right: Readonly<{ count: number; decodedBytes: number }>,
) => ({
  count: left.count + right.count,
  decodedBytes: left.decodedBytes + right.decodedBytes,
});

const imageStatsFit = (stats: {
  count: number;
  decodedBytes: number;
}): boolean =>
  stats.count <= MAX_ACTIVE_THREAD_IMAGES &&
  stats.decodedBytes <= ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET;

export const splitThreadMessagesForImagePressure = (
  messages: StoredThreadMessage[],
): ThreadCompactionPlan | null => {
  const build = (compressionStart: number): ThreadCompactionPlan | null => {
    const protectedStats = getThreadImageHistoryStats(
      messages.slice(0, compressionStart),
    );
    if (protectedStats.overBudget) return null;

    let retained = {
      count: protectedStats.count,
      decodedBytes: protectedStats.decodedBytes,
    };
    let tailStartIndex = messages.length;
    for (
      let index = messages.length - 1;
      index >= compressionStart;
      index -= 1
    ) {
      const messageStats = getThreadImageHistoryStats([messages[index]!]);
      const candidate = imageStatsPlus(retained, messageStats);
      if (!imageStatsFit(candidate)) {
        tailStartIndex = alignBoundaryForward(messages, index + 1);
        break;
      }
      retained = candidate;
    }
    if (tailStartIndex <= compressionStart) return null;

    const compactedWindow = messages.slice(compressionStart, tailStartIndex);
    const middleMessages = compactedWindow.filter(
      (message) =>
        !isCompactionMessage(message) && !isPinnedInstructionMessage(message),
    );
    if (middleMessages.length === 0) return null;
    const fromEntryId = middleMessages[0]?.entryId?.trim();
    const toEntryId = middleMessages.at(-1)?.entryId?.trim();
    if (!fromEntryId || !toEntryId) return null;
    if (
      fromEntryId.includes(RESIDENT_FOLD_ENTRY_ID_MARKER) ||
      toEntryId.includes(RESIDENT_FOLD_ENTRY_ID_MARKER) ||
      fromEntryId.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER) ||
      toEntryId.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER)
    ) {
      return null;
    }

    const prospectiveStats = getThreadImageHistoryStats([
      ...messages.slice(0, compressionStart),
      ...messages.slice(tailStartIndex),
    ]);
    if (prospectiveStats.overBudget) return null;

    let previousSummary: string | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = parseThreadCheckpoint(
        messages[index]!.content,
      )?.summary;
      if (candidate) {
        previousSummary = candidate;
        break;
      }
    }
    let latestUserMessage: StoredThreadMessage | undefined;
    for (let index = middleMessages.length - 1; index >= 0; index -= 1) {
      if (middleMessages[index]!.role === "user") {
        latestUserMessage = middleMessages[index];
        break;
      }
    }
    return {
      ...(previousSummary ? { previousSummary } : {}),
      fromEntryId,
      toEntryId,
      middleMessages,
      ...(latestUserMessage ? { latestUserMessage } : {}),
      imagePressure: true,
    };
  };

  return build(countLeadingBootstrapStartupDocs(messages)) ?? build(0);
};

const imageExtension = (mimeType: string): string => {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
};

const finiteImageDimension = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

const promoteImageArtifact = (args: {
  data: string;
  mimeType: string;
  sourcePath?: string;
  stellaDataDir?: string;
}): Pick<ThreadImageReceipt, "id" | "decodedBytes" | "artifact"> => {
  const bytes = Buffer.from(args.data, "base64");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const id = `sha256:${hash}`;
  if (args.stellaDataDir) {
    const directory = path.join(
      args.stellaDataDir,
      "artifacts",
      "thread-images",
    );
    const artifactPath = path.join(
      directory,
      `${hash}.${imageExtension(args.mimeType)}`,
    );
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.existsSync(artifactPath)) {
        const temporaryPath = `${artifactPath}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
          fs.renameSync(temporaryPath, artifactPath);
        } catch (error) {
          try {
            fs.rmSync(temporaryPath, { force: true });
          } catch {

          }
          if (!fs.existsSync(artifactPath)) throw error;
        }
      }
      return {
        id,
        decodedBytes: bytes.length,
        artifact: { durability: "durable", path: artifactPath },
      };
    } catch (error) {
      logger.warn("thread.compaction.image-artifact-promotion-failed", {
        artifactId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const sourcePath = args.sourcePath?.trim();
  return {
    id,
    decodedBytes: bytes.length,
    artifact: {
      durability: "non-durable",
      ...(sourcePath ? { path: sourcePath } : {}),
      reason: args.stellaDataDir
        ? "durable artifact promotion failed"
        : sourcePath
          ? "source path was not promoted because no Stella data directory was available"
          : "inline image was evicted at checkpoint and no durable artifact directory was available",
    },
  };
};

export const collectThreadImageReceipts = (
  messages: StoredThreadMessage[],
  stellaDataDir?: string,
): ThreadImageReceipt[] => {
  const receipts: ThreadImageReceipt[] = [];
  for (const message of messages) {
    const payload = message.payload;
    for (const block of storedMessageImageBlocks(message)) {
      const dimensions = block as typeof block & {
        width?: number;
        height?: number;
        widthPx?: number;
        heightPx?: number;
      };
      const promoted = promoteImageArtifact({
        data: block.data,
        mimeType: block.mimeType,
        ...(block.sourcePath ? { sourcePath: block.sourcePath } : {}),
        ...(stellaDataDir ? { stellaDataDir } : {}),
      });
      const width = finiteImageDimension(
        dimensions.width ?? dimensions.widthPx,
      );
      const height = finiteImageDimension(
        dimensions.height ?? dimensions.heightPx,
      );
      receipts.push({
        ...promoted,
        mimeType: block.mimeType,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        origin: {
          timestamp: message.timestamp,
          role: message.role,
          ...(payload?.role === "toolResult"
            ? { toolName: payload.toolName }
            : {}),
        },
      });
    }
  }
  return receipts;
};

const latestDurableCheckpointImageReceipts = (
  messages: StoredThreadMessage[],
): ThreadImageReceipt[] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!parseThreadCheckpoint(message.content)) continue;
    return (message.checkpointImageReceipts ?? []).filter(
      (receipt) => receipt.artifact.durability === "durable",
    );
  }
  return [];
};

const mergeThreadImageReceipts = (
  inherited: ThreadImageReceipt[],
  current: ThreadImageReceipt[],
): ThreadImageReceipt[] => {
  const byId = new Map<string, ThreadImageReceipt>();
  for (const receipt of [...inherited, ...current]) {
    const existing = byId.get(receipt.id);
    if (
      !existing ||
      (existing.artifact.durability !== "durable" &&
        receipt.artifact.durability === "durable")
    ) {
      byId.set(receipt.id, receipt);
    }
  }
  return [...byId.values()];
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

  let bodyStart = 1;
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index]!.trim()) {
      bodyStart = index + 1;
      break;
    }
  }

  const summaryWithReceipts = lines.slice(bodyStart).join("\n").trim();
  const receiptStart = summaryWithReceipts.indexOf(
    '\n<image-receipts version="1">\n',
  );
  const summary = (
    receiptStart >= 0
      ? summaryWithReceipts.slice(0, receiptStart)
      : summaryWithReceipts
  ).trim();
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

const THREAD_SUMMARY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

let summaryRetryDelaysMs: readonly number[] = THREAD_SUMMARY_RETRY_DELAYS_MS;

export const setThreadSummaryRetryDelaysForTest = (
  delays?: readonly number[],
): void => {
  summaryRetryDelaysMs = delays ?? THREAD_SUMMARY_RETRY_DELAYS_MS;
};

const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

const SUMMARY_INPUT_CHARS_PER_TOKEN = 3;

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

const estimateSummaryOverheadChars = (args: {
  systemPromptChars: number;
  previousSummary?: string;
  durableMemoryReference?: string;
}): number =>
  args.systemPromptChars +
  (args.previousSummary?.length ?? 0) +
  (args.durableMemoryReference?.length ?? 0) +
  SUMMARY_PROMPT_TEMPLATE_CHARS;

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

const DURABLE_MEMORY_DOC_MAX_CHARS = 8_000;

const readDurableMemoryDoc = (filePath: string): string | undefined => {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content ? redactMemoryText(content) : undefined;
  } catch {
    return undefined;
  }
};

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

export type ThreadCompactionResult = {
  compacted: boolean;
};

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

export const resolveCompactionProtectHeadMessages = (
  agentType: string,
  messages: StoredThreadMessage[],
): number =>
  agentType === AGENT_IDS.ORCHESTRATOR
    ? countLeadingBootstrapStartupDocs(messages)
    :

      Math.max(
        THREAD_COMPACTION_PROTECT_HEAD_MESSAGES,
        countLeadingBootstrapStartupDocs(messages),
      );

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

  stellaDataDir?: string;
}): Promise<ThreadCompactionResult> => {
  const compactionStartedAt = Date.now();
  const forcedBeforeProbe = isThreadCompactionForced(args.threadKey);
  const narrowProbe =
    typeof args.store.getThreadContextPressureStats === "function"
      ? args.store.getThreadContextPressureStats(args.threadKey)
      : null;
  const initialRelevantQuarantineCount =
    narrowProbe?.complete === true ? narrowProbe.quarantineCount : null;
  if (
    !forcedBeforeProbe &&
    narrowProbe?.complete === true &&
    narrowProbe.quarantineCount === 0 &&
    narrowProbe.imageCount <= MAX_ACTIVE_THREAD_IMAGES &&
    narrowProbe.imageDecodedBytes <= ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET &&
    Math.max(
      narrowProbe.estimatedTokens,
      getLastProviderPayloadTokens(args.threadKey) ?? 0,
    ) < getCompactionTriggerTokens(args.resolvedLlm, args.agentType)
  ) {
    return { compacted: false };
  }
  let storedMessages = args.store.loadThreadMessages(args.threadKey);
  if (storedMessages.length === 0) {
    return { compacted: false };
  }
  const inheritedImageReceipts =
    latestDurableCheckpointImageReceipts(storedMessages);
  const checkpointQuarantineKeys =
    latestCheckpointQuarantineKeys(storedMessages);

  const inspectRawQuarantine =
    initialRelevantQuarantineCount === null ||
    initialRelevantQuarantineCount > 0;
  const rawStoredMessages =
    inspectRawQuarantine &&
    typeof args.store.loadRawThreadMessages === "function"
      ? args.store.loadRawThreadMessages(args.threadKey)
      : null;

  let quarantineKeys = new Set([
    ...checkpointQuarantineKeys,
    ...quarantinedToolResultKeys(rawStoredMessages ?? storedMessages),
  ]);
  const effectiveToolResultKeys = new Set(
    storedMessages
      .filter((message) => message.payload?.role === "toolResult")
      .map((message) => toolResultQuarantineKey(message)),
  );
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

    storedMessages =
      rawStoredMessages ?? args.store.loadRawThreadMessages(args.threadKey);
    quarantineKeys = new Set([
      ...checkpointQuarantineKeys,
      ...quarantinedToolResultKeys(storedMessages),
    ]);
  }

  const policy = resolveCompactionSplitPolicy(args.agentType);
  const totalTokens = getThreadTokenEstimate(storedMessages);
  const forced = forcedBeforeProbe;
  const imageHistory = getThreadImageHistoryStats(storedMessages);

  const measuredTokens = Math.max(
    totalTokens,
    getLastProviderPayloadTokens(args.threadKey) ?? 0,
  );
  if (
    !forced &&
    !imageHistory.overBudget &&
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

  let splitMessages = imageHistory.overBudget
    ? splitThreadMessagesForImagePressure(storedMessages)
    : policy === "general"
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
  if (
    !splitMessages &&
    (forced || rebuildUnsafeCheckpoint) &&
    !imageHistory.overBudget
  ) {

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

            emergencyHead,
            0,
            1,
          );
  }
  if (!splitMessages) {
    logger.error("thread.compaction.no-safe-split", {
      threadKey: args.threadKey,
      reason: imageHistory.overBudget ? "image-pressure" : "token-pressure",
      imageCount: imageHistory.count,
      imageDecodedBytes: imageHistory.decodedBytes,
    });
    return { compacted: false };
  }

  const triggerReason = imageHistory.overBudget
    ? "image-pressure"
    : rebuildUnsafeCheckpoint
      ? "quarantine-rebuild"
      : forced
        ? "forced"
        : "token-pressure";
  logger.info("thread.compaction.started", {
    threadKey: args.threadKey,
    model: args.resolvedLlm.model.id,
    reason: triggerReason,
    policy,
    cacheBoundary: "checkpoint-overlay",
    tokensBefore: totalTokens,
    measuredTokens,
    imageCountBefore: imageHistory.count,
    imageDecodedBytesBefore: imageHistory.decodedBytes,
    compactedMessageCount:
      splitMessages.middleMessages.length +
      (splitMessages.turnPrefixMessages?.length ?? 0),
  });

  const summaryMiddleMessages = maskQuarantinedCompactionMessages(
    splitMessages.middleMessages,
    quarantineKeys,
  );
  const summaryTurnPrefixMessages = maskQuarantinedCompactionMessages(
    splitMessages.turnPrefixMessages ?? [],
    quarantineKeys,
  );

  const imageReceipts = mergeThreadImageReceipts(
    inheritedImageReceipts,
    collectThreadImageReceipts(
      [...summaryMiddleMessages, ...summaryTurnPrefixMessages],
      args.stellaDataDir,
    ),
  );

  const durableMemoryReference =
    args.agentType === AGENT_IDS.ORCHESTRATOR
      ? buildDurableMemoryReference(args.stellaDataDir)
      : undefined;

  let summary =
    quarantineKeys.size === 0 ? args.overrideSummary?.trim() || null : null;
  if (!summary) {

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
    ...(imageReceipts.length > 0 ? { imageReceipts } : {}),
  };

  for (
    let attempt = 0;
    attempt <= COMPACTION_STORE_WRITE_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    if (attempt > 0) {
      await sleep(COMPACTION_STORE_WRITE_RETRY_DELAYS_MS[attempt - 1]!);
    }
    try {
      const latestNarrowProbe =
        typeof args.store.getThreadContextPressureStats === "function"
          ? args.store.getThreadContextPressureStats(args.threadKey)
          : null;
      const relevantQuarantineGrew =
        initialRelevantQuarantineCount !== null &&
        latestNarrowProbe?.complete === true
          ? latestNarrowProbe.quarantineCount > initialRelevantQuarantineCount
          : null;
      const latestQuarantineKeys =
        relevantQuarantineGrew === null
          ? quarantinedToolResultKeys(
              typeof args.store.loadRawThreadMessages === "function"
                ? args.store.loadRawThreadMessages(args.threadKey)
                : args.store.loadThreadMessages(args.threadKey),
            )
          : null;
      if (
        relevantQuarantineGrew === true ||
        (latestQuarantineKeys !== null &&
          [...latestQuarantineKeys].some((key) => !quarantineKeys.has(key)))
      ) {
        logger.warn("thread.compaction.quarantine-changed-before-write", {
          threadKey: args.threadKey,
          quarantineCountBefore:
            initialRelevantQuarantineCount ?? quarantineKeys.size,
          quarantineCountAfter:
            latestNarrowProbe?.complete === true
              ? latestNarrowProbe.quarantineCount
              : (latestQuarantineKeys?.size ?? 0),
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
      const effectiveAfter = args.store.loadThreadMessages(args.threadKey);
      const imageHistoryAfter = getThreadImageHistoryStats(effectiveAfter);
      logger.info("thread.compaction.completed", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        reason: triggerReason,
        cacheBoundary: "checkpoint-overlay",
        durationMs: Date.now() - compactionStartedAt,
        tokensBefore: totalTokens,
        tokensAfter: getThreadTokenEstimate(effectiveAfter),
        imageCountBefore: imageHistory.count,
        imageCountAfter: imageHistoryAfter.count,
        imageDecodedBytesBefore: imageHistory.decodedBytes,
        imageDecodedBytesAfter: imageHistoryAfter.decodedBytes,
        imageReceiptCount: imageReceipts.length,
        postCheckpointImageBudgetSatisfied: !imageHistoryAfter.overBudget,
      });
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
