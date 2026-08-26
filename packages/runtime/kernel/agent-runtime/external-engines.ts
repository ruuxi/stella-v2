import crypto from "crypto";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "../../ai/types.js";
import type { AgentMessage } from "../agent-core/types.js";
import type {
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import {
  ClaudeCodeSteeringInterruptError,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../integrations/claude-code-session-runtime.js";
import {
  getClaudeCodeAgentModelId,
  getClaudeCodeRuntimeEffortLevel,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import {
  buildCodexPromptFromMessages,
  runCodexAgentTurn,
  shutdownCodexAppServerRuntime,
  shouldUseCodexAgentRuntime,
  type CodexCommandExecutionActivity,
} from "../integrations/codex-agent-runtime.js";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
  createRuntimePromptAgentMessage,
} from "./run-preparation.js";
import {
  collectDemotedToolNames,
  executeRuntimeToolCall,
  extractAttachImageBlocks,
  getProviderToolMetadata,
  getRuntimeToolMetadata,
  truncateModelVisibleToolText,
  preserveModelVisibleToolText,
} from "./tool-adapters.js";
import type { ImageCapTarget } from "../../ai/utils/image-caps.js";
import {
  markOrchestratorErrorReported,
  resolveInterruptionReason,
} from "./run-completion.js";
import { superviseExternalEngineTurn } from "./external-engine-lifecycle.js";
import {
  createExternalOrchestratorRunSession,
  createExternalSubagentRunSession,
  type ExternalOrchestratorRunSession,
  type ExternalSubagentRunSession,
} from "./run-session.js";
import {
  now,
  resolveAgentWorkingDirectory,
  textFromUnknown,
} from "./shared.js";
import { createExternalAssistantUpdateBuffer } from "./external-assistant-updates.js";
import {
  buildHistorySource,
  buildOrchestratorPromptMessages,
  buildSubagentPromptMessages,
  persistAssistantReply,
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "./thread-memory.js";
import { ORCHESTRATOR_ROSTER_CUSTOM_TYPE } from "../storage/shared.js";
import type {
  BaseRunOptions,
  OrchestratorRunOptions,
  RuntimeRunCallbacks,
  RuntimeStatusEvent,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { sanitizeSensitiveData } from "@stella/contracts/sensitive-data";
import { markImageOperationDelivered } from "../tools/image-operation-store.js";

/**
 * External engines run node_repl through the same host dispatcher, so the
 * tool contexts they build must include context-visible demoted tool names:
 * when node_repl is available, demoted tools are deliberately absent from
 * the direct/MCP tool list and reachable only as `tools.<name>` inside the
 * REPL, which is gated on `context.allowedToolNames`.
 * Without node_repl, getProviderToolMetadata exposes demoted tools directly,
 * so this union must include them in the host permission context too.
 */
const widenAllowlistWithDemotedTools = (
  toolsAllowlist: string[] | undefined,
  toolCatalog: readonly ToolMetadata[] | undefined,
  connectorProvider: string | undefined,
): string[] | undefined => {
  if (!toolsAllowlist || toolsAllowlist.length === 0) return toolsAllowlist;
  const demoted: string[] = collectDemotedToolNames(
    toolCatalog,
    connectorProvider,
  );
  if (demoted.length === 0) return toolsAllowlist;
  return [...new Set([...toolsAllowlist, ...demoted])];
};

const EMPTY_USAGE: Usage = {
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
};

const buildToolCallPayload = (args: {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: args.toolCallId,
      name: args.toolName,
      arguments: args.toolArgs,
    },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-code",
  usage: EMPTY_USAGE,
  stopReason: "toolUse",
  timestamp: now(),
});

/**
 * Build an interim assistant message pairing streamed preamble text with the
 * tool call it precedes. Passing this through `recordAssistantMessageEnd`
 * stamps the emitted stream event with `followedByToolCall` (the recorder sets
 * it whenever a message carries a tool-call block), so the renderer keeps the
 * working indicator up across the preamble→tool gap instead of handing off to
 * the painted preamble text. External engines stream a visible preamble but,
 * unlike the default runtime, never record a message-end boundary before a
 * tool — so without this the indicator would dismiss on the preamble and only
 * reappear at tool-start.
 */
export const buildPreambleToolBoundaryMessage = (args: {
  preamble: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): AssistantMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: args.preamble },
    {
      type: "toolCall",
      id: args.toolCallId,
      name: args.toolName,
      arguments: args.toolArgs,
    },
  ],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "codex",
  usage: EMPTY_USAGE,
  stopReason: "toolUse",
  timestamp: now(),
});

const buildToolResultText = (toolResult: {
  result?: unknown;
  error?: string;
}): string =>
  toolResult.error
    ? `Error: ${toolResult.error}`
    : textFromUnknown(toolResult.result);

const buildToolResultContent = async (
  toolResult: {
    result?: unknown;
    error?: string;
  },
  imageCapTarget: ImageCapTarget = {},
  spillContext?: Readonly<{
    stellaDataDir?: string;
    runId: string;
    toolCallId: string;
  }>,
): Promise<(TextContent | ImageContent)[]> => {
  const rawText = buildToolResultText(toolResult);
  const { text, images } = await extractAttachImageBlocks(
    rawText,
    imageCapTarget,
  );
  const truncatedText = spillContext
    ? await preserveModelVisibleToolText(text, spillContext)
    : truncateModelVisibleToolText(text);
  const content: (TextContent | ImageContent)[] = [];
  if (truncatedText.text || images.length === 0) {
    content.push({ type: "text", text: truncatedText.text });
  }
  content.push(...images);
  return content;
};

type ExternalEngineSessionKind =
  | "claude_code_local"
  | "claude_code_local_vanilla"
  | "codex_cli";

type ExternalOrchestratorEngine = "claude_code_local";

/** Legacy snapshots omit the field and therefore remain on native runtimes. */
export const usesManagedSubscriptionHarness = (
  snapshot: { subscriptionHarnessEnabled?: boolean } | undefined,
): boolean => snapshot?.subscriptionHarnessEnabled === true;

const shouldUseClaudeCodeRuntime = (opts: BaseRunOptions): boolean => {
  const primaryModelId = opts.agentContext.model ?? opts.resolvedLlm.model.id;
  return shouldUseClaudeCodeAgentRuntime({
    stellaAppDir: opts.stellaAppDir,
    agentEngine: opts.agentContext.agentEngine,
    modelId: primaryModelId,
  });
};

export const selectExternalOrchestratorEngine = (
  opts: BaseRunOptions,
): ExternalOrchestratorEngine | null => {
  if (shouldUseClaudeCodeRuntime(opts)) {
    return "claude_code_local";
  }
  return null;
};

const EXTERNAL_ENGINE_SESSION_PREFIXES: readonly string[] = [
  "claude_code_local:",
  // Vanilla per-spawn Claude Code sessions are persisted under their own
  // namespace so a takeover run never `--resume`s a vanilla conversation
  // (and vice versa).
  "claude_code_local_vanilla:",
  "codex_cli:",
];

export const getExternalEngineSessionId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
}): string | undefined => {
  const raw = args.store.getThreadExternalSessionId(args.threadKey);
  if (!raw) return undefined;
  const expectedPrefix = `${args.engine}:`;
  if (raw.startsWith(expectedPrefix)) {
    const sessionId = raw.slice(expectedPrefix.length).trim();
    return sessionId || undefined;
  }
  if (
    EXTERNAL_ENGINE_SESSION_PREFIXES.some((prefix) => raw.startsWith(prefix))
  ) {
    return undefined;
  }
  // Existing Claude Code sessions were stored before engine namespacing.
  return args.engine === "claude_code_local" ? raw : undefined;
};

export const setExternalEngineSessionId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
  sessionId: string;
}) => {
  args.store.setThreadExternalSessionId(
    args.threadKey,
    `${args.engine}:${args.sessionId}`,
  );
};

/**
 * External delivery state is namespaced by engine because each CLI transcript
 * only contains rows actually prompted to that engine. An engine takeover must
 * start from an empty cursor rather than inheriting another engine's delivery
 * claim.
 */
export const getExternalDeliveredEntryId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
}): string | undefined => {
  const raw = args.store.getThreadExternalDeliveredEntryId(args.threadKey);
  if (!raw) return undefined;
  const expectedPrefix = `${args.engine}:`;
  if (!raw.startsWith(expectedPrefix)) return undefined;
  const entryId = raw.slice(expectedPrefix.length).trim();
  return entryId || undefined;
};

export const setExternalDeliveredEntryId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
  entryId: string;
}): void => {
  args.store.setThreadExternalDeliveredEntryId(
    args.threadKey,
    `${args.engine}:${args.entryId}`,
  );
};

const persistExternalPromptMessages = (
  opts: BaseRunOptions,
  threadKey: string,
  promptMessages: RuntimePromptMessage[],
) => {
  const promptInputs: Array<
    RuntimePromptMessage & { attachments?: RuntimeAttachmentRef[] }
  > =
    promptMessages.length > 0
      ? promptMessages
      : [
          {
            text: opts.userPrompt,
            attachments: opts.attachments,
          },
        ];
  const promptTimestamp = now();
  for (const [index, promptInput] of promptInputs.entries()) {
    const promptMessage = createRuntimePromptAgentMessage(
      promptInput,
      promptTimestamp + index,
    );
    const messageType = promptInput.messageType ?? "user";
    if (messageType === "user" && promptMessage.role === "user") {
      persistThreadPayloadMessage(opts.store, {
        threadKey,
        payload: promptMessage,
      });
    }
    if (
      messageType === "message" &&
      promptMessage.role === "runtimeInternal" &&
      promptInput.customType?.trim() &&
      promptInput.customType !== "runtime.queued_message_reply"
    ) {
      persistThreadCustomMessage(opts.store, {
        threadKey,
        customType: promptInput.customType,
        content: promptMessage.content,
        display: promptMessage.display === true,
        timestamp: promptMessage.timestamp,
        ...(promptMessage.eventId ? { eventId: promptMessage.eventId } : {}),
        ...(opts.agentType === "orchestrator"
          ? { preservePayloadExactly: true }
          : {}),
      });
      if (promptInput.customType === ORCHESTRATOR_ROSTER_CUSTOM_TYPE) {
        opts.store.consumeOrchestratorReminder?.(opts.conversationId);
      }
    }
  }
};

const formatClaudePromptMessage = (
  message: RuntimePromptMessage,
  index: number,
): string => {
  const messageType = message.messageType ?? "user";
  const visibility = message.uiVisibility ?? "visible";
  const customType = message.customType?.trim();
  const attrs = [
    `index="${index + 1}"`,
    `type="${messageType}"`,
    `visibility="${visibility}"`,
    ...(customType
      ? [`customType="${customType.replaceAll('"', "&quot;")}"`]
      : []),
  ].join(" ");
  return `<message ${attrs}>\n${message.text.trim()}\n</message>`;
};

export const buildClaudePromptFromMessages = (
  promptMessages: RuntimePromptMessage[],
): string =>
  [
    "Stella is providing this turn as ordered prompt messages.",
    'Messages with visibility="hidden" are runtime context for you only; do not quote or reveal them unless the user explicitly asks about the relevant fact.',
    ...promptMessages.map(formatClaudePromptMessage),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

type ExternalQueuedMessage = {
  message: AgentMessage;
  delivery: "steer" | "followUp";
};

export const publishQueuedUserMessageStarts = (args: {
  entries: ExternalQueuedMessage[];
  runEvents:
    | ExternalOrchestratorRunSession["runEvents"]
    | ExternalSubagentRunSession["runEvents"];
  callbacks?: Partial<RuntimeRunCallbacks>;
}): void => {
  for (const entry of args.entries) {
    if (entry.message.role !== "user") continue;
    const queuedStarted = args.runEvents.recordQueuedUserMessageStart();
    if (queuedStarted) {
      args.callbacks?.onRunStarted?.(queuedStarted);
    }
  }
};

const contentToText = (content: AgentMessage["content"]): string => {
  if (typeof content === "string") {
    return content.trim();
  }
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[Image: ${block.mimeType}]`;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "toolCall") {
        return `[Tool call] ${block.name}\n${textFromUnknown(block.arguments)}`;
      }
      return "";
    })
    .filter((entry) => entry.trim().length > 0)
    .join("\n\n")
    .trim();
};

export const buildExternalStellaHistoryPromptMessage = (args: {
  opts: BaseRunOptions;
  promptMessages: RuntimePromptMessage[];
}): RuntimePromptMessage | null => {
  const history = buildHistorySource(args.opts.agentContext);
  if (history.length === 0) {
    return null;
  }
  const lastPromptUserText = [...args.promptMessages]
    .reverse()
    .find((message) => (message.messageType ?? "user") === "user")
    ?.text.trim();
  const trimmedHistory = [...history];
  const lastHistory = trimmedHistory[trimmedHistory.length - 1];
  if (
    lastHistory?.role === "user" &&
    lastPromptUserText &&
    contentToText(lastHistory.content) === lastPromptUserText
  ) {
    trimmedHistory.pop();
  }
  const lines = trimmedHistory
    .map((message, index) => {
      const text = contentToText(message.content);
      if (!text) return "";
      return `<history_message index="${index + 1}" role="${message.role}">\n${text}\n</history_message>`;
    })
    .filter((entry) => entry.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  return {
    messageType: "message",
    uiVisibility: "hidden",
    customType: "runtime.stella_thread_history",
    text: [
      '<stella_thread_history source="stella" note="Stella chat/runtime history is the source of truth for recall. Use it to answer questions about prior Stella messages, even when external engine session state is unavailable or incomplete.">',
      ...lines,
      "</stella_thread_history>",
    ].join("\n"),
  };
};

/**
 * Out-of-band rows the orchestration layer appends to a thread without going
 * through the engine's own turn loop — managed-child terminal reports and
 * interim task updates (see runner/agent-orchestration.ts). The Pi engine
 * picks these up through its history refresh; external engines resume from
 * their own CLI transcript, so these rows must be injected explicitly.
 */
const EXTERNAL_DELTA_CUSTOM_TYPES: ReadonlySet<string> = new Set([
  "runtime.task_lifecycle",
  "runtime.task_update",
]);

/**
 * Size budget for one delta block. Child final reports are not capped at
 * persistence time, and an absent watermark (legacy value or engine takeover)
 * selects the whole raw backlog — an unbounded block could exceed the
 * engine's usable input, fail the turn, never advance the success-only
 * watermark, and rebuild the identical oversized prompt forever. Bounding
 * turns that failure loop into incremental drain: each successful turn
 * advances the watermark past the delivered batch and the next turn picks up
 * the remainder.
 *
 * Reports are delivered WHOLE: buildAgentEventPrompt deliberately preserves
 * full child final reports because the TAIL carries outcomes and blockers —
 * cutting it could make a manager act on a false completion with no way to
 * retrieve the omitted end. A report too large for the normal block budget
 * gets its own dedicated single-row batch (the contiguous-prefix watermark
 * semantics permit a 1-row batch) sized up to the engine's practical input
 * capacity; only a report exceeding even that is elided, and then from the
 * MIDDLE with an explicit marker so head and tail both survive.
 *
 * Budgets bound the SERIALIZED output — wrapper tags, markers, and the
 * envelope count, not just report text — and a row-count cap keeps a flood
 * of tiny rows from ballooning the block through per-row overhead.
 * `EXTERNAL_DELTA_MAX_MESSAGE_CHARS` is the hard contract on the COMPLETE
 * serialized message (prefix + out-of-order latest section + markers +
 * envelope): when a dedicated oversized report and an oversized triggering
 * row coincide, their elision budgets shrink to share the cap. Without a
 * global bound, an engine rejecting the oversized prompt combined with
 * success-only watermark persistence would rebuild the identical prompt
 * forever.
 */
export const EXTERNAL_DELTA_MAX_TOTAL_CHARS = 48_000;
export const EXTERNAL_DELTA_MAX_ROWS = 100;
export const EXTERNAL_DELTA_MAX_MESSAGE_CHARS = 300_000;

export type ExternalThreadUpdatesDelta = {
  /** Hidden prompt message carrying the undelivered rows, or null. */
  message: RuntimePromptMessage | null;
  /**
   * Entry id of the newest out-of-band row COVERED by the prompt this delta
   * rides in — included in the block, deduplicated against the turn's prompt
   * messages, or contained in a `deliveredContextTexts` block sent alongside
   * it. Rows past the size budget are NOT covered. When everything after the
   * anchor was already delivered this is the newest candidate (an unchanged
   * watermark); null only when the thread has no out-of-band rows at all.
   * Persist it as the delivered watermark once the turn succeeds.
   */
  lastEntryId: string | null;
  /** Number of candidates covered, counting from the `afterEntryId` anchor. */
  coveredCount: number;
  /** True when the size budget cut the batch short; more backlog remains. */
  truncated: boolean;
};

/**
 * Build the delta of out-of-band runtime rows an external engine session has
 * not seen yet.
 *
 * The full Stella-history block is only sent on session-creating turns (see
 * `buildClaudeCodeTurnPrompts`); resumed turns rely on the CLI transcript,
 * which never contains rows written out-of-band by the orchestration layer —
 * e.g. a manager's `runtime.task_lifecycle` child reports, whose wake prompt
 * is deliberately a content-free stub. This delta carries exactly those rows
 * persisted after `afterEntryId` (the delivered watermark), keeping resumed
 * prompts small instead of re-sending the whole history each turn.
 *
 * Candidates are scanned from the RAW entry log, not the compaction-overlaid
 * projection: a compaction checkpoint folds a range into one summary row, and
 * an undelivered report inside that range would otherwise stop being a
 * candidate while newer surviving rows advance the watermark past it —
 * silently dropping it for engines that never re-read Stella history. The
 * watermark bounds the scan, so raw reads stay small and deliver-once.
 *
 * Rows whose text is already present verbatim in this turn's prompt messages
 * (e.g. an orchestrator's in-memory follow-up delivery of the same report)
 * or contained in a `deliveredContextTexts` block that rides in the SAME
 * prompt (the full-history block on session-creating turns) are counted as
 * delivered but omitted from the block. The caller must guarantee that the
 * returned message is included in every prompt variant actually sent —
 * including resume-fallback reseeds — because `lastEntryId` becomes the
 * delivered watermark on turn success.
 */
export const buildExternalThreadUpdatesDelta = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  afterEntryId?: string;
  promptMessages: RuntimePromptMessage[];
  /**
   * Texts of context blocks included in the same prompt as the delta (e.g.
   * the full Stella-history block). Rows already contained in one of them
   * are delivered by that block, not re-injected.
   */
  deliveredContextTexts?: string[];
}): ExternalThreadUpdatesDelta => {
  const candidates = args.store
    .loadRawThreadMessagesWithEntryTypes(args.threadKey)
    .filter(
      (row) =>
        typeof row.entryId === "string" &&
        row.entryId.length > 0 &&
        row.customMessage !== undefined &&
        EXTERNAL_DELTA_CUSTOM_TYPES.has(row.customMessage.customType),
    );
  if (candidates.length === 0) {
    return {
      message: null,
      lastEntryId: null,
      coveredCount: 0,
      truncated: false,
    };
  }
  const afterIndex = args.afterEntryId
    ? candidates.findIndex((row) => row.entryId === args.afterEntryId)
    : -1;
  const undelivered = candidates.slice(afterIndex + 1);
  if (undelivered.length === 0) {
    return {
      message: null,
      lastEntryId: candidates[candidates.length - 1]?.entryId ?? null,
      coveredCount: 0,
      truncated: false,
    };
  }
  const promptTexts = new Set(
    args.promptMessages
      .map((message) => message.text.trim())
      .filter((text) => text.length > 0),
  );
  const contextTexts = (args.deliveredContextTexts ?? []).filter(
    (text) => text.trim().length > 0,
  );
  const isRowCoveredElsewhere = (text: string): boolean =>
    promptTexts.has(text) ||
    contextTexts.some((context) => context.includes(text));
  // Middle elision for a report beyond its rendering budget: the head
  // carries the task framing and the TAIL carries outcomes and blockers, so
  // both must survive; only the middle may be elided, marked. The result
  // (marker included) never exceeds `maxChars`, and the cut boundaries are
  // nudged off UTF-16 surrogate pairs so no lone surrogate is emitted.
  const ELISION_MARKER_ALLOWANCE = 220;
  const isHighSurrogate = (code: number): boolean =>
    code >= 0xd800 && code <= 0xdbff;
  const isLowSurrogate = (code: number): boolean =>
    code >= 0xdc00 && code <= 0xdfff;
  const elideMiddleTo = (text: string, maxChars: number): string => {
    if (text.length <= maxChars) {
      return text;
    }
    const usable = Math.max(0, maxChars - ELISION_MARKER_ALLOWANCE);
    let headEnd = Math.ceil(usable * 0.6);
    let tailStart = text.length - (usable - headEnd);
    if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) {
      headEnd -= 1;
    }
    if (tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) {
      tailStart += 1;
    }
    const elided = tailStart - headEnd;
    return `${text.slice(0, headEnd)}\n[… ${elided} characters elided from the MIDDLE of this report to fit the engine input; head and tail are verbatim, and the full report is in the Stella thread …]\n${text.slice(tailStart)}`;
  };
  const serializeRow = (
    index: number | string,
    customType: string,
    rowText: string,
  ): string =>
    `<thread_update index="${index}" customType="${customType}">\n${rowText}\n</thread_update>`;
  const HEADER =
    '<stella_thread_updates source="stella" note="Runtime events (managed-agent reports and task updates) persisted to this Stella thread since your previous turn. They are not in your session transcript; treat them as delivered context.">';
  const FOOTER = "</stella_thread_updates>";
  const WITHHELD_NOTE =
    "[Some NEWER updates were withheld to fit this turn; they will be delivered in order on later turns. The newest update is included below so it is never withheld.]";
  const LATEST_MARKER =
    "[Newest update, delivered ahead of the withheld ones above; it will be re-delivered in order on a later turn.]";
  // Reserve envelope + marker space so the serialized block (not just the
  // report text) honors the budget; the latest-section reserve keeps a small
  // triggering row from pushing the block past it.
  const LATEST_SECTION_RESERVE = 2_000;
  const packingBudget =
    EXTERNAL_DELTA_MAX_TOTAL_CHARS -
    HEADER.length -
    FOOTER.length -
    WITHHELD_NOTE.length -
    LATEST_MARKER.length -
    LATEST_SECTION_RESERVE;
  // Oldest-first bounded SELECTION of the contiguous covered prefix (raw
  // text cost; elision happens at render time under the global cap).
  // Coverage must stay a contiguous prefix of the candidate order — once the
  // budget is exhausted the scan stops, even for rows that would have been
  // deduplicated for free, so the watermark can never step over an
  // unexamined row. Rows are packed WHOLE: a first row too large for the
  // budget becomes its own dedicated single-row batch instead of losing its
  // tail.
  type SelectedRow = { text: string; customType: string };
  const prefixRows: SelectedRow[] = [];
  let serializedChars = 0;
  let dedicatedOversized = false;
  let coveredCount = 0;
  let coveredLastEntryId: string | null = null;
  let coveredEndIndex = -1;
  let truncated = false;
  for (const [index, row] of undelivered.entries()) {
    const text = row.content.trim();
    if (!text || isRowCoveredElsewhere(text)) {
      coveredCount += 1;
      coveredLastEntryId = row.entryId ?? coveredLastEntryId;
      coveredEndIndex = index;
      continue;
    }
    const cost =
      serializeRow(prefixRows.length + 1, row.customMessage!.customType, text)
        .length + 1;
    if (
      prefixRows.length > 0 &&
      (serializedChars + cost > packingBudget ||
        prefixRows.length >= EXTERNAL_DELTA_MAX_ROWS)
    ) {
      truncated = true;
      break;
    }
    prefixRows.push({ text, customType: row.customMessage!.customType });
    serializedChars += cost;
    coveredCount += 1;
    coveredLastEntryId = row.entryId ?? coveredLastEntryId;
    coveredEndIndex = index;
    if (cost > packingBudget) {
      // Dedicated single-row batch for an oversized report. Stop here so
      // the block stays a one-report batch.
      dedicatedOversized = true;
      if (index < undelivered.length - 1) {
        truncated = true;
      }
      break;
    }
  }
  truncated = truncated || coveredEndIndex < undelivered.length - 1;
  // The content-free wake stub means this delta is the manager's only view
  // of the report that woke it — and external turns get no extra queued step
  // to fetch more. The newest not-otherwise-covered row is therefore always
  // included, even beyond the contiguous prefix, as a marked out-of-order
  // section. The watermark still advances only through the contiguous
  // prefix, so this row is re-delivered in order later (at-least-once).
  let latestRow: SelectedRow | null = null;
  if (truncated) {
    for (
      let index = undelivered.length - 1;
      index > coveredEndIndex;
      index -= 1
    ) {
      const row = undelivered[index]!;
      const text = row.content.trim();
      if (!text || isRowCoveredElsewhere(text)) {
        continue;
      }
      latestRow = { text, customType: row.customMessage!.customType };
      break;
    }
  }
  const lastEntryId =
    coveredLastEntryId ??
    (args.afterEntryId && afterIndex >= 0 ? args.afterEntryId : null);
  if (prefixRows.length === 0 && !latestRow) {
    return { message: null, lastEntryId, coveredCount, truncated };
  }
  // Render under ONE global cap on the complete serialized message. All
  // fixed parts (envelope, notes, markers, wrappers, joiners) are charged
  // first; the remaining content budget is shared between the prefix and
  // the latest section. In the normal path the prefix is already bounded by
  // `packingBudget` (~1/6 of the cap), so the latest row gets the large
  // remainder; when a dedicated oversized report and an oversized latest
  // row coincide, each is elided to roughly half so the composed total
  // still honors the cap and the drain loop keeps making progress.
  const wrapperCost = (index: number | string, customType: string): number =>
    serializeRow(index, customType, "").length + 1;
  const fixedOverhead =
    HEADER.length +
    FOOTER.length +
    1 +
    (truncated ? WITHHELD_NOTE.length + 1 : 0) +
    (latestRow ? LATEST_MARKER.length + 1 : 0);
  const contentBudget = EXTERNAL_DELTA_MAX_MESSAGE_CHARS - fixedOverhead;
  let renderedLatest: string | null = null;
  let latestBudgetUsed = 0;
  if (latestRow) {
    const latestWrapper = wrapperCost("latest", latestRow.customType);
    const prefixReserve = dedicatedOversized
      ? // Split roughly in half with the dedicated report; a small latest
        // row hands its unused share back to the report below.
        Math.floor((contentBudget - latestWrapper) / 2)
      : // Selection cost already includes wrappers and joiners, so this
        // reserves exactly what the whole prefix will render to.
        serializedChars;
    const latestTextBudget = Math.max(
      ELISION_MARKER_ALLOWANCE * 2,
      contentBudget - latestWrapper - prefixReserve,
    );
    const latestText = elideMiddleTo(latestRow.text, latestTextBudget);
    renderedLatest = serializeRow("latest", latestRow.customType, latestText);
    latestBudgetUsed = renderedLatest.length + 1;
  }
  const prefixContentBudget = contentBudget - latestBudgetUsed;
  const lines: string[] = [];
  let prefixUsed = 0;
  for (const [index, selected] of prefixRows.entries()) {
    const rowWrapper = wrapperCost(index + 1, selected.customType);
    const rowTextBudget = Math.max(
      ELISION_MARKER_ALLOWANCE * 2,
      prefixContentBudget - prefixUsed - rowWrapper,
    );
    const rowText = elideMiddleTo(selected.text, rowTextBudget);
    const serialized = serializeRow(index + 1, selected.customType, rowText);
    lines.push(serialized);
    prefixUsed += serialized.length + 1;
  }
  return {
    message: {
      messageType: "message",
      uiVisibility: "hidden",
      customType: "runtime.stella_thread_updates",
      text: [
        HEADER,
        ...lines,
        ...(truncated ? [WITHHELD_NOTE] : []),
        ...(renderedLatest ? [LATEST_MARKER, renderedLatest] : []),
        FOOTER,
      ].join("\n"),
    },
    lastEntryId,
    coveredCount,
    truncated,
  };
};

/**
 * Per-turn watermark arithmetic for external-engine delta delivery.
 *
 * A turn can send several prompts: the main prompt, queued follow-ups that
 * continue the SAME session (deltas anchored at the in-turn cursor so the
 * live session gets each row once), and fallback prompts that seed a FRESH
 * session when recovery abandons the old one (missing resume / compaction
 * loop). A fresh session never saw the cursor-anchored deltas, so
 * reseed-capable prompts carry deltas anchored at the PERSISTED watermark.
 * Because reseeds are not observable from here, the persisted watermark
 * after success is the minimum of the mainline coverage and every
 * reseed-prompt coverage — under-advancing only re-delivers (at-least-once),
 * never skips.
 *
 * Coverage counts are comparable because every delta covers a contiguous
 * prefix of the same append-only candidate order starting at the persisted
 * watermark; mainline counts accumulate across cursor-anchored windows.
 */
export const createExternalDeltaWatermarkTracker = (
  initialEntryId: string | undefined,
) => {
  let mainlineCoveredCount = 0;
  let cursorEntryId = initialEntryId;
  let guaranteedCoveredCount = Number.POSITIVE_INFINITY;
  let guaranteedEntryId = initialEntryId;
  return {
    /** Anchor for the next mainline (live-session) delta build. */
    get cursor(): string | undefined {
      return cursorEntryId;
    },
    /** Record a delta sent to the live session (anchored at the cursor). */
    noteMainlineDelta(delta: ExternalThreadUpdatesDelta): void {
      mainlineCoveredCount += delta.coveredCount;
      if (delta.lastEntryId) {
        cursorEntryId = delta.lastEntryId;
      }
    },
    /**
     * Record a delta carried by a prompt that may seed a fresh session
     * (anchored at the persisted watermark).
     */
    noteReseedDelta(delta: ExternalThreadUpdatesDelta): void {
      if (delta.coveredCount < guaranteedCoveredCount) {
        guaranteedCoveredCount = delta.coveredCount;
        guaranteedEntryId = delta.lastEntryId ?? initialEntryId;
      }
    },
    /** Watermark safe to persist after the turn succeeds. */
    resolve(): string | undefined {
      return guaranteedCoveredCount < mainlineCoveredCount
        ? guaranteedEntryId
        : cursorEntryId;
    },
  };
};

/**
 * Build the per-turn Claude Code prompt pair.
 *
 * The stored Stella history (already checkpoint-compacted by
 * `loadThreadMessages`) is prepended to the main prompt only when there is no
 * resumable CLI session for this thread — a brand-new session or an
 * engine-switch takeover. Resumed turns must NOT re-send it: the resumed CLI
 * conversation already contains everything from prior turns, and re-injecting
 * the full history every turn grows the session transcript quadratically
 * until Claude Code's own auto-compaction fires on every turn (an endless
 * "Compacting context" loop). A lost or looping session still reseeds from
 * the checkpoint-style history through `resumeFallbackPrompt`.
 */
export const buildClaudeCodeTurnPrompts = (args: {
  historyPromptMessage: RuntimePromptMessage | null;
  promptMessages: RuntimePromptMessage[];
  hasPersistedSession: boolean;
  deltaPromptMessage?: RuntimePromptMessage | null;
  fallbackDeltaPromptMessage?: RuntimePromptMessage | null;
}): { prompt: string; resumeFallbackPrompt?: string } => {
  const fallbackDeltaMessage = args.hasPersistedSession
    ? (args.fallbackDeltaPromptMessage ?? args.deltaPromptMessage)
    : args.deltaPromptMessage;
  const fallbackSeedMessages = [
    ...(args.historyPromptMessage ? [args.historyPromptMessage] : []),
    ...(fallbackDeltaMessage ? [fallbackDeltaMessage] : []),
  ];
  const historyPrefixedPrompt =
    fallbackSeedMessages.length > 0
      ? buildClaudePromptFromMessages([
          ...fallbackSeedMessages,
          ...args.promptMessages,
        ])
      : undefined;
  const prompt =
    !args.hasPersistedSession && historyPrefixedPrompt
      ? historyPrefixedPrompt
      : buildClaudePromptFromMessages(
          args.deltaPromptMessage
            ? [args.deltaPromptMessage, ...args.promptMessages]
            : args.promptMessages,
        );
  return {
    prompt,
    ...(historyPrefixedPrompt
      ? { resumeFallbackPrompt: historyPrefixedPrompt }
      : {}),
  };
};

const formatQueuedClaudeMessage = (
  entry: ExternalQueuedMessage,
  index: number,
): RuntimePromptMessage => {
  const text = contentToText(entry.message.content);
  if (entry.message.role === "runtimeInternal") {
    return {
      text,
      messageType: "message",
      uiVisibility: "hidden",
      customType: entry.message.customType ?? `runtime.${entry.delivery}`,
      display: entry.message.display,
    };
  }
  return {
    text,
    messageType: "user",
    uiVisibility: "hidden",
    customType: `runtime.queued_${entry.delivery}_${index + 1}`,
  };
};

const attachmentsFromQueuedMessages = (
  entries: ExternalQueuedMessage[],
): RuntimeAttachmentRef[] =>
  entries.flatMap((entry) => {
    if (typeof entry.message.content === "string") {
      return [];
    }
    return entry.message.content.flatMap(
      (block: TextContent | ImageContent | ThinkingContent | ToolCall) =>
        block.type === "image"
          ? [
              {
                url: `data:${block.mimeType};base64,${block.data}`,
                mimeType: block.mimeType,
              },
            ]
          : [],
    );
  });

/**
 * Live facade for an external engine.
 *
 * Steering is queued durably at this boundary and also wakes the active
 * engine-specific delivery hook. Codex consumes the queued entries through
 * `turn/steer`; Claude Code leaves them queued, interrupts its current query,
 * and consumes them as the next message on the same streaming session.
 */
export const createExternalLiveAgent = () => {
  const queued: ExternalQueuedMessage[] = [];
  const state = { isStreaming: true };
  let notifySteerableTurn: (() => void) | null = null;
  return {
    agent: {
      state,
      steer: (message: AgentMessage) => {
        queued.push({ message, delivery: "steer" });
        notifySteerableTurn?.();
      },
      followUp: (message: AgentMessage) => {
        queued.push({ message, delivery: "followUp" });
      },
      clearAllQueues: () => {
        queued.splice(0, queued.length);
      },
    },
    drain(): ExternalQueuedMessage[] {
      return queued.splice(0, queued.length);
    },
    drainSteering(): ExternalQueuedMessage[] {
      const steering = queued.filter((entry) => entry.delivery === "steer");
      if (steering.length === 0) return [];
      const retained = queued.filter((entry) => entry.delivery !== "steer");
      queued.splice(0, queued.length, ...retained);
      return steering;
    },
    prepend(entries: ExternalQueuedMessage[]): void {
      if (entries.length > 0) queued.unshift(...entries);
    },
    beginSteerableTurn(notify: () => void): () => void {
      notifySteerableTurn = notify;
      if (queued.some((entry) => entry.delivery === "steer")) {
        notify();
      }
      return () => {
        if (notifySteerableTurn === notify) {
          notifySteerableTurn = null;
        }
      };
    },
    /**
     * Atomically close the live-delivery boundary only after every accepted
     * message has been drained. Once closed, orchestration queues later work
     * as a fresh root turn instead of handing it to a loop that already left.
     */
    finishIfIdle(): boolean {
      if (queued.length > 0) return false;
      state.isStreaming = false;
      return true;
    },
    finish(): void {
      notifySteerableTurn = null;
      state.isStreaming = false;
    },
  };
};

const isLatestExternalAttempt = (opts: BaseRunOptions): boolean => {
  const generation = opts.agentContext.attemptGeneration;
  if (typeof generation !== "number") return true;
  const threadId = opts.agentContext.activeThreadId ?? opts.agentId;
  if (!threadId) return false;
  return opts.store.getAgentRecord(threadId)?.attemptGeneration === generation;
};

/**
 * Persist and publish one completed serialized engine turn before any queued
 * prompt advances. Attempt generation is checked on both sides of the durable
 * write: a superseded completion may remain in raw history for diagnostics,
 * tagged with its old epoch, but it is never published or allowed to advance
 * session/delivery cursors.
 */
const persistCompletedExternalReply = async (args: {
  opts: BaseRunOptions;
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  callbacks?: Partial<RuntimeRunCallbacks>;
  text: string;
}): Promise<boolean> => {
  if (!isLatestExternalAttempt(args.opts)) return false;
  await persistAssistantReply({
    store: args.opts.store,
    threadKey: args.session.threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
    content: args.text,
    stellaDataDir: args.opts.stellaDataDir,
    runId: args.session.runId,
    ...(typeof args.opts.agentContext.attemptGeneration === "number"
      ? { attemptGeneration: args.opts.agentContext.attemptGeneration }
      : {}),
  });
  if (!isLatestExternalAttempt(args.opts)) return false;
  const assistantMessageEvent = args.session.runEvents.recordAssistantTextEnd(
    args.text,
  );
  if (assistantMessageEvent) {
    args.callbacks?.onAssistantMessage?.(assistantMessageEvent);
  }
  return true;
};

const runClaudeHostedTurn = async (args: {
  opts: BaseRunOptions;
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
  liveAgent?: ReturnType<typeof createExternalLiveAgent>;
}): Promise<{
  finalText: string;
  sessionId: string;
  latestAttempt: boolean;
  fileChanges?: SubagentRunResult["fileChanges"];
}> => {
  const { runId, threadKey, runEvents } = args.session;
  // Orchestrator sessions own the response-target tracker; subagent sessions
  // do not (they don't drive the user-facing chat surface).
  const responseTargetTracker =
    args.session.kind === "orchestrator"
      ? args.session.responseTargetTracker
      : undefined;

  runEvents.recordRunStart();
  persistExternalPromptMessages(args.opts, threadKey, args.promptMessages);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveAgentWorkingDirectory({
    agentType: args.opts.agentType,
    stellaAppDir: args.opts.stellaAppDir,
    workingDirectory: args.opts.toolWorkspaceRoot,
  });
  // General Claude runs are role-split at this boundary. A newly sampled
  // durable snapshot selects Stella's harness by default; false or a legacy
  // absent field selects vanilla Claude Code. The root Orchestrator retains
  // the existing takeover integration.
  const spawnEngine = args.opts.agentContext.spawnEngine;
  const usesSubscriptionHarness =
    args.session.kind === "subagent" &&
    usesManagedSubscriptionHarness(args.opts.agentContext.modelConfigSnapshot);
  const vanilla =
    args.session.kind === "subagent" &&
    !usesSubscriptionHarness &&
    (spawnEngine?.engine === "claude_code_local" ||
      args.opts.agentType === AGENT_IDS.GENERAL);
  const baseSessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${runId}`;
  // Mode-suffixed so a later default-engine run on the same thread never
  // reuses a CLI process that was started with vanilla arguments.
  const sessionKey = vanilla ? `${baseSessionKey}:vanilla` : baseSessionKey;
  // The persisted CLI session id is namespaced by mode too, so a takeover
  // run never resumes a vanilla conversation on the same thread.
  const sessionEngine: "claude_code_local" | "claude_code_local_vanilla" =
    vanilla ? "claude_code_local_vanilla" : "claude_code_local";
  const persistedSessionId = getExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: sessionEngine,
  });
  // Parity with createPiTools: node_repl carries the bounded deferred catalog;
  // profiles without it get the safe direct-schema fallback instead.
  const toolMetadata = vanilla
    ? []
    : getProviderToolMetadata({
        toolsAllowlist: args.opts.agentContext.toolsAllowlist,
        toolCatalog: args.opts.toolCatalog,
        connectorProvider: args.opts.connectorDeliveryTarget?.provider,
      });
  const claudeCodeModelId = getClaudeCodeAgentModelId(
    args.opts.stellaAppDir,
    args.opts.agentContext.model,
    args.opts.agentType,
    args.opts.agentContext.modelConfigSnapshot?.engine === "claude_code_local"
      ? args.opts.agentContext.modelConfigSnapshot.engineModel
      : vanilla
        ? spawnEngine?.model
        : undefined,
  );
  const emitToolUpdateStatus = (update: {
    result?: unknown;
    details?: unknown;
    error?: string;
  }) => {
    const details =
      update.details && typeof update.details === "object"
        ? (update.details as { statusText?: unknown })
        : null;
    const statusText =
      typeof details?.statusText === "string" && details.statusText.trim()
        ? details.statusText.trim()
        : buildToolResultText(update).trim();
    if (statusText) {
      args.callbacks?.onStatus?.(runEvents.recordStatus(statusText));
    }
  };
  // Buffers the assistant text Claude Code has streamed since the last
  // message boundary (mirrors runCodexHostedTurn.flushPreambleBeforeTool).
  // Claude Code CAN stream a natural-text preamble before a structured
  // tool-request step resolves; without a boundary event the next step's text
  // would append to the same overlay slot with no separator — visually fusing
  // the preamble's last word with the answer's first word — and the working
  // indicator would dismiss on the preamble across the preamble->tool gap.
  const assistantUpdateBuffer = createExternalAssistantUpdateBuffer({
    store: args.opts.store,
    threadKey,
    engine: "claude_code",
    runId,
    ...(typeof args.opts.agentContext.attemptGeneration === "number"
      ? { attemptGeneration: args.opts.agentContext.attemptGeneration }
      : {}),
  });
  const acceptClaudeStreamChunk = (chunk: string) => {
    assistantUpdateBuffer.append(chunk);
    args.callbacks?.onStream?.(runEvents.recordStream(chunk));
  };
  const flushPreambleBeforeTool = (toolArgs2: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => {
    const preamble = assistantUpdateBuffer.flushBeforeTool();
    if (!preamble) {
      return;
    }
    const preambleEvent = runEvents.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble,
        toolCallId: toolArgs2.toolCallId,
        toolName: toolArgs2.toolName,
        toolArgs: toolArgs2.toolArgs,
      }),
    );
    if (preambleEvent) {
      args.callbacks?.onAssistantMessage?.(preambleEvent);
    }
  };
  const executeClaudeTool = async (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => {
    // The Claude Code engine runs on Anthropic; tool-result screenshots get
    // Anthropic's high-resolution-tier caps (2576px long edge).
    const imageCapTarget: ImageCapTarget = { provider: "anthropic" };
    flushPreambleBeforeTool({ toolCallId, toolName, toolArgs });
    responseTargetTracker?.noteToolStart(toolName, toolArgs);
    const toolStartEvent = runEvents.recordToolStart({
      toolCallId,
      toolName,
      toolArgs,
    });
    args.callbacks?.onToolStart?.(toolStartEvent);
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: buildToolCallPayload({
        toolCallId,
        toolName,
        toolArgs: toolStartEvent.args,
      }),
    });
    const toolResult = await executeRuntimeToolCall({
      toolCallId,
      toolName,
      args: toolArgs,
      runId,
      rootRunId: args.opts.rootRunId ?? runId,
      agentId: args.opts.agentId,
      conversationId: args.opts.conversationId,
      agentType: args.opts.agentType,
      deviceId: args.opts.deviceId,
      stellaAppDir: args.opts.stellaAppDir,
      stellaDataDir: args.opts.stellaDataDir,
      toolWorkspaceRoot: args.opts.toolWorkspaceRoot,
      agentDepth: args.opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: args.opts.agentContext.maxAgentDepth,
      parentAgentId: args.opts.agentContext.parentAgentId,
      modelConfigSnapshot: args.opts.agentContext.modelConfigSnapshot,
      connectorDeliveryTarget: args.opts.connectorDeliveryTarget,
      allowedToolNames: widenAllowlistWithDemotedTools(
        args.opts.agentContext.toolsAllowlist,
        args.opts.toolCatalog,
        args.opts.connectorDeliveryTarget?.provider,
      ),
      deferImageDeliveryAck: toolName === "image_gen",
      store: args.opts.store,
      toolExecutor: args.opts.toolExecutor,
      hookEmitter: args.opts.hookEmitter,
      signal,
      onUpdate,
    });
    responseTargetTracker?.noteToolEnd(toolName, toolResult.details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId,
        toolName,
        result: toolResult,
        details: toolResult.details,
        isError: Boolean(toolResult.error),
      }),
    );
    const sanitizedToolResult = sanitizeSensitiveData(toolResult) as ToolResult;
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: await buildToolResultContent(
          sanitizedToolResult,
          imageCapTarget,
          {
            stellaDataDir: args.opts.stellaDataDir,
            runId,
            toolCallId,
          },
        ),
        isError: Boolean(toolResult.error),
        timestamp: now(),
      },
    });
    return toolResult;
  };

  const historyPromptMessage = buildExternalStellaHistoryPromptMessage({
    opts: args.opts,
    promptMessages: args.promptMessages,
  });
  const initialDeliveredEntryId = getExternalDeliveredEntryId({
    store: args.opts.store,
    threadKey,
    engine: sessionEngine,
  });
  const threadUpdatesDelta = buildExternalThreadUpdatesDelta({
    store: args.opts.store,
    threadKey,
    ...(initialDeliveredEntryId
      ? { afterEntryId: initialDeliveredEntryId }
      : {}),
    promptMessages: args.promptMessages,
    ...(!persistedSessionId && historyPromptMessage
      ? { deliveredContextTexts: [historyPromptMessage.text] }
      : {}),
  });
  const watermarkTracker = createExternalDeltaWatermarkTracker(
    initialDeliveredEntryId,
  );
  watermarkTracker.noteMainlineDelta(threadUpdatesDelta);
  const mainFallbackDelta =
    persistedSessionId && historyPromptMessage
      ? buildExternalThreadUpdatesDelta({
          store: args.opts.store,
          threadKey,
          ...(initialDeliveredEntryId
            ? { afterEntryId: initialDeliveredEntryId }
            : {}),
          promptMessages: args.promptMessages,
          deliveredContextTexts: [historyPromptMessage.text],
        })
      : null;
  if (mainFallbackDelta) {
    watermarkTracker.noteReseedDelta(mainFallbackDelta);
  }
  const { prompt, resumeFallbackPrompt } = buildClaudeCodeTurnPrompts({
    historyPromptMessage,
    promptMessages: args.promptMessages,
    hasPersistedSession: Boolean(persistedSessionId),
    deltaPromptMessage: threadUpdatesDelta.message,
    ...(mainFallbackDelta
      ? { fallbackDeltaPromptMessage: mainFallbackDelta.message }
      : {}),
  });
  const claudeCodeEffortLevel = getClaudeCodeRuntimeEffortLevel(
    args.opts.stellaAppDir,
    args.opts.agentContext.modelConfigSnapshot?.engine === "claude_code_local"
      ? (args.opts.agentContext.modelConfigSnapshot.reasoningEffort ??
          "default")
      : args.opts.agentContext.spawnReasoningEffort,
  );

  // Native-tool file writes (vanilla mode) accumulated across the main turn
  // and any queued follow-up turns, deduped by path + change kind.
  const collectedFileChanges: NonNullable<SubagentRunResult["fileChanges"]> =
    [];
  const collectedFileChangeKeys = new Set<string>();
  const collectTurnFileChanges = (
    fileChanges: SubagentRunResult["fileChanges"],
  ) => {
    for (const change of fileChanges ?? []) {
      const key = `${change.kind.type}:${change.path}:${change.kind.type === "update" ? (change.kind.move_path ?? "") : ""}`;
      if (collectedFileChangeKeys.has(key)) continue;
      collectedFileChangeKeys.add(key);
      collectedFileChanges.push(change);
    }
  };

  type ClaudeTurnResult = Awaited<ReturnType<typeof runClaudeCodeTurn>>;
  let finalResult: ClaudeTurnResult | null = null;
  let activeSessionId = persistedSessionId;
  let nextPrompt = prompt;
  let nextResumeFallbackPrompt = resumeFallbackPrompt;
  let nextAttachments = args.opts.attachments;

  let latestAttempt = true;
  for (;;) {
    let wasSteered = false;
    let nativeInterrupt: Promise<void> | null = null;
    let completedThisTurn = false;
    try {
      const result = await runClaudeCodeTurn({
        runId,
        sessionKey,
        ...(activeSessionId ? { persistedSessionId: activeSessionId } : {}),
        modelId: claudeCodeModelId,
        stellaAppDir: args.opts.stellaAppDir,
        ...(args.opts.cliBridgeSocketPath
          ? { cliBridgeSocketPath: args.opts.cliBridgeSocketPath }
          : {}),
        ...(vanilla ? { vanilla } : {}),
        ...(claudeCodeEffortLevel
          ? { effortLevel: claudeCodeEffortLevel }
          : {}),
        prompt: nextPrompt,
        ...(nextResumeFallbackPrompt
          ? { resumeFallbackPrompt: nextResumeFallbackPrompt }
          : {}),
        systemPrompt: args.systemPrompt,
        cwd: localCliCwd,
        attachments: nextAttachments,
        tools: toolMetadata,
        abortSignal: args.opts.abortSignal,
        onTurnControl: ({ interrupt }: { interrupt: () => Promise<void> }) =>
          args.liveAgent?.beginSteerableTurn(() => {
            if (wasSteered) return;
            wasSteered = true;
            // The message remains in the live queue. Claude Code's native
            // control protocol ends this query; the loop below then writes
            // that queued steering message to the same streaming session.
            nativeInterrupt = interrupt().catch(() => undefined);
          }),
        onSessionId: (sessionId: string) => {
          activeSessionId = sessionId;
        },
        onStatusChange: (status: {
          text: string;
          state?: RuntimeStatusEvent["statusState"];
        }) => {
          args.callbacks?.onStatus?.(
            runEvents.recordStatus(status.text, status.state),
          );
        },
        onStream: acceptClaudeStreamChunk,
        onToolUpdate: ({ update }: { update: ToolResult }) =>
          emitToolUpdateStatus(update),
        onToolResponseWritten: ({
          toolCallId,
          toolName,
        }: {
          toolCallId: string;
          toolName: string;
        }) => {
          if (toolName !== "image_gen") return;
          markImageOperationDelivered({
            stellaDataDir: args.opts.stellaDataDir ?? args.opts.stellaAppDir,
            conversationId: args.opts.conversationId,
            toolCallId,
          });
        },
        executeTool: executeClaudeTool,
      });
      assistantUpdateBuffer.discard();
      collectTurnFileChanges(result.fileChanges);
      activeSessionId = result.sessionId;
      finalResult = result;
      completedThisTurn = true;
    } catch (error) {
      if (wasSteered && !args.opts.abortSignal?.aborted) {
        // The partial reply belonged to the superseded instruction. The
        // queued steering message starts a new visible response boundary.
        if (error instanceof ClaudeCodeSteeringInterruptError) {
          // The interrupt error class lives in the untyped session runtime,
          // so `instanceof` cannot narrow the catch binding for TS.
          collectTurnFileChanges(
            (error as { fileChanges?: SubagentRunResult["fileChanges"] })
              .fileChanges,
          );
        }
        assistantUpdateBuffer.discard();
      } else {
        assistantUpdateBuffer.flushOnTermination();
        throw error;
      }
    }
    // Attach a rejection handler immediately above; do not delay the next
    // prompt on a stale/missing control acknowledgement. The queued message
    // remains a safe post-turn fallback if native interruption is unavailable.
    void nativeInterrupt;

    if (completedThisTurn && finalResult) {
      // Persist this turn's reply before draining follow-ups so a stale
      // retry attempt can never clobber a newer attempt's transcript.
      latestAttempt = await persistCompletedExternalReply({
        opts: args.opts,
        session: args.session,
        callbacks: args.callbacks,
        text: finalResult.text,
      });
      if (!latestAttempt) {
        args.liveAgent?.finish();
        break;
      }
    }

    const queued = args.liveAgent?.drain() ?? [];
    if (queued.length === 0) {
      if (completedThisTurn && finalResult) {
        // Close the live facade synchronously before any later awaits. The
        // atomic drained-and-idle check routes a message arriving after this
        // point into a fresh turn instead of queueing it onto a turn that can
        // no longer drain.
        if (!args.liveAgent || args.liveAgent.finishIfIdle()) break;
        continue;
      }
      throw new Error("External engine steering message was lost.");
    }
    publishQueuedUserMessageStarts({
      entries: queued,
      runEvents,
      callbacks: args.callbacks,
    });
    const queuedPromptMessages = queued.map(formatQueuedClaudeMessage);
    const queuedAttachments = attachmentsFromQueuedMessages(queued);
    const queuedHistoryPromptMessage = buildExternalStellaHistoryPromptMessage({
      opts: args.opts,
      promptMessages: queuedPromptMessages,
    });
    const queuedThreadUpdatesDelta = buildExternalThreadUpdatesDelta({
      store: args.opts.store,
      threadKey,
      ...(watermarkTracker.cursor
        ? { afterEntryId: watermarkTracker.cursor }
        : {}),
      promptMessages: queuedPromptMessages,
    });
    const queuedFallbackDelta = buildExternalThreadUpdatesDelta({
      store: args.opts.store,
      threadKey,
      ...(initialDeliveredEntryId
        ? { afterEntryId: initialDeliveredEntryId }
        : {}),
      promptMessages: queuedPromptMessages,
      ...(queuedHistoryPromptMessage
        ? { deliveredContextTexts: [queuedHistoryPromptMessage.text] }
        : {}),
    });
    watermarkTracker.noteMainlineDelta(queuedThreadUpdatesDelta);
    watermarkTracker.noteReseedDelta(queuedFallbackDelta);
    // A queued steer or follow-up continues the same external conversation.
    // If the turn was interrupted before Claude emitted a session id, the
    // fallback prompt safely reseeds from Stella's durable history.
    const {
      prompt: queuedPrompt,
      resumeFallbackPrompt: queuedResumeFallbackPrompt,
    } = buildClaudeCodeTurnPrompts({
      historyPromptMessage: queuedHistoryPromptMessage,
      promptMessages: queuedPromptMessages,
      hasPersistedSession: Boolean(activeSessionId),
      deltaPromptMessage: queuedThreadUpdatesDelta.message,
      fallbackDeltaPromptMessage: queuedFallbackDelta.message,
    });
    nextPrompt = queuedPrompt;
    nextResumeFallbackPrompt = queuedResumeFallbackPrompt;
    nextAttachments = queuedAttachments;
  }

  if (!finalResult) {
    throw new Error("Claude Code completed without a final result.");
  }
  if (latestAttempt && isLatestExternalAttempt(args.opts)) {
    setExternalEngineSessionId({
      store: args.opts.store,
      threadKey,
      engine: sessionEngine,
      sessionId: finalResult.sessionId,
    });
    const resolvedWatermark = watermarkTracker.resolve();
    if (resolvedWatermark && resolvedWatermark !== initialDeliveredEntryId) {
      setExternalDeliveredEntryId({
        store: args.opts.store,
        threadKey,
        engine: sessionEngine,
        entryId: resolvedWatermark,
      });
    }
  }

  return {
    finalText: finalResult.text,
    sessionId: finalResult.sessionId,
    latestAttempt,
    ...(collectedFileChanges.length > 0
      ? { fileChanges: collectedFileChanges }
      : {}),
  };
};

const runCodexHostedTurn = async (args: {
  opts: BaseRunOptions & { onProgress?: (chunk: string) => void };
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
  liveAgent?: ReturnType<typeof createExternalLiveAgent>;
}): Promise<{
  finalText: string;
  sessionId: string;
  latestAttempt: boolean;
  fileChanges?: SubagentRunResult["fileChanges"];
}> => {
  const { runId, threadKey, runEvents } = args.session;
  const responseTargetTracker =
    args.session.kind === "orchestrator"
      ? args.session.responseTargetTracker
      : undefined;

  runEvents.recordRunStart();
  persistExternalPromptMessages(args.opts, threadKey, args.promptMessages);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveAgentWorkingDirectory({
    agentType: args.opts.agentType,
    stellaAppDir: args.opts.stellaAppDir,
    workingDirectory: args.opts.toolWorkspaceRoot,
  });
  const sessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${runId}`;
  const persistedSessionId = getExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: "codex_cli",
  });
  const imageToolMetadata = getRuntimeToolMetadata({
    toolsAllowlist: args.opts.agentContext.toolsAllowlist,
    toolCatalog: args.opts.toolCatalog,
  }).filter((tool) => tool.name === "image_gen");
  const persistCodexSessionId = (sessionId: string) => {
    if (!isLatestExternalAttempt(args.opts)) return;
    setExternalEngineSessionId({
      store: args.opts.store,
      threadKey,
      engine: "codex_cli",
      sessionId,
    });
  };
  const emitToolUpdateStatus = (update: ToolResult) => {
    const details =
      update.details && typeof update.details === "object"
        ? (update.details as { statusText?: unknown })
        : null;
    const statusText =
      typeof details?.statusText === "string" && details.statusText.trim()
        ? details.statusText.trim()
        : buildToolResultText(update).trim();
    if (statusText) {
      args.callbacks?.onStatus?.(runEvents.recordStatus(statusText));
    }
  };
  // Buffers the assistant text Codex has streamed since the last message
  // boundary. When a tool call starts we flush it as an interim, tool-call-
  // bearing message (see `flushPreambleBeforeTool`) so the working indicator
  // does not dismiss on the preamble across the gap before the tool starts.
  const assistantUpdateBuffer = createExternalAssistantUpdateBuffer({
    store: args.opts.store,
    threadKey,
    engine: "codex",
    runId,
    ...(typeof args.opts.agentContext.attemptGeneration === "number"
      ? { attemptGeneration: args.opts.agentContext.attemptGeneration }
      : {}),
  });
  const flushPreambleBeforeTool = (args2: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => {
    const preamble = assistantUpdateBuffer.flushBeforeTool();
    if (!preamble) {
      return;
    }
    const preambleEvent = runEvents.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble,
        toolCallId: args2.toolCallId,
        toolName: args2.toolName,
        toolArgs: args2.toolArgs,
      }),
    );
    if (preambleEvent) {
      args.callbacks?.onAssistantMessage?.(preambleEvent);
    }
  };
  const executeCodexTool = async (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => {
    // The Codex engine runs on OpenAI; tool-result screenshots get OpenAI's
    // image caps (2048px long edge for high detail).
    const imageCapTarget: ImageCapTarget = { provider: "openai" };
    flushPreambleBeforeTool({ toolCallId, toolName, toolArgs });
    responseTargetTracker?.noteToolStart(toolName, toolArgs);
    const toolStartEvent = runEvents.recordToolStart({
      toolCallId,
      toolName,
      toolArgs,
    });
    args.callbacks?.onToolStart?.(toolStartEvent);
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: buildToolCallPayload({
        toolCallId,
        toolName,
        toolArgs: toolStartEvent.args,
      }),
    });
    const toolResult = await executeRuntimeToolCall({
      toolCallId,
      toolName,
      args: toolArgs,
      runId,
      rootRunId: args.opts.rootRunId ?? runId,
      agentId: args.opts.agentId,
      conversationId: args.opts.conversationId,
      agentType: args.opts.agentType,
      deviceId: args.opts.deviceId,
      stellaAppDir: args.opts.stellaAppDir,
      stellaDataDir: args.opts.stellaDataDir,
      toolWorkspaceRoot: args.opts.toolWorkspaceRoot,
      agentDepth: args.opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: args.opts.agentContext.maxAgentDepth,
      parentAgentId: args.opts.agentContext.parentAgentId,
      modelConfigSnapshot: args.opts.agentContext.modelConfigSnapshot,
      connectorDeliveryTarget: args.opts.connectorDeliveryTarget,
      allowedToolNames: widenAllowlistWithDemotedTools(
        args.opts.agentContext.toolsAllowlist,
        args.opts.toolCatalog,
        args.opts.connectorDeliveryTarget?.provider,
      ),
      deferImageDeliveryAck: toolName === "image_gen",
      store: args.opts.store,
      toolExecutor: args.opts.toolExecutor,
      hookEmitter: args.opts.hookEmitter,
      signal,
      onUpdate,
    });
    responseTargetTracker?.noteToolEnd(toolName, toolResult.details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId,
        toolName,
        result: toolResult,
        details: toolResult.details,
        isError: Boolean(toolResult.error),
      }),
    );
    const sanitizedToolResult = sanitizeSensitiveData(toolResult) as ToolResult;
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: await buildToolResultContent(
          sanitizedToolResult,
          imageCapTarget,
          {
            stellaDataDir: args.opts.stellaDataDir,
            runId,
            toolCallId,
          },
        ),
        isError: Boolean(toolResult.error),
        timestamp: now(),
      },
    });
    return toolResult;
  };
  const emitCodexCommandExecution = (
    activity: CodexCommandExecutionActivity,
  ) => {
    const toolName = "exec_command";
    const toolArgs = {
      command: activity.command,
      ...(activity.cwd ? { cwd: activity.cwd } : {}),
      state: activity.status,
    };
    if (activity.status === "inProgress") {
      flushPreambleBeforeTool({
        toolCallId: activity.id,
        toolName,
        toolArgs,
      });
      responseTargetTracker?.noteToolStart(toolName, toolArgs);
      args.callbacks?.onToolStart?.(
        runEvents.recordToolStart({
          toolCallId: activity.id,
          toolName,
          statusText: "Running command",
          toolArgs,
        }),
      );
      return;
    }
    const details = {
      ...toolArgs,
      ...(activity.exitCode !== undefined
        ? { exitCode: activity.exitCode }
        : {}),
      codexBuiltinCommandExecution: true,
    };
    responseTargetTracker?.noteToolEnd(toolName, details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId: activity.id,
        toolName,
        result: {
          state: activity.status,
          ...(activity.exitCode !== undefined
            ? { exitCode: activity.exitCode }
            : {}),
        },
        details,
        isError:
          activity.status === "failed" ||
          (activity.exitCode !== undefined && activity.exitCode !== 0),
      }),
    );
  };
  const initialDeliveredEntryId = getExternalDeliveredEntryId({
    store: args.opts.store,
    threadKey,
    engine: "codex_cli",
  });
  const threadUpdatesDelta = buildExternalThreadUpdatesDelta({
    store: args.opts.store,
    threadKey,
    ...(initialDeliveredEntryId
      ? { afterEntryId: initialDeliveredEntryId }
      : {}),
    promptMessages: args.promptMessages,
  });
  let deliveredEntryWatermark =
    threadUpdatesDelta.lastEntryId ?? initialDeliveredEntryId;
  const prompt = buildCodexPromptFromMessages({
    promptMessages: threadUpdatesDelta.message
      ? [threadUpdatesDelta.message, ...args.promptMessages]
      : args.promptMessages,
  });
  const inheritedCodexConfig =
    args.opts.agentContext.modelConfigSnapshot?.engine === "codex_cli"
      ? args.opts.agentContext.modelConfigSnapshot
      : undefined;
  const codexModelOverride =
    inheritedCodexConfig?.engineModel ??
    (args.opts.agentContext.spawnEngine?.engine === "codex_cli"
      ? args.opts.agentContext.spawnEngine.model
      : undefined);
  const codexReasoningEffort =
    inheritedCodexConfig?.reasoningEffort ??
    args.opts.agentContext.spawnReasoningEffort;
  const codexServiceTier = inheritedCodexConfig?.serviceTier;
  type CodexTurnResult = Awaited<ReturnType<typeof runCodexAgentTurn>>;
  let finalResult: CodexTurnResult | null = null;
  let activeSessionId = persistedSessionId;
  let nextPrompt = prompt;
  let nextAttachments = args.opts.attachments;

  let latestAttempt = true;
  for (;;) {
    let nativeSteerDispatch = Promise.resolve();
    let completedThisTurn = false;
    try {
      const result = await runCodexAgentTurn({
        runId,
        sessionKey,
        ...(activeSessionId ? { persistedSessionId: activeSessionId } : {}),
        prompt: nextPrompt,
        systemPrompt: args.systemPrompt,
        // Scope this durability change to image_gen. Codex persists dynamic
        // tool definitions on the engine thread, including across resume.
        tools: imageToolMetadata,
        cwd: localCliCwd,
        stellaDataDir: args.opts.stellaDataDir,
        stellaAppDir: args.opts.stellaAppDir,
        ...(args.opts.cliBridgeSocketPath
          ? { cliBridgeSocketPath: args.opts.cliBridgeSocketPath }
          : {}),
        stellaModel: args.opts.agentContext.model,
        ...(codexModelOverride ? { modelOverride: codexModelOverride } : {}),
        ...(codexReasoningEffort
          ? {
              reasoningEffort: codexReasoningEffort,
              ...(inheritedCodexConfig
                ? { reasoningEffortResolved: true }
                : {}),
            }
          : {}),
        ...(codexServiceTier ? { serviceTier: codexServiceTier } : {}),
        attachments: nextAttachments,
        abortSignal: args.opts.abortSignal,
        onTurnControl: ({
          steer,
        }: {
          steer: (input: {
            prompt: string;
            attachments?: RuntimeAttachmentRef[];
          }) => Promise<void>;
        }) =>
          args.liveAgent?.beginSteerableTurn(() => {
            nativeSteerDispatch = nativeSteerDispatch.then(async () => {
              const entries = args.liveAgent?.drainSteering() ?? [];
              if (entries.length === 0) return;
              const promptMessages = entries.map(formatQueuedClaudeMessage);
              try {
                await steer({
                  prompt: buildCodexPromptFromMessages({ promptMessages }),
                  attachments: attachmentsFromQueuedMessages(entries),
                });
                // Codex consumed these entries inside the current turn, so
                // advance callback ownership/user attribution immediately.
                // Waiting for turn completion would misattribute the reply to
                // the hidden lifecycle message that preceded this steer.
                publishQueuedUserMessageStarts({
                  entries,
                  runEvents,
                  callbacks: args.callbacks,
                });
              } catch {
                // The turn may have completed between notification and the
                // app-server request. Preserve exact ordering and fall back to
                // a normal next turn rather than losing the steering input.
                args.liveAgent?.prepend(entries);
              }
            });
          }),
        onStatus: (status) => {
          args.opts.onProgress?.(status);
          args.callbacks?.onStatus?.(runEvents.recordStatus(status));
        },
        onReasoning: (chunk) => {
          args.callbacks?.onReasoning?.(runEvents.recordReasoning(chunk));
        },
        onCommandExecution: emitCodexCommandExecution,
        onStream: (chunk) => {
          assistantUpdateBuffer.append(chunk);
          args.opts.onProgress?.(chunk);
          args.callbacks?.onStream?.(runEvents.recordStream(chunk));
        },
        onSessionId: (sessionId) => {
          activeSessionId = sessionId;
          persistCodexSessionId(sessionId);
        },
        onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
        onToolResponseWritten: ({ toolCallId, toolName }) => {
          if (toolName !== "image_gen") return;
          markImageOperationDelivered({
            stellaDataDir: args.opts.stellaDataDir ?? args.opts.stellaAppDir,
            conversationId: args.opts.conversationId,
            toolCallId,
          });
        },
        executeTool: executeCodexTool,
        reuseAppServer: true,
        streamFinalAnswer: args.session.kind === "orchestrator",
      });
      assistantUpdateBuffer.discard();
      activeSessionId = result.sessionId;
      finalResult = result;
      completedThisTurn = true;
    } catch (error) {
      assistantUpdateBuffer.flushOnTermination();
      throw error;
    }
    await nativeSteerDispatch;

    if (completedThisTurn && finalResult) {
      // Persist this turn's reply before draining follow-ups so a stale
      // retry attempt can never clobber a newer attempt's transcript.
      latestAttempt = await persistCompletedExternalReply({
        opts: args.opts,
        session: args.session,
        callbacks: args.callbacks,
        text: finalResult.text,
      });
      if (!latestAttempt) {
        args.liveAgent?.finish();
        break;
      }
    }

    const queued = args.liveAgent?.drain() ?? [];
    if (queued.length === 0) {
      if (completedThisTurn && finalResult) {
        // Atomically make late input ineligible for this completed engine
        // turn before yielding back to the event loop.
        if (!args.liveAgent || args.liveAgent.finishIfIdle()) break;
        continue;
      }
      throw new Error("External engine steering message was lost.");
    }
    publishQueuedUserMessageStarts({
      entries: queued,
      runEvents,
      callbacks: args.callbacks,
    });
    const queuedPromptMessages = queued.map(formatQueuedClaudeMessage);
    const queuedAttachments = attachmentsFromQueuedMessages(queued);
    const queuedThreadUpdatesDelta = buildExternalThreadUpdatesDelta({
      store: args.opts.store,
      threadKey,
      ...(initialDeliveredEntryId
        ? { afterEntryId: initialDeliveredEntryId }
        : {}),
      promptMessages: queuedPromptMessages,
    });
    deliveredEntryWatermark =
      queuedThreadUpdatesDelta.lastEntryId ?? deliveredEntryWatermark;
    nextPrompt = buildCodexPromptFromMessages({
      promptMessages: queuedThreadUpdatesDelta.message
        ? [queuedThreadUpdatesDelta.message, ...queuedPromptMessages]
        : queuedPromptMessages,
    });
    nextAttachments = queuedAttachments;
  }

  if (!finalResult) {
    throw new Error("Codex completed without a final result.");
  }
  if (latestAttempt && isLatestExternalAttempt(args.opts)) {
    persistCodexSessionId(finalResult.sessionId);
    if (
      deliveredEntryWatermark &&
      deliveredEntryWatermark !== initialDeliveredEntryId
    ) {
      setExternalDeliveredEntryId({
        store: args.opts.store,
        threadKey,
        engine: "codex_cli",
        entryId: deliveredEntryWatermark,
      });
    }
  }

  return {
    finalText: finalResult.text,
    sessionId: finalResult.sessionId,
    latestAttempt,
    ...(finalResult.fileChanges?.length
      ? { fileChanges: finalResult.fileChanges }
      : {}),
  };
};

export const runExternalOrchestratorTurn = async (
  opts: OrchestratorRunOptions,
): Promise<string | null> => {
  const engine = selectExternalOrchestratorEngine(opts);
  if (!engine) {
    return null;
  }

  const session = createExternalOrchestratorRunSession(opts, {
    runId: opts.runId ?? `local:${crypto.randomUUID()}`,
  });
  const liveAgent = createExternalLiveAgent();

  try {
    // Thread `session.runId` into the prompt build so lifecycle hooks receive
    // the same run identity as the native engine path.
    const systemPrompt = await buildRuntimeSystemPrompt({
      ...opts,
      runId: session.runId,
    });
    const promptMessages = await buildOrchestratorPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
      agentType: opts.agentType,
      hookContext: {
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        conversationId: opts.conversationId,
        threadKey: session.threadKey,
        runId: session.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      },
    });
    opts.onExecutionSessionCreated?.({
      runId: session.runId,
      threadKey: session.threadKey,
      engine: "external",
      queueUserMessageId: session.runEvents.queueUserMessageId,
      agent: liveAgent.agent,
    });
    // The engine turn supervises as a child resource of the run's scope:
    // fiber interruption drives the runtime's abort teardown (MCP reset +
    // kill ladder) through the relay signal, and cancel joins the turn's
    // settlement, bounded past the kill ladder.
    const result = await superviseExternalEngineTurn({
      supervise: opts.superviseRunResource,
      engine: "claude-code",
      runId: session.runId,
      signal: opts.abortSignal,
      run: (signal) =>
        runClaudeHostedTurn({
          opts:
            signal && signal !== opts.abortSignal
              ? { ...opts, abortSignal: signal }
              : opts,
          session,
          systemPrompt,
          promptMessages,
          callbacks: opts.callbacks,
          liveAgent,
        }),
    });
    return await session.finalizeSuccess(result.finalText);
  } catch (error) {
    const interruptedReason = resolveInterruptionReason({
      abortSignal: opts.abortSignal,
      error,
    });
    if (interruptedReason) {
      return session.finalizeInterrupted(interruptedReason);
    }
    session.finalizeError(error);
    throw markOrchestratorErrorReported(error);
  } finally {
    liveAgent.finish();
    // The external engine persisted this turn's user + assistant messages to
    // the shared durable thread but ran entirely outside the held-over Pi
    // `OrchestratorSession`, so that session's in-memory `state.messages`
    // still reflects only its own prior turns. Flag it for a history refresh
    // so a later default-engine turn on this conversation re-syncs from the
    // store instead of prompting with stale context that omits these Claude
    // Code turns. Mirrors how realtime voice — another out-of-band writer to
    // the same thread — calls `notifyHistoryChanged()`. No-op when no live Pi
    // agent exists yet (it seeds fresh from the store on first construction).
    opts.orchestratorSession?.notifyHistoryChanged();
  }
};

export const runExternalSubagentTurn = async (
  opts: SubagentRunOptions,
): Promise<SubagentRunResult | null> => {
  if (!shouldUseClaudeCodeRuntime(opts)) {
    const useCodex =
      !usesManagedSubscriptionHarness(opts.agentContext.modelConfigSnapshot) &&
      shouldUseCodexAgentRuntime({
        agentType: opts.agentType,
        agentEngine: opts.agentContext.agentEngine,
      });
    if (!useCodex) {
      return null;
    }

    const session = createExternalSubagentRunSession(opts, {
      runId: opts.runId ?? `local:sub:${crypto.randomUUID()}`,
    });
    const liveAgent = createExternalLiveAgent();
    const detachLiveAgent = opts.subagentSession?.attachExternalLiveAgent?.(
      liveAgent.agent,
      {
        store: opts.store,
        runId: session.runId,
        ...(typeof opts.agentContext.attemptGeneration === "number"
          ? { attemptGeneration: opts.agentContext.attemptGeneration }
          : {}),
      },
    );

    try {
      const promptMessages = await buildSubagentPromptMessages({
        context: opts.agentContext,
        userPrompt: opts.userPrompt,
        promptMessages: opts.promptMessages,
        stellaDataDir: opts.stellaDataDir,
        stellaAppDir: opts.stellaAppDir,
        agentType: opts.agentType,
        hookContext: {
          ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
          conversationId: opts.conversationId,
          threadKey: session.threadKey,
          runId: session.runId,
          ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        },
      });
      const systemPrompt = await buildSubagentSystemPrompt({
        ...opts,
        runId: session.runId,
      });
      // The engine turn supervises as a child resource of the run's scope:
      // fiber interruption drives the runtime's abort teardown through the
      // relay signal, and cancel joins the turn's settlement.
      const result = await superviseExternalEngineTurn({
        supervise: opts.superviseRunResource,
        engine: "codex",
        runId: session.runId,
        signal: opts.abortSignal,
        run: (signal) =>
          runCodexHostedTurn({
            opts:
              signal && signal !== opts.abortSignal
                ? { ...opts, abortSignal: signal }
                : opts,
            session,
            systemPrompt,
            promptMessages,
            callbacks: opts.callbacks,
            liveAgent,
          }),
      });
      if (!result.latestAttempt) {
        return { runId: session.runId, result: "", interrupted: true };
      }
      const finalized = await session.finalizeSuccess(result.finalText);
      if (result.fileChanges?.length) {
        finalized.fileChanges = result.fileChanges;
      }
      return finalized;
    } catch (error) {
      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error,
      });
      if (interruptedReason) {
        return session.finalizeInterrupted(interruptedReason);
      }
      return session.finalizeError(error);
    } finally {
      detachLiveAgent?.();
      liveAgent.finish();
    }
  }

  const session = createExternalSubagentRunSession(opts, {
    runId: opts.runId ?? `local:sub:${crypto.randomUUID()}`,
  });
  const liveAgent = createExternalLiveAgent();
  const detachLiveAgent = opts.subagentSession?.attachExternalLiveAgent?.(
    liveAgent.agent,
    {
      store: opts.store,
      runId: session.runId,
      ...(typeof opts.agentContext.attemptGeneration === "number"
        ? { attemptGeneration: opts.agentContext.attemptGeneration }
        : {}),
    },
  );

  try {
    const promptMessages = await buildSubagentPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
      agentType: opts.agentType,
      hookContext: {
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        conversationId: opts.conversationId,
        threadKey: session.threadKey,
        runId: session.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      },
    });
    // Thread session.runId so subagent hooks receive stable run identity.
    const systemPrompt = await buildSubagentSystemPrompt({
      ...opts,
      runId: session.runId,
    });
    // The engine turn supervises as a child resource of the run's scope:
    // fiber interruption drives the runtime's abort teardown (MCP reset +
    // kill ladder) through the relay signal, and cancel joins the turn's
    // settlement, bounded past the kill ladder.
    const result = await superviseExternalEngineTurn({
      supervise: opts.superviseRunResource,
      engine: "claude-code",
      runId: session.runId,
      signal: opts.abortSignal,
      run: (signal) =>
        runClaudeHostedTurn({
          opts:
            signal && signal !== opts.abortSignal
              ? { ...opts, abortSignal: signal }
              : opts,
          session,
          systemPrompt,
          promptMessages,
          callbacks: opts.callbacks,
          liveAgent,
        }),
    });
    if (!result.latestAttempt) {
      return { runId: session.runId, result: "", interrupted: true };
    }
    const finalized = await session.finalizeSuccess(result.finalText);
    // Vanilla-mode Claude Code executes its own file tools, so no Stella
    // tool-end events carry these writes — surface them on the run result
    // (same contract as the Codex branch above) so the agent-completed
    // rollup and the chat finish card get the produced artifacts.
    if (result.fileChanges?.length) {
      finalized.fileChanges = result.fileChanges;
    }
    return finalized;
  } catch (error) {
    const interruptedReason = resolveInterruptionReason({
      abortSignal: opts.abortSignal,
      error,
    });
    if (interruptedReason) {
      return session.finalizeInterrupted(interruptedReason);
    }
    return session.finalizeError(error);
  } finally {
    detachLiveAgent?.();
    liveAgent.finish();
  }
};

export const shutdownExternalEngineIntegrations = (): void => {
  shutdownClaudeCodeRuntime();
  shutdownCodexAppServerRuntime();
};
