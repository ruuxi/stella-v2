/**
 * How the orchestrator's conversation compacts, on every host. The desktop
 * thread runtime and the cloud orchestrator both use this module: when to
 * compact, where to cut, what the summarizer is asked, and what survives the
 * checkpoint verbatim. Each host only loads its messages, calls its own
 * model, and stores the result.
 *
 * Pure; no I/O.
 */

import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "../../ai/types.js";
import { estimateModelVisibleImageTokens } from "./image-tokens.js";

/** Tokens held back from the window for the summary request's own output. */
export const COMPACTION_RESERVE_TOKENS = 49_152;
/** Fraction of the model's window at which the conversation compacts. */
const TRIGGER_PCT = 0.5;
const KEEP_RECENT_TOKENS = 20_000;
/**
 * Fraction of the model's window the kept tail may occupy. Bounds the fixed
 * keep-recent budget on small-window models so a compaction always frees
 * enough room for the retry to fit.
 */
const KEEP_RECENT_WINDOW_PCT = 0.1;
export const MIN_TAIL_MESSAGES = 2;
/**
 * Char cap for the pinned copy of the latest user instruction carried
 * verbatim across a checkpoint (~3-4k tokens). The pin never moves the cut;
 * its cost is exactly one capped message.
 */
const PINNED_INSTRUCTION_MAX_CHARS = 12_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const MIN_TRIGGER_TOKENS = 8_000;
const MAX_BLOCK_CHARS = 100_000;
const TOOL_RESULT_MAX_CHARS = 2_000;

export const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";

/** The checkpoint message that stands in for a summarized span. */
export const formatCheckpointText = (summary: string): string =>
  [THREAD_CHECKPOINT_MARKER, "", summary.trim()].join("\n");

export const contextWindowTokens = (value: unknown): number => {
  const window = Number(value);
  return Number.isFinite(window) && window > 0
    ? Math.floor(window)
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
};

/** The request size, in tokens, at which the orchestrator compacts. */
export const orchestratorCompactionTriggerTokens = (window: number): number =>
  Math.max(MIN_TRIGGER_TOKENS, Math.floor(window * TRIGGER_PCT));

/** How much recent conversation stays verbatim after a compaction. */
export const orchestratorKeepRecentTokens = (window: number): number =>
  Math.min(KEEP_RECENT_TOKENS, Math.floor(window * KEEP_RECENT_WINDOW_PCT));

export const truncateForSummary = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n\n[... ${value.length - maxChars} more characters truncated]`;

export const ellipsize = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length <= MAX_BLOCK_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_BLOCK_CHARS)}...(truncated)`;
};

/** A conversation message as both hosts store it. */
export type CompactionPayload =
  | UserMessage
  | Pick<AssistantMessage, "role" | "content" | "stopReason">
  | Pick<ToolResultMessage, "role" | "content" | "toolCallId">;

const textTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

export const estimatePayloadTokens = (payload: CompactionPayload): number => {
  const content = payload.content;
  if (typeof content === "string") return textTokens(content);
  let tokens = 0;
  for (const block of content as ReadonlyArray<
    TextContent | ThinkingContent | ImageContent | ToolCall
  >) {
    if (block.type === "text") tokens += textTokens(block.text);
    else if (block.type === "thinking") tokens += textTokens(block.thinking);
    else if (block.type === "image")
      tokens += estimateModelVisibleImageTokens(block);
    else
      tokens += textTokens(
        `${block.name}${JSON.stringify(block.arguments ?? {})}`,
      );
  }
  return tokens;
};

const blockText = (block: {
  type: string;
  text?: string;
  mimeType?: string;
  sourcePath?: string;
}): string =>
  block.type === "text"
    ? (block.text ?? "")
    : `[Image receipt: ${block.mimeType}${block.sourcePath ? ` path=${block.sourcePath}` : ""}]`;

/**
 * The summarizer's view of one message: labelled lines, with failed or empty
 * assistant turns left out and tool results capped.
 */
export const summaryLinesForPayload = (payload: CompactionPayload): string[] => {
  if (payload.role === "user") {
    const content =
      typeof payload.content === "string"
        ? payload.content
        : payload.content.map(blockText).join("\n");
    return content.trim() ? [`[User] ${ellipsize(content)}`] : [];
  }
  if (payload.role === "assistant") {
    if (
      payload.stopReason === "error" ||
      payload.stopReason === "aborted" ||
      !payload.content.some(
        (block) =>
          block.type === "toolCall" ||
          (block.type === "text" && block.text.trim().length > 0),
      )
    ) {
      return [];
    }
    const text: string[] = [];
    const thinking: string[] = [];
    const calls: string[] = [];
    for (const block of payload.content) {
      if (block.type === "text") {
        if (block.text.trim()) text.push(block.text);
      } else if (block.type === "thinking") {
        if (block.thinking.trim()) thinking.push(block.thinking);
      } else {
        calls.push(
          `${block.name}(${Object.entries(block.arguments ?? {})
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join(", ")})`,
        );
      }
    }
    return [
      ...(thinking.length > 0
        ? [`[Assistant thinking] ${thinking.join("\n")}`]
        : []),
      ...(text.length > 0 ? [`[Assistant] ${text.join("\n")}`] : []),
      ...(calls.length > 0 ? [`[Assistant tool calls] ${calls.join("; ")}`] : []),
    ];
  }
  const content = payload.content.map(blockText).join("\n").trim();
  return content
    ? [`[Tool result] ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`]
    : [];
};

/** What the cut planner needs to know about one message. */
export type CompactionMessageView = {
  role: string;
  /** Tool call ids an assistant message makes. */
  toolCallIds: readonly string[];
  /** The call a tool result answers. */
  toolResultId?: string;
  tokens: number;
};

export const compactionViewForPayload = (
  payload: CompactionPayload,
): CompactionMessageView => ({
  role: payload.role,
  toolCallIds:
    payload.role === "assistant"
      ? payload.content.flatMap((block) =>
          block.type === "toolCall" && typeof block.id === "string"
            ? [block.id]
            : [],
        )
      : [],
  ...(payload.role === "toolResult" && payload.toolCallId.trim()
    ? { toolResultId: payload.toolCallId.trim() }
    : {}),
  tokens: estimatePayloadTokens(payload),
});

/**
 * The assistant tool-call group a message belongs to: the assistant message
 * and everything up to its last result. Live steering and runtime notices can
 * land between a call and its result, so only a newer assistant message ends
 * the group.
 */
const containingToolCallGroup = (
  messages: readonly CompactionMessageView[],
  messageIndex: number,
): { startIndex: number; endIndex: number } | null => {
  for (let startIndex = messageIndex; startIndex >= 0; startIndex -= 1) {
    const assistant = messages[startIndex];
    if (!assistant) return null;
    if (assistant.role !== "assistant") continue;
    if (assistant.toolCallIds.length === 0) return null;
    const callIds = new Set(assistant.toolCallIds);
    const matched = new Set<string>();
    let endIndex = startIndex;
    for (let index = startIndex + 1; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.role === "assistant") break;
      endIndex = index;
      if (message.toolResultId && callIds.has(message.toolResultId)) {
        matched.add(message.toolResultId);
        if (matched.size === callIds.size) break;
      }
    }
    return messageIndex <= endIndex ? { startIndex, endIndex } : null;
  }
  return null;
};

/** Move a cut forward past the tool-call group it would split. */
export const alignCutForward = (
  messages: readonly CompactionMessageView[],
  index: number,
): number => {
  if (index <= 0 || index >= messages.length) return index;
  const group = containingToolCallGroup(messages, index);
  return group && index > group.startIndex ? group.endIndex + 1 : index;
};

/** Move a cut back to the start of the tool-call group it would split. */
export const alignCutBackward = (
  messages: readonly CompactionMessageView[],
  index: number,
): number => {
  if (index <= 0 || index >= messages.length) return index;
  const group = containingToolCallGroup(messages, index);
  return group && index > group.startIndex ? group.startIndex : index;
};

/** Where the verbatim tail starts: the newest messages within the budget. */
export const tailStartByTokenBudget = (
  messages: readonly CompactionMessageView[],
  headEnd: number,
  keepRecentTokens: number,
  minTailMessages = MIN_TAIL_MESSAGES,
): number => {
  let accumulated = 0;
  let tailStart = messages.length;
  for (let index = messages.length - 1; index >= headEnd; index -= 1) {
    const tokens = messages[index]!.tokens;
    if (accumulated + tokens > keepRecentTokens && tailStart < messages.length)
      break;
    accumulated += tokens;
    tailStart = index;
  }
  const minCut = messages.length - minTailMessages;
  return alignCutBackward(
    messages,
    minCut >= headEnd ? Math.min(tailStart, minCut) : tailStart,
  );
};

/**
 * The span to summarize: messages `[start, tailStart)`. The latest user
 * message is reported when it falls inside that span, so the host can pin a
 * capped verbatim copy after the checkpoint; the cut never moves for it.
 */
export const planOrchestratorCompaction = (args: {
  messages: readonly CompactionMessageView[];
  /** Leading messages that never compact (pinned resident blocks). */
  protectHead: number;
  keepRecentTokens: number;
  minTailMessages?: number;
}): { start: number; tailStart: number; latestUserIndex?: number } | null => {
  const { messages } = args;
  const minTail = args.minTailMessages ?? MIN_TAIL_MESSAGES;
  if (messages.length <= args.protectHead + minTail) return null;
  const start = alignCutForward(
    messages,
    Math.min(args.protectHead, messages.length),
  );
  const tailStart = tailStartByTokenBudget(
    messages,
    start,
    args.keepRecentTokens,
    minTail,
  );
  if (tailStart <= start) return null;
  let latestUserIndex: number | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role !== "user") continue;
    if (index >= start && index < tailStart) latestUserIndex = index;
    break;
  }
  return {
    start,
    tailStart,
    ...(latestUserIndex !== undefined ? { latestUserIndex } : {}),
  };
};

/** The capped verbatim copy of the latest instruction kept after a checkpoint. */
export const pinnedInstructionText = (text: string): string =>
  truncateForSummary(text.trim(), PINNED_INSTRUCTION_MAX_CHARS);

/**
 * Retry backoff for the summary request. Compaction runs at the moment of
 * heaviest provider usage, so transient failures are expected; every host
 * retries on this schedule before giving up on a compaction.
 */
export const SUMMARY_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000,
];

/**
 * Output cap for one summary request: 0.8 × the reserve for history
 * summaries, 0.5 × for split-turn prefixes, never above the model's own
 * output limit.
 */
export const summaryMaxTokens = (
  modelMaxTokens: unknown,
  promptKind: "history" | "turnPrefix" = "history",
): number => {
  const limit = Number(modelMaxTokens);
  return Math.min(
    Math.floor(
      (promptKind === "turnPrefix" ? 0.5 : 0.8) * COMPACTION_RESERVE_TOKENS,
    ),
    Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : Number.POSITIVE_INFINITY,
  );
};

/** The summary length to ask for, from the size of the span. */
export const summaryTargetTokens = (
  spanTokens: number,
  maxTokens: number,
): number =>
  Math.max(100, Math.min(Math.floor(spanTokens * 0.2), Math.floor(maxTokens * 0.5)));

/**
 * Estimated chars-per-token used to cap the summary request input.
 * Deliberately conservative so the capped request can never itself overflow
 * the summarizer's window.
 */
const SUMMARY_INPUT_CHARS_PER_TOKEN = 3;
/** Char slack for the fixed prompt template (structure, guidelines, footer). */
const SUMMARY_PROMPT_TEMPLATE_CHARS = 4_000;

/**
 * Cap the formatted conversation fed to the summary model so a backlog of
 * uncompacted turns can never push the request over the summarizer's window.
 * Keeps the most recent part (the previous summary covers older ground) and
 * notes the elision.
 */
export const capSummaryConversation = (
  formatted: string,
  maxChars: number,
): string => {
  if (maxChars <= 0 || formatted.length <= maxChars) return formatted;
  const omittedChars = formatted.length - maxChars;
  return [
    `[Compaction input truncated: the oldest ~${Math.round(
      omittedChars / SUMMARY_INPUT_CHARS_PER_TOKEN,
    )} tokens of unsummarized conversation were omitted so this request fits the summary model's context window. Rely on the previous summary (when present) for older details.]`,
    formatted.slice(formatted.length - maxChars),
  ].join("\n\n");
};

/**
 * Non-conversation chars that ride along every summary request: the system
 * prompt, previous summary, durable-memory reference and prompt template.
 */
export const summaryOverheadChars = (args: {
  systemPromptChars: number;
  previousSummary?: string;
  durableMemoryReference?: string;
}): number =>
  args.systemPromptChars +
  (args.previousSummary?.length ?? 0) +
  (args.durableMemoryReference?.length ?? 0) +
  SUMMARY_PROMPT_TEMPLATE_CHARS;

/** Char budget for the formatted conversation in one summary request. */
export const summaryInputCharBudget = (
  window: number,
  overheadChars: number,
): number =>
  Math.max(
    MIN_TRIGGER_TOKENS * SUMMARY_INPUT_CHARS_PER_TOKEN,
    Math.max(MIN_TRIGGER_TOKENS, window - COMPACTION_RESERVE_TOKENS) *
      SUMMARY_INPUT_CHARS_PER_TOKEN -
      overheadChars,
  );

const DURABLE_MEMORY_DOC_MAX_CHARS = 8_000;

/**
 * The "already known, do not repeat" reference the summarizer gets: the
 * user profile, which the orchestrator sees as a resident block every turn.
 */
export const durableMemoryReference = (
  profile: string | undefined,
): string | undefined => {
  const text = profile?.trim();
  if (!text) return undefined;
  const capped =
    text.length > DURABLE_MEMORY_DOC_MAX_CHARS
      ? `${text.slice(0, DURABLE_MEMORY_DOC_MAX_CHARS)}\n[truncated]`
      : text;
  return `### User profile (memories/profile.md)\n${capped}`;
};

const SUMMARY_STRUCTURE = `## Topic
[What the conversation is about]

## Key Points
[Important information, decisions, and conclusions from the conversation]

## Current State
[Where things stand now — what has been done, what is in progress]

## Open Items
[Unresolved questions, pending tasks, or next steps discussed]`;

const summaryGuidelines = (hasDurableMemoryReference: boolean): string =>
  [
    "Guidelines:",
    '- Thread ids: delegated/background work appears in the conversation as spawn_agent / send_message / check-status tool calls and results carrying a `thread_id`. Name that exact thread_id alongside every workstream you mention (e.g. "shell redesign polish — thread_id: shell-redesign-v2-full-polish") so follow-ups after this checkpoint route to the existing thread instead of spawning a duplicate.',
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

/** The summarizer's user prompt; the system prompt is `thread-compaction.md`. */
export const buildOrchestratorSummaryPrompt = (args: {
  formattedConversation: string;
  previousSummary?: string;
  targetTokens: number;
  durableMemoryReference?: string;
}): string => {
  const previousSummary = args.previousSummary?.trim();
  if (!args.formattedConversation) return previousSummary ?? "";
  const reference = args.durableMemoryReference?.trim();
  const alreadyKnown = reference
    ? `ALREADY KNOWN (durable memory, injected separately on every turn — do NOT repeat any of this in the summary):
${reference}

`
    : "";
  const footer = `${summaryGuidelines(Boolean(reference))}

Target ~${args.targetTokens} tokens. Be factual — only include information that was explicitly discussed in the conversation. Do NOT invent file paths, commands, or details that were not mentioned. Write only the summary body.`;
  if (previousSummary) {
    return `You are updating a conversation summary. A previous summary exists below. New conversation turns have occurred since then and need to be incorporated.

${alreadyKnown}PREVIOUS SUMMARY:
${previousSummary}

NEW TURNS TO INCORPORATE:
${args.formattedConversation}

Update the summary. PRESERVE existing information that is still relevant. ADD new information. Remove information only if it is clearly obsolete.

${SUMMARY_STRUCTURE}

${footer}`;
  }
  return `Create a concise summary of this conversation that preserves the important information for future context.

${alreadyKnown}CONVERSATION TO SUMMARIZE:
${args.formattedConversation}

Use this structure:

${SUMMARY_STRUCTURE}

${footer}`;
};

/**
 * The messages that open a compacted conversation, as the model reads them on
 * every host: the checkpoint summary as an assistant message, then the
 * pinned copy of the latest instruction when there is one.
 */
export const checkpointMessages = (args: {
  summary: string;
  pinnedInstruction?: string;
  timestamp: number;
}): Array<UserMessage | AssistantMessage> => [
  {
    role: "assistant",
    content: [{ type: "text", text: formatCheckpointText(args.summary) }],
    api: "openai-completions",
    provider: "openai",
    model: "history",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: args.timestamp,
  },
  ...(args.pinnedInstruction?.trim()
    ? [
        {
          role: "user" as const,
          content: args.pinnedInstruction,
          timestamp: args.timestamp,
        },
      ]
    : []),
];
