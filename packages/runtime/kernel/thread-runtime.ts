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
import crypto from "node:crypto";
import { createRuntimeLogger } from "./debug.js";
import { redactMemoryText } from "./memory/redaction.js";
import { readRuntimePrompt } from "./prompts/home-prompts.js";
import {
  decodedBase64ByteLength,
  estimateModelVisibleImageTokens,
  clearProviderUsage,
  getBilledContextTokens,
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
import {
  MIN_TAIL_MESSAGES,
  MIN_TRIGGER_TOKENS,
  SUMMARY_RETRY_DELAYS_MS,
  alignCutForward,
  buildOrchestratorSummaryPrompt,
  capSummaryConversation,
  contextWindowTokens,
  durableMemoryReference,
  ellipsize,
  estimatePayloadTokens,
  formatCheckpointText,
  orchestratorCompactionTriggerTokens,
  orchestratorKeepRecentTokens,
  pinnedInstructionText,
  planOrchestratorCompaction,
  summaryInputCharBudget,
  summaryLinesForPayload,
  summaryMaxTokens,
  summaryOverheadChars,
  summaryTargetTokens,
  THREAD_CHECKPOINT_MARKER,
  truncateForSummary,
  type CompactionMessageView,
} from "./agent-runtime/orchestrator-compaction.js";

const logger = createRuntimeLogger("thread-runtime");

/** A data-dir-relative file reader for the resident fold; null when absent. */
const readStellaDataFile =
  (stellaDataDir: string) =>
  (relativePath: string): string | null => {
    try {
      return fs.readFileSync(path.join(stellaDataDir, relativePath), "utf-8");
    } catch {
      return null;
    }
  };

export const resolveThreadCompactionSystemPrompt = (): string =>
  readRuntimePrompt("thread-compaction") ?? "";
const THREAD_COMPACTION_PROTECT_HEAD_MESSAGES = 3;
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
  /** The cut was selected prospectively to make the retained image set fit. */
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

const stringifyStoredMessage = (message: StoredThreadMessage): string[] => {
  if (message.customMessage?.customType === QUARANTINE_CUSTOM_TYPE) {
    return [];
  }
  if (message.payload) {
    return summaryLinesForPayload(message.payload);
  }
  if (message.role === "toolResult") {
    const content = message.content.trim();
    return content
      ? [`[Tool result] ${truncateForSummary(content, 2_000)}`]
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

const getContextWindow = (route: ResolvedLlmRoute): number =>
  contextWindowTokens(route.model.contextWindow);

export const resolveCompactionSplitPolicy = (
  agentType?: string,
): ThreadCompactionSplitPolicy =>
  !agentType || agentType === AGENT_IDS.ORCHESTRATOR
    ? "orchestrator"
    : "general";

export const getCompactionTriggerTokens = (
  route: ResolvedLlmRoute,
  agentType?: string,
): number =>
  resolveCompactionSplitPolicy(agentType) === "general"
    ? Math.max(
        MIN_TRIGGER_TOKENS,
        Math.floor(getContextWindow(route) * GENERAL_COMPACTION_TRIGGER_PCT),
      )
    : orchestratorCompactionTriggerTokens(getContextWindow(route));

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

/** The cut planner's view of a stored message. */
const compactionView = (message: StoredThreadMessage): CompactionMessageView => ({
  role: message.role,
  toolCallIds:
    message.role === "assistant" && message.payload?.role === "assistant"
      ? message.payload.content.flatMap((block) =>
          block.type === "toolCall" && typeof block.id === "string"
            ? [block.id]
            : [],
        )
      : [],
  ...(message.role === "toolResult"
    ? {
        toolResultId:
          message.payload?.role === "toolResult" &&
          message.payload.toolCallId.trim()
            ? message.payload.toolCallId.trim()
            : message.toolCallId?.trim(),
      }
    : {}),
  tokens: estimateStoredMessageTokens(message),
});

const alignBoundaryForward = (
  messages: StoredThreadMessage[],
  index: number,
): number => alignCutForward(messages.map(compactionView), index);

export const splitThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
  protectHeadMessages = THREAD_COMPACTION_PROTECT_HEAD_MESSAGES,
  keepRecentTokens = 20_000,
  minTailMessages = MIN_TAIL_MESSAGES,
): ThreadCompactionPlan | null => {
  const plan = planOrchestratorCompaction({
    messages: messages.map(compactionView),
    protectHead: protectHeadMessages,
    keepRecentTokens,
    minTailMessages,
  });
  if (!plan) {
    return null;
  }
  const compressionStart = plan.start;
  const tailStartIndex = plan.tailStart;

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
  const latestUserMessage =
    plan.latestUserIndex !== undefined
      ? messages[plan.latestUserIndex]
      : undefined;

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

/**
 * Select the smallest old prefix whose checkpoint removal makes the retained
 * image set fit. Unlike the ordinary token splitter, this may compact through
 * the newest message: a single result containing ten images cannot be made
 * safe by retaining that result as a mandatory tail.
 */
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

  // Bootstrap docs normally contain no image payloads and stay pinned. If a
  // malformed/imported thread put images there, fall back to compacting real
  // rows from the start rather than entering an endless pressure loop.
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
            // Best-effort cleanup; receipt fallback below remains explicit.
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
  // Skip legacy header lines (e.g. "Previous thread file: …") up to the
  // blank separator; the summary body is everything after it.
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
): string => formatCheckpointText(checkpoint.summary);

const computeSummaryBudget = (
  messages: StoredThreadMessage[],
  maxTokens: number,
): number => summaryTargetTokens(getThreadTokenEstimate(messages), maxTokens);

let summaryRetryDelaysMs: readonly number[] = SUMMARY_RETRY_DELAYS_MS;

/** Test seam: shorten (or restore) the summary retry backoff. */
export const setThreadSummaryRetryDelaysForTest = (
  delays?: readonly number[],
): void => {
  summaryRetryDelaysMs = delays ?? SUMMARY_RETRY_DELAYS_MS;
};

const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

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
Preserve exact \`thread_id\` values from spawn_agent / send_message / check-status tool calls so follow-ups can resume existing threads.`;

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
Preserve exact \`thread_id\` values from spawn_agent / send_message / check-status tool calls so follow-ups can resume existing threads.`;

// Conversation content and instructions are separate sections, and the task
// is framed as a continuation checkpoint: Claude Fable refused the earlier
// "PREFIX / SUFFIX of a turn" wording (pi-mono d192bd6dc).
const GENERAL_TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

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
  `# Conversation\n${formattedConversation}\n\n# Instructions\n${GENERAL_TURN_PREFIX_SUMMARIZATION_PROMPT}`;

// Per-doc cap for the ALREADY KNOWN reference. The docs are small
// always-loaded files; the cap only guards against a runaway doc inflating
// the compaction request.
/**
 * The "already known — do not repeat" reference for the summarizer, from the
 * always-loaded user profile.
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
  try {
    const content = fs
      .readFileSync(path.join(stellaDataDir, "memories", "profile.md"), "utf-8")
      .trim();
    return durableMemoryReference(content ? redactMemoryText(content) : "");
  } catch {
    return undefined;
  }
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
  const overheadChars = summaryOverheadChars({
    systemPromptChars: systemPrompt.length,
    previousSummary,
    durableMemoryReference:
      policy === "general" ? undefined : args.durableMemoryReference,
  });
  const formattedConversation = capSummaryConversation(
    formatThreadMessagesForCompaction(args.messages).trim(),
    summaryInputCharBudget(getContextWindow(args.resolvedLlm), overheadChars),
  );
  if (!formattedConversation) {
    return {
      text: previousSummary || null,
      ...(!previousSummary ? { reason: "empty formatted conversation" } : {}),
    };
  }

  const maxTokens = summaryMaxTokens(
    args.resolvedLlm.model.maxTokens,
    args.promptKind ?? "history",
  );
  const promptBody =
    policy === "general"
      ? args.promptKind === "turnPrefix"
        ? buildGeneralTurnPrefixPrompt(formattedConversation)
        : buildGeneralSummaryPrompt(formattedConversation, previousSummary)
      : buildOrchestratorSummaryPrompt({
          formattedConversation,
          previousSummary,
          targetTokens: computeSummaryBudget(args.messages, maxTokens),
          durableMemoryReference: args.durableMemoryReference,
        });

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
        // A summary prompt is never replayed, so writing it to the prompt
        // cache only pays the write premium (pi-mono 9b3a20591). No
        // sessionId either: an absent id keeps this one-off request off the
        // live session's routing affinity and Codex socket, which is the
        // isolation a fresh per-summary id buys in pi-mono.
        {
          apiKey,
          maxTokens,
          cacheRetention: "none",
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
    const maxChars = summaryInputCharBudget(
      getContextWindow(args.resolvedLlm),
      summaryOverheadChars({
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
    return orchestratorKeepRecentTokens(getContextWindow(route));
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
    (getBilledContextTokens(args.threadKey) ??
      Math.max(
        narrowProbe.estimatedTokens,
        getLastProviderPayloadTokens(args.threadKey) ?? 0,
      )) < getCompactionTriggerTokens(args.resolvedLlm, args.agentType)
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

  // A complete narrow probe distinguishes active/unresolved quarantine rows
  // from historical rows already masked by the effective checkpoint. Only the
  // former require reconstructing the append-only log; otherwise doing so
  // needlessly pages old chunked screenshot payloads back into memory.
  const inspectRawQuarantine =
    initialRelevantQuarantineCount === null ||
    initialRelevantQuarantineCount > 0;
  const rawStoredMessages =
    inspectRawQuarantine &&
    typeof args.store.loadRawThreadMessages === "function"
      ? args.store.loadRawThreadMessages(args.threadKey)
      : null;
  // Carry forward checkpoint-confirmed keys even when the cheap path can skip
  // raw history. Successor checkpoints must retain that proof so the same
  // covered records remain resolved on future probes.
  let quarantineKeys = new Set([
    ...checkpointQuarantineKeys,
    ...quarantinedToolResultKeys(rawStoredMessages ?? storedMessages),
  ]);
  const effectiveToolResultKeys = new Set(
    storedMessages
      .filter((message: any) => message.payload?.role === "toolResult")
      .map((message: any) => toolResultQuarantineKey(message)),
  );
  const rebuildUnsafeCheckpoint =
    quarantineKeys.size > 0 &&
    storedMessages.some((message: any) =>
      parseThreadCheckpoint(message.content),
    ) &&
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
    quarantineKeys = new Set([
      ...checkpointQuarantineKeys,
      ...quarantinedToolResultKeys(storedMessages),
    ]);
  }

  const policy = resolveCompactionSplitPolicy(args.agentType);
  const totalTokens = getThreadTokenEstimate(storedMessages);
  const forced = forcedBeforeProbe;
  const imageHistory = getThreadImageHistoryStats(storedMessages);
  // The trigger measures what the provider actually received: its billed
  // usage for the last response since the last compaction (as Pi does).
  // Without one, the last preflight estimate of the full outbound payload
  // (system prompt + tool schemas + resident context + history), floored by
  // the history-only estimate (e.g. the first turn after a worker restart).
  const measuredTokens =
    getBilledContextTokens(args.threadKey) ??
    Math.max(totalTokens, getLastProviderPayloadTokens(args.threadKey) ?? 0);
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
  // Ordinary turns remain byte-identical. Image removal happens only here,
  // at the already-cache-breaking checkpoint overlay, and the prospective
  // splitter is allowed to compact a single oversized newest message.
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
            : MIN_TAIL_MESSAGES,
        );
  if (
    !splitMessages &&
    (forced || rebuildUnsafeCheckpoint) &&
    !imageHistory.overBudget
  ) {
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
  // This structured receipt is produced by the harness, not by the summary
  // model. The store renders it as a separate checkpoint section, so receipt
  // presence/content cannot depend on whether the model mentions an image.
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
      ...(args.stellaDataDir
        ? { readDiskFile: readStellaDataFile(args.stellaDataDir) }
        : {}),
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
  const pinnedInstruction =
    policy === "orchestrator" && splitMessages.latestUserMessage
      ? pinnedInstructionText(
          extractUserMessageText(splitMessages.latestUserMessage),
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
    ...(pinnedInstruction
      ? { pinnedUserInstruction: { text: pinnedInstruction } }
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
      clearProviderUsage(args.threadKey);
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
