import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import {
  buildOrchestratorSummaryPrompt,
  capSummaryConversation,
  compactionViewForPayload,
  contextWindowTokens,
  durableMemoryReference,
  estimatePayloadTokens,
  orchestratorCompactionTriggerTokens,
  orchestratorKeepRecentTokens,
  pinnedInstructionText,
  planOrchestratorCompaction,
  SUMMARY_RETRY_DELAYS_MS,
  summaryInputCharBudget,
  summaryLinesForPayload,
  summaryMaxTokens,
  summaryOverheadChars,
  summaryTargetTokens,
  type CompactionPayload,
} from "@stella/runtime/kernel/agent-runtime/orchestrator-compaction.js";

/**
 * Where the conversation was last compacted: the summary standing in for
 * every row through `coveredThroughSeq`, and the capped copy of the latest
 * instruction when it fell inside the summarized span.
 */
export type ContextCheckpoint = {
  coveredThroughSeq: number;
  summary: string;
  pinnedInstruction?: string;
};
export const CONTEXT_CHECKPOINT_KEY = "cloudContextCheckpoint:v1";

const isConversationMessage = (
  message: AgentMessage,
): message is AgentMessage & CompactionPayload =>
  message.role === "user" ||
  message.role === "assistant" ||
  message.role === "toolResult";

/** The request size the provider reported for the newest response, if any. */
const lastReportedContextTokens = (
  messages: readonly AgentMessage[],
): number | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const usage = message.usage;
    const prompt =
      (Number(usage?.input) || 0) +
      (Number(usage?.cacheRead) || 0) +
      (Number(usage?.cacheWrite) || 0);
    return prompt > 0 ? prompt + (Number(usage?.output) || 0) : undefined;
  }
  return undefined;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The orchestrator's compaction policy (`orchestrator-compaction.ts`, shared
 * with the desktop) applied to the cloud journal window: compact at half the
 * model's window, keep the recent tail verbatim with whole tool-call groups,
 * summarize the rest with `thread-compaction.md`, and pin the latest
 * instruction when it was summarized.
 */
export const compactCloudHistory = async (args: {
  messages: AgentMessage[];
  rows: Array<{ seq: number; role: string | null; hidden: boolean }>;
  checkpoint?: ContextCheckpoint;
  contextWindow: unknown;
  modelMaxTokens: unknown;
  /** `thread-compaction.md`, the summarizer's system prompt. */
  systemPrompt: string;
  /** The user's resident profile, which the summary must not restate. */
  profile?: string;
  summarize: (request: {
    systemPrompt: string;
    prompt: string;
    maxTokens: number;
  }) => Promise<string>;
  /** Called after a failed attempt, before the next; throws to stop. */
  beforeRetry?: (attempt: number, error: unknown) => Promise<void>;
}) => {
  const unchanged = { ...args, compacted: false as const };
  const window = contextWindowTokens(args.contextWindow);
  const views = args.messages.map((message) =>
    isConversationMessage(message)
      ? compactionViewForPayload(message)
      : { role: message.role, toolCallIds: [], tokens: 1 },
  );
  const estimated = views.reduce((sum, view) => sum + view.tokens, 0);
  const measured = lastReportedContextTokens(args.messages) ?? estimated;
  if (measured < orchestratorCompactionTriggerTokens(window)) return unchanged;

  const plan = planOrchestratorCompaction({
    messages: views,
    protectHead: 0,
    keepRecentTokens: orchestratorKeepRecentTokens(window),
  });
  if (!plan || plan.start !== 0) return unchanged;
  const span = args.messages.slice(0, plan.tailStart);
  const previousSummary = args.checkpoint?.summary;
  const reference = durableMemoryReference(args.profile);
  const formattedConversation = capSummaryConversation(
    span
      .filter(isConversationMessage)
      .flatMap((message) => summaryLinesForPayload(message))
      .join("\n\n")
      .trim(),
    summaryInputCharBudget(
      window,
      summaryOverheadChars({
        systemPromptChars: args.systemPrompt.length,
        previousSummary,
        durableMemoryReference: reference,
      }),
    ),
  );
  const maxTokens = summaryMaxTokens(args.modelMaxTokens);
  const prompt = buildOrchestratorSummaryPrompt({
    formattedConversation,
    previousSummary,
    targetTokens: summaryTargetTokens(
      span
        .filter(isConversationMessage)
        .reduce((sum, message) => sum + estimatePayloadTokens(message), 0),
      maxTokens,
    ),
    durableMemoryReference: reference,
  });
  if (!prompt) return unchanged;

  let summary = "";
  for (let attempt = 1; ; attempt += 1) {
    let failure: unknown;
    try {
      summary = (
        await args.summarize({ systemPrompt: args.systemPrompt, prompt, maxTokens })
      ).trim();
      if (summary) break;
      failure = new Error("empty summary");
    } catch (error) {
      failure = error;
    }
    if (attempt > SUMMARY_RETRY_DELAYS_MS.length) break;
    await args.beforeRetry?.(attempt, failure);
    await sleep(SUMMARY_RETRY_DELAYS_MS[attempt - 1]!);
  }
  // Like the desktop, a failed summary leaves the conversation as it was.
  if (!summary) return unchanged;

  const coveredThroughSeq = args.rows[plan.tailStart - 1]?.seq;
  if (coveredThroughSeq === undefined)
    throw new Error("Conversation compaction lost its journal boundary.");
  const latestUser =
    plan.latestUserIndex !== undefined
      ? args.messages[plan.latestUserIndex]
      : undefined;
  const pinned =
    latestUser?.role === "user"
      ? pinnedInstructionText(
          typeof latestUser.content === "string"
            ? latestUser.content
            : latestUser.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n"),
        )
      : "";
  return {
    messages: args.messages.slice(plan.tailStart),
    rows: args.rows.slice(plan.tailStart),
    checkpoint: {
      coveredThroughSeq,
      summary,
      ...(pinned ? { pinnedInstruction: pinned } : {}),
    },
    compacted: true as const,
  };
};
