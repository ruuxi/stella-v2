import os from "os";
import path from "path";
import { Type } from "@sinclair/typebox";
import { Agent } from "../agent-core/agent.js";
import { selectRecentByTokenBudget } from "../local-history.js";
import { estimateRuntimeTokens } from "../runtime-threads.js";
import {
  getAgentFollowUpMode,
  getAgentSteeringMode,
  getLocalCliWorkingDirectory,
} from "@stella/contracts/agent-runtime";
import { isDeepSeekV4FlashModel } from "@stella/contracts/stella-api";
import {
  isBootstrapStartupDocMessage,
  stripStaleImageBlocks,
} from "./thread-memory.js";
import { preflightProviderPayload } from "./context-budget.js";
const MAX_RESULT_PREVIEW = 200;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const CONTEXT_PRUNE_RESERVE_TOKENS = 16_384;
const MIN_CONTEXT_PRUNE_TOKENS = 8_000;
const ESTIMATED_IMAGE_TOKENS = 2_000;
export const DEFAULT_MAX_TURNS = 40;
export const PI_AGENT_MESSAGE_FILTER = (messages) =>
  messages.flatMap((msg) => {
    if (
      msg.role === "user" ||
      msg.role === "assistant" ||
      msg.role === "toolResult"
    ) {
      return [msg];
    }
    if (msg.role === "runtimeInternal") {
      return [
        {
          role: "user",
          content: msg.content,
          timestamp: msg.timestamp,
        },
      ];
    }
    return [];
  });
export const AnyToolArgsSchema = Type.Object(
  {},
  { additionalProperties: true },
);
export const now = () => Date.now();
const expandWorkingDirectory = (value, homeDirectory) => {
  if (value === "~") return homeDirectory;
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
};
/**
 * Resolve the filesystem root an agent should operate from. The install root
 * remains a separate absolute path for bundled assets; it is only selected
 * here for the legacy `frontend` mode or as a last-resort fallback when the
 * platform does not expose a home directory.
 */
export const resolveLocalCliCwd = ({
  agentType,
  stellaAppDir,
  workingDirectory,
}) => {
  const homeDirectory = os.homedir().trim();
  const explicitWorkingDirectory = workingDirectory?.trim();
  if (explicitWorkingDirectory) {
    return path.resolve(
      expandWorkingDirectory(explicitWorkingDirectory, homeDirectory),
    );
  }
  if (getLocalCliWorkingDirectory(agentType) !== "frontend" && homeDirectory) {
    return path.resolve(homeDirectory);
  }
  const normalizedStellaAppDir = stellaAppDir?.trim();
  return normalizedStellaAppDir && normalizedStellaAppDir.length > 0
    ? normalizedStellaAppDir
    : undefined;
};
export const textFromUnknown = (value) => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
const textFromToolLikeValue = (value) => {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value;
    if (typeof record.result === "string") {
      return record.result;
    }
    if (typeof record.error === "string") {
      return record.error;
    }
    if (typeof record.text === "string") {
      return record.text;
    }
    if (record.details && typeof record.details === "object") {
      const details = record.details;
      if (typeof details.text === "string") {
        return details.text;
      }
    }
  }
  return textFromUnknown(value);
};
export const getToolResultPreview = (_toolName, result) =>
  textFromToolLikeValue(result).slice(0, MAX_RESULT_PREVIEW);
export const toAgentMessages = (history) => {
  const usage = {
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
  return history
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => {
      if (entry.role === "user") {
        return {
          role: "user",
          content: [{ type: "text", text: entry.content }],
          timestamp: now(),
        };
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: entry.content }],
        api: "openai-completions",
        provider: "openai",
        model: "history",
        usage,
        stopReason: "stop",
        timestamp: now(),
      };
    });
};
export const extractAssistantText = (message) => {
  if (!message || message.role !== "assistant") return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block) => block.type === "text")
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
export const assistantMessageHasToolCall = (message) => {
  if (!message || message.role !== "assistant") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.some((block) => block.type === "toolCall");
};
const getLatestAssistantMessage = (messages) =>
  [...messages].reverse().find((message) => message.role === "assistant");
/**
 * True when the run's final assistant message is a truncated reasoning
 * trace: `stopReason: "length"` with neither visible text nor a tool call
 * (typically thinking-only). The provider hit its output-token cap while
 * the model was still reasoning, so no reply was ever produced. This is a
 * failure, not a success — without this check the run would finalize as
 * "success" with an empty result and surface only the generic
 * empty-result sentinel to the caller.
 */
const isTruncatedReasoningCompletion = (message) => {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "length") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return !blocks.some(
    (block) =>
      block.type === "toolCall" ||
      (block.type === "text" && block.text.trim().length > 0),
  );
};
export const getAgentCompletion = (agent) => {
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
        errorMessage: `Run truncated: model hit the output-token cap${outputTokens ? ` (${outputTokens} tokens)` : ""} while reasoning; no visible reply was produced.`,
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
export const createBeforeProviderPayloadTransform = (hookEmitter, agentType) =>
  hookEmitter
    ? async (payload, model) => {
        const result = await hookEmitter.emit("before_provider_request", {
          agentType,
          model: model.id,
          payload,
        });
        return result?.payload;
      }
    : undefined;
export const createRuntimeAgent = (args) => {
  const resolveLlm = args.resolvedLlmOverride ?? (() => args.resolvedLlm);
  const toolInactivityRaw =
    process.env.STELLA_TOOL_INACTIVITY_TIMEOUT_MS?.trim();
  const toolInactivityParsed = toolInactivityRaw
    ? Number(toolInactivityRaw)
    : Number.NaN;
  return new Agent({
    initialState: {
      systemPrompt: args.systemPrompt,
      model: resolveLlm().model,
      thinkingLevel:
        args.reasoningEffort ??
        resolveAgentThinkingLevel({ resolvedLlm: args.resolvedLlm }),
      tools: args.tools,
      messages: args.historySource,
    },
    sessionId: args.cacheSessionId ?? args.agentType,
    promptCacheKey: args.promptCacheKey,
    serviceTier: args.serviceTier,
    // Per-tool inactivity bound (default 10 min in agent-core): a tool that
    // goes fully silent is cancelled with an error tool result instead of
    // tripping the run-level idle watchdog and killing the whole agent.
    ...(Number.isFinite(toolInactivityParsed)
      ? { toolInactivityTimeoutMs: toolInactivityParsed }
      : {}),
    convertToLlm: PI_AGENT_MESSAGE_FILTER,
    // Only pass steering / follow-up modes when the agent opts out of
    // the Pi default ("one-at-a-time").
    ...(getAgentSteeringMode(args.agentType) === "all"
      ? { steeringMode: "all" }
      : {}),
    ...(getAgentFollowUpMode(args.agentType) === "all"
      ? { followUpMode: "all" }
      : {}),
    getApiKey: () => resolveLlm().getApiKey(),
    // Always defined when an override is in play, since the *current*
    // route may have a refresher even if the original didn't (and vice
    // versa). The inner `?.()` returns `undefined` when the route lacks
    // one, which the agent loop already handles.
    refreshApiKey: () => resolveLlm().refreshApiKey?.(),
    onPayload: async (payload, model) => {
      const transform = createBeforeProviderPayloadTransform(
        args.hookEmitter,
        args.agentType,
      );
      const transformed = await transform?.(payload, model);
      preflightProviderPayload(
        args.cacheSessionId ?? args.agentType,
        transformed ?? payload,
        model,
      );
      return transformed;
    },
    onProviderRetry: args.onProviderRetry,
    afterToolCall: args.afterToolCall
      ? async (context, signal) => await args.afterToolCall?.(context, signal)
      : undefined,
  });
};
/**
 * Resolve the `thinkingLevel` an Agent should run with for a given turn.
 *
 * Long-lived sessions refresh this between turns when the user changes
 * reasoning-effort preferences or model routes.
 */
export const resolveAgentThinkingLevel = (args) => {
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
