import type {
  RuntimeThreadMessage,
  StoredImageContent,
} from "./storage/shared.js";
import {
  decodedBase64ByteLength,
  estimateModelVisibleImageTokens,
} from "./agent-runtime/context-budget.js";
import {
  PINNED_INSTRUCTION_ENTRY_ID_MARKER,
  RESIDENT_FOLD_ENTRY_ID_MARKER,
} from "./agent-runtime/resident-context.js";
import {
  MIN_TAIL_MESSAGES,
  alignCutForward,
  estimatePayloadTokens,
  planOrchestratorCompaction,
  THREAD_CHECKPOINT_MARKER,
  type CompactionMessageView,
} from "./agent-runtime/orchestrator-compaction.js";

/**
 * Compaction split policies: where a thread is cut for a checkpoint. The
 * orchestrator keeps a token-sized tail and pins its latest instruction;
 * general agents and subagents follow pi-mono's turn-aware cut; image
 * pressure cuts just enough to make the retained images fit.
 */

export const THREAD_COMPACTION_PROTECT_HEAD_MESSAGES = 3;
/** Fixed verbatim tail for general/subagent compaction (pi-mono). */
export const GENERAL_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
export const MAX_ACTIVE_THREAD_IMAGES = 8;
export const ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET = 12 * 1024 * 1024;

export type ThreadMessage = {
  timestamp: number;
  role: "user" | "assistant" | "runtimeInternal";
  content: string;
  toolCallId?: string;
};

export type StoredThreadMessage = {
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

export type ThreadCheckpoint = {
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

export type ThreadImageReceipt = {
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

const estimateMessageTokens = (message: ThreadMessage): number =>
  Math.max(1, Math.ceil((message.content ?? "").length / 4));

export const storedMessageImageBlocks = (
  message: StoredThreadMessage,
): StoredImageContent[] => {
  const payload = message.payload;
  if (payload && typeof payload.content !== "string") {
    return payload.content.filter(
      (block): block is StoredImageContent => block.type === "image",
    );
  }
  const customContent = message.customMessage?.content;
  if (Array.isArray(customContent)) {
    return customContent.filter(
      (block): block is StoredImageContent => block.type === "image",
    );
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

export const isCompactionMessage = (message: StoredThreadMessage): boolean =>
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

/** The cut planner's view of a stored message. */
const compactionView = (
  message: StoredThreadMessage,
): CompactionMessageView => ({
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
