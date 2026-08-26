/**
 * Loop-adjacent helpers shared by the desktop runtime and portable sandbox
 * executors. Keep this module free of Node builtins, filesystems, and desktop
 * stores. `shared.ts` and `thread-memory.ts` re-export everything here for
 * their existing callers.
 */

import type { Agent } from "../agent-core/agent.js";
import type { AgentMessage, ThinkingLevel } from "../agent-core/types.js";
import { isDeepSeekV4FlashModel } from "@stella/contracts/stella-api";
import { selectRecentByTokenBudget } from "../storage/shared.js";
import { estimateRuntimeTokens } from "../runtime-threads.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const CONTEXT_PRUNE_RESERVE_TOKENS = 16_384;
const MIN_CONTEXT_PRUNE_TOKENS = 8_000;
const ESTIMATED_IMAGE_TOKENS = 2_000;

export const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE = "bootstrap.startup_doc";

/**
 * The minimal slice of a model route the context budget and thinking
 * resolution read. `ResolvedLlmRoute` satisfies it structurally, and cloud
 * hosts satisfy it with their pinned relay `Model`.
 */
export type ModelRouteLike = {
  model: {
    contextWindow?: number;
    reasoning?: boolean;
    id?: string;
    upstreamModelId?: string;
  };
};

const estimateUnknownTokens = (value: unknown): number => {
  if (typeof value === "string") {
    return estimateRuntimeTokens(value);
  }
  if (value == null) {
    return 0;
  }
  try {
    return estimateRuntimeTokens(JSON.stringify(value));
  } catch {
    return estimateRuntimeTokens(String(value));
  }
};

const estimateContentTokens = (content: unknown): number => {
  if (typeof content === "string") {
    return estimateRuntimeTokens(content);
  }
  if (!Array.isArray(content)) {
    return estimateUnknownTokens(content);
  }
  return content.reduce((sum, block) => {
    if (!block || typeof block !== "object") {
      return sum + estimateUnknownTokens(block);
    }
    const candidate = block as Record<string, unknown>;
    switch (candidate.type) {
      case "text":
        return (
          sum +
          estimateRuntimeTokens(
            typeof candidate.text === "string" ? candidate.text : "",
          )
        );
      case "thinking":
        return (
          sum +
          estimateRuntimeTokens(
            typeof candidate.thinking === "string" ? candidate.thinking : "",
          )
        );
      case "image":
        return sum + ESTIMATED_IMAGE_TOKENS;
      case "toolCall":
        return (
          sum +
          estimateUnknownTokens({
            name: candidate.name,
            arguments: candidate.arguments,
          })
        );
      default:
        return sum + estimateUnknownTokens(candidate);
    }
  }, 0);
};

export const estimateAgentMessageTokens = (message: AgentMessage): number => {
  const baseTokens = 8;
  if (message.role === "toolResult") {
    return Math.max(
      1,
      baseTokens +
        estimateRuntimeTokens(message.toolName) +
        estimateContentTokens(message.content),
    );
  }
  return Math.max(1, baseTokens + estimateContentTokens(message.content));
};

export const getContextPruneBudget = (resolvedLlm: ModelRouteLike): number => {
  const contextWindow = Number(resolvedLlm.model.contextWindow);
  const safeContextWindow =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.floor(contextWindow)
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.max(
    MIN_CONTEXT_PRUNE_TOKENS,
    safeContextWindow - CONTEXT_PRUNE_RESERVE_TOKENS,
  );
};

// Retention budget for tool-result images in model history, newest first.
// The old policy kept exactly ONE image-bearing message, which made
// multi-image work impossible: viewing 5 reference images left 4 as
// "re-run the tool" placeholders on the very next LLM call, and every
// re-view evicted the previous image. Budgets are accounted per image
// block (a batched view counts each image), sized so screenshot loops
// stay cheap while a set of downscaled reference images survives across
// turns without busting the managed relay's ~20MiB request cap.
const MAX_IMAGES_IN_HISTORY = 8;
const IMAGE_HISTORY_BASE64_BUDGET = 12 * 1024 * 1024;

export const stripStaleImageBlocks = <T extends { role: string }>(
  messages: T[],
): T[] => {
  let imagesKept = 0;
  let imageBytesKept = 0;
  let rewroteAny = false;
  const out: T[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult") {
      out.push(message);
      continue;
    }
    const toolResult = message as unknown as {
      content: Array<{ type: string; data?: string; mimeType?: string }>;
    };
    const hasImage = toolResult.content.some((block) => block.type === "image");
    if (!hasImage) {
      out.push(message);
      continue;
    }
    let rewroteThisMessage = false;
    // Within a message, newest-last ordering doesn't matter much; account
    // blocks in reverse so the budget favors the same blocks the loop
    // direction favors across messages.
    const compactContent = [...toolResult.content]
      .reverse()
      .map((block) => {
        if (block.type !== "image") {
          return block;
        }
        const base64Bytes = block.data?.length ?? 0;
        if (
          imagesKept < MAX_IMAGES_IN_HISTORY &&
          imageBytesKept + base64Bytes <= IMAGE_HISTORY_BASE64_BUDGET
        ) {
          imagesKept += 1;
          imageBytesKept += base64Bytes;
          return block;
        }
        rewroteThisMessage = true;
        const sizeKb = Math.round((base64Bytes * 0.75) / 1024);
        return {
          type: "text",
          text: `[Older ${block.mimeType ?? "image/png"} screenshot omitted from history (~${sizeKb}KB). Re-run the tool to see it again.]`,
        };
      })
      .reverse();
    if (!rewroteThisMessage) {
      out.push(message);
      continue;
    }
    rewroteAny = true;
    out.push({
      ...(message as object),
      content: compactContent,
    } as unknown as T);
  }
  return rewroteAny ? out.reverse() : messages;
};

export const isBootstrapStartupDocMessage = (
  message: Pick<AgentMessage, "role"> & { customType?: string },
): boolean =>
  message.role === "runtimeInternal" &&
  message.customType === BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE;

export const buildDefaultTransformContext = (
  resolvedLlm: ModelRouteLike,
): ((
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>) => {
  const maxTokens = getContextPruneBudget(resolvedLlm);
  return async (messages, signal) => {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }
    // Strip on every per-turn call. `buildHistorySource` already runs this
    // once at run start, but the agent loop appends fresh tool results
    // (each carrying a base64 PNG) into the live messages array between
    // LLM calls. Without re-stripping, all those screenshots stack up in
    // the prompt every subsequent turn, and a 4-step stella-computer task
    // overflows the managed runtime's payload budget.
    const stripped = stripStaleImageBlocks(messages);
    const totalTokens = stripped.reduce(
      (sum, message) => sum + estimateAgentMessageTokens(message),
      0,
    );
    if (totalTokens <= maxTokens) {
      return stripped;
    }
    const pinnedStartupDocs = stripped.filter(isBootstrapStartupDocMessage);
    if (pinnedStartupDocs.length > 0) {
      const pinnedDocSet = new Set<AgentMessage>(pinnedStartupDocs);
      const pinnedTokens = pinnedStartupDocs.reduce(
        (sum, message) => sum + estimateAgentMessageTokens(message),
        0,
      );
      const remainingBudget = maxTokens - pinnedTokens;
      if (remainingBudget > 0) {
        const recentUnpinned = selectRecentByTokenBudget({
          itemsNewestFirst: stripped
            .filter((message) => !pinnedDocSet.has(message))
            .reverse(),
          maxTokens: remainingBudget,
          estimateTokens: estimateAgentMessageTokens,
        });
        const recentSet = new Set<AgentMessage>(recentUnpinned);
        return stripped.filter(
          (message) => pinnedDocSet.has(message) || recentSet.has(message),
        );
      }
    }
    const selected = selectRecentByTokenBudget({
      itemsNewestFirst: [...stripped].reverse(),
      maxTokens,
      estimateTokens: estimateAgentMessageTokens,
    });
    return [...selected].reverse();
  };
};

/**
 * Resolve the `thinkingLevel` an Agent should run with for a given turn.
 *
 * Long-lived sessions refresh this between turns when the user changes
 * reasoning-effort preferences or model routes.
 */
export const resolveAgentThinkingLevel = (args: {
  resolvedLlm: ModelRouteLike;
  agentContextReasoningEffort?: Exclude<ThinkingLevel, "off"> | "default";
}): ThinkingLevel => {
  if (
    args.agentContextReasoningEffort &&
    args.agentContextReasoningEffort !== "default"
  ) {
    return args.agentContextReasoningEffort;
  }
  const model = args.resolvedLlm.model;
  if (
    isDeepSeekV4FlashModel(model.id) ||
    isDeepSeekV4FlashModel(model.upstreamModelId)
  ) {
    return "xhigh";
  }
  return args.resolvedLlm.model.reasoning ? "medium" : "off";
};

export const extractAssistantText = (
  message: AgentMessage | undefined,
): string => {
  if (!message || message.role !== "assistant") return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("");
};

/**
 * True when an assistant message carries at least one tool call. Such a
 * message is *interim* — the agent loop runs the tools and then produces a
 * further message — so any visible preamble text it contains is not the
 * final answer. The working indicator uses this to avoid handing off (and
 * disappearing) between a preamble and the tool call it precedes.
 */
export const assistantMessageHasToolCall = (
  message: AgentMessage | undefined,
): boolean => {
  if (!message || message.role !== "assistant") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.some((block) => block.type === "toolCall");
};

/**
 * True when an assistant message carries something the conversation can use:
 * a tool call, or text with non-whitespace in it. A message that fails this
 * is not an answer — it is a burnt provider call (an empty completion, or a
 * thinking-only reply that hit the output cap while reasoning).
 *
 * This is the single definition of "poppable tail". The retry ladder removes
 * such a message from the live context before resuming, so any host that
 * persists messages as the loop produces them MUST apply the same predicate
 * before writing — otherwise the durable transcript keeps a message the model
 * no longer has, and the next turn rebuilds a history with two consecutive
 * assistant messages, one of them empty.
 */
export const assistantMessageHasUsableOutput = (
  message: AgentMessage,
): boolean => {
  if (message.role !== "assistant") return true;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.some(
    (block) =>
      block.type === "toolCall" ||
      (block.type === "text" && block.text.trim().length > 0),
  );
};

const getLatestAssistantMessage = (
  messages: AgentMessage[],
): AgentMessage | undefined =>
  [...messages].reverse().find((message) => message.role === "assistant");

type AgentCompletionSource = {
  state: Pick<Agent["state"], "messages" | "error">;
};

/**
 * True when the run's final assistant message is a truncated reasoning
 * trace: `stopReason: "length"` with neither visible text nor a tool call
 * (typically thinking-only). The provider hit its output-token cap while
 * the model was still reasoning, so no reply was ever produced. This is a
 * failure, not a success — without this check the run would finalize as
 * "success" with an empty result and surface only the generic
 * empty-result sentinel to the caller.
 */
const isTruncatedReasoningCompletion = (
  message: AgentMessage | undefined,
): message is Extract<AgentMessage, { role: "assistant" }> => {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "length") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return !blocks.some(
    (block) =>
      block.type === "toolCall" ||
      (block.type === "text" && block.text.trim().length > 0),
  );
};

export const getAgentCompletion = (
  agent: AgentCompletionSource,
): { finalText: string; errorMessage?: string; retryAfterMs?: number } => {
  const latestAssistant = getLatestAssistantMessage(agent.state.messages);
  const finalText = extractAssistantText(latestAssistant);

  if (latestAssistant?.role === "assistant") {
    const assistantError = latestAssistant.errorMessage?.trim();
    // The provider adapter parked the failing response's Retry-After here
    // before flattening the error to a string. Carry it into the turn
    // result so the run-level retry can back off for as long as the
    // provider actually asked for.
    const retryAfter =
      typeof latestAssistant.retryAfterMs === "number" &&
      Number.isFinite(latestAssistant.retryAfterMs)
        ? { retryAfterMs: latestAssistant.retryAfterMs }
        : {};
    if (
      latestAssistant.stopReason === "error" ||
      latestAssistant.stopReason === "aborted"
    ) {
      return {
        finalText,
        ...retryAfter,
        errorMessage:
          assistantError ||
          agent.state.error ||
          (latestAssistant.stopReason === "aborted"
            ? "Request was aborted"
            : "Agent failed"),
      };
    }

    if (assistantError) {
      return {
        finalText,
        ...retryAfter,
        errorMessage: assistantError,
      };
    }

    if (isTruncatedReasoningCompletion(latestAssistant)) {
      const outputTokens = latestAssistant.usage?.output;
      return {
        finalText,
        errorMessage: `Run truncated: model hit the output-token cap${
          outputTokens ? ` (${outputTokens} tokens)` : ""
        } while reasoning; no visible reply was produced.`,
      };
    }
  }

  if (agent.state.error && !finalText.trim()) {
    return {
      finalText,
      errorMessage: agent.state.error,
    };
  }

  return { finalText };
};
