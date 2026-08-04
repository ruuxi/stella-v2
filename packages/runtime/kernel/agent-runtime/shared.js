import os from "os";
import path from "path";
import { Type } from "@sinclair/typebox";
import { Agent } from "../agent-core/agent.js";
import { selectRecentByTokenBudget } from "../local-history.js";
import { estimateRuntimeTokens } from "../runtime-threads.js";
import { getAgentFollowUpMode, getAgentSteeringMode, getLocalCliWorkingDirectory, } from "@stella/contracts/agent-runtime";
import { isBootstrapStartupDocMessage, stripStaleImageBlocks, } from "./thread-memory.js";
const MAX_RESULT_PREVIEW = 200;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const CONTEXT_PRUNE_RESERVE_TOKENS = 16_384;
const MIN_CONTEXT_PRUNE_TOKENS = 8_000;
const ESTIMATED_IMAGE_TOKENS = 2_000;
export const DEFAULT_MAX_TURNS = 40;
export const PI_AGENT_MESSAGE_FILTER = (messages) => messages.flatMap((msg) => {
    if (msg.role === "user" ||
        msg.role === "assistant" ||
        msg.role === "toolResult") {
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
export const AnyToolArgsSchema = Type.Object({}, { additionalProperties: true });
export const now = () => Date.now();
const expandWorkingDirectory = (value, homeDirectory) => {
    if (value === "~")
        return homeDirectory;
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
export const resolveLocalCliCwd = ({ agentType, stellaAppDir, workingDirectory, }) => {
    const homeDirectory = os.homedir().trim();
    const explicitWorkingDirectory = workingDirectory?.trim();
    if (explicitWorkingDirectory) {
        return path.resolve(expandWorkingDirectory(explicitWorkingDirectory, homeDirectory));
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
    if (typeof value === "string")
        return value;
    if (value == null)
        return "";
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
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
export const getToolResultPreview = (_toolName, result) => textFromToolLikeValue(result).slice(0, MAX_RESULT_PREVIEW);
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
const resolvePositiveTokenLimit = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
export const resolveModelToolOutputTokenLimit = (resolvedLlm) => resolvePositiveTokenLimit(resolvedLlm.model.toolOutputTokenLimit, DEFAULT_MODEL_TOOL_OUTPUT_TOKENS);
const truncateToolText = (text, maxChars) => {
    const boundedMaxChars = Math.max(1, Math.floor(maxChars));
    if (text.length <= boundedMaxChars) {
        return { text, truncated: false };
    }
    const markerFor = (omittedChars) => `\n\n[Tool output truncated: ${omittedChars} characters omitted.]\n\n`;
    let marker = markerFor(text.length - boundedMaxChars);
    let available = boundedMaxChars - marker.length;
    if (available <= 0) {
        return {
            text: text.slice(0, boundedMaxChars),
            truncated: true,
        };
    }
    let headChars = Math.ceil(available / 2);
    let tailChars = Math.floor(available / 2);
    marker = markerFor(text.length - headChars - tailChars);
    available = boundedMaxChars - marker.length;
    if (available <= 0) {
        return {
            text: text.slice(0, boundedMaxChars),
            truncated: true,
        };
    }
    headChars = Math.ceil(available / 2);
    tailChars = Math.floor(available / 2);
    return {
        text: `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`,
        truncated: true,
    };
};
const truncateShellPayloadOutput = (text, maxTokens) => {
    const maxChars = maxTokens * TOOL_OUTPUT_CHARS_PER_TOKEN;
    try {
        const parsed = JSON.parse(text);
        if (parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            typeof parsed.output === "string") {
            const record = parsed;
            const output = record.output;
            const truncated = truncateToolText(output, maxChars);
            if (!truncated.truncated)
                return text;
            return JSON.stringify({ ...record, output: truncated.text }, null, 2);
        }
    }
    catch {
        // Non-JSON shell results still receive the requested body budget.
    }
    return truncateToolText(text, maxChars).text;
};
const allocateTextBudgets = (lengths, totalBudget) => {
    const budgets = lengths.map(() => 0);
    let remainingBudget = Math.max(0, Math.floor(totalBudget));
    let remaining = lengths.map((_, index) => index);
    while (remaining.length > 0) {
        const share = Math.floor(remainingBudget / remaining.length);
        const completed = remaining.filter((index) => lengths[index] <= share);
        if (completed.length === 0) {
            for (const [offset, index] of remaining.entries()) {
                budgets[index] =
                    share + (offset < remainingBudget % remaining.length ? 1 : 0);
            }
            break;
        }
        for (const index of completed) {
            budgets[index] = lengths[index];
            remainingBudget -= lengths[index];
        }
        const completedSet = new Set(completed);
        remaining = remaining.filter((index) => !completedSet.has(index));
    }
    return budgets;
};
const truncateToolResultTextBlocks = (message, maxChars) => {
    const textBlocks = message.content.filter((block) => block.type === "text");
    const totalChars = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
    if (totalChars <= maxChars || textBlocks.length === 0)
        return message;
    const budgets = allocateTextBudgets(textBlocks.map((block) => block.text.length), maxChars);
    let textIndex = 0;
    return {
        ...message,
        content: message.content.map((block) => {
            if (block.type !== "text")
                return block;
            const budget = budgets[textIndex++] ?? 0;
            return {
                ...block,
                text: truncateToolText(block.text, budget).text,
            };
        }),
    };
};
/**
 * Build a request-only projection of tool results. Durable messages keep the
 * full sanitized result; text is normalized only immediately before the next
 * provider call.
 */
export const normalizeModelVisibleToolResults = (messages, resolvedLlm) => {
    const modelPolicyTokens = resolveModelToolOutputTokenLimit(resolvedLlm);
    const genericMaxChars = Math.ceil(modelPolicyTokens * TOOL_OUTPUT_SERIALIZATION_ALLOWANCE) *
        TOOL_OUTPUT_CHARS_PER_TOKEN;
    let changed = false;
    const normalized = messages.map((message) => {
        if (message.role !== "toolResult")
            return message;
        let projected = message;
        const toolBudget = typeof message.modelOutputTokens === "number"
            ? Math.min(modelPolicyTokens, resolvePositiveTokenLimit(message.modelOutputTokens, DEFAULT_MODEL_TOOL_OUTPUT_TOKENS))
            : null;
        if (toolBudget !== null) {
            const nextContent = projected.content.map((block) => block.type === "text"
                ? {
                    ...block,
                    text: truncateShellPayloadOutput(block.text, toolBudget),
                }
                : block);
            if (nextContent.some((block, index) => block.type === "text" &&
                projected.content[index]?.type === "text" &&
                block.text !== projected.content[index].text)) {
                projected = { ...projected, content: nextContent };
            }
        }
        projected = truncateToolResultTextBlocks(projected, genericMaxChars);
        if (projected !== message)
            changed = true;
        return projected;
    });
    return changed ? normalized : messages;
};
export const buildDefaultTransformContext = (resolvedLlm) => {
    return async (messages, signal) => {
        if (signal?.aborted) {
            throw new Error("Aborted");
        }
        // History reduction is durable compaction only. This request projection
        // may normalize model-visible tool text, but it never drops or rewrites
        // conversation entries based on a per-request token budget.
        return normalizeModelVisibleToolResults(messages, resolvedLlm);
    };
};
export const extractAssistantText = (message) => {
    if (!message || message.role !== "assistant")
        return "";
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
    if (!message || message.role !== "assistant")
        return false;
    const blocks = Array.isArray(message.content) ? message.content : [];
    return blocks.some((block) => block.type === "toolCall");
};
const getLatestAssistantMessage = (messages) => [...messages].reverse().find((message) => message.role === "assistant");
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
    if (!message || message.role !== "assistant")
        return false;
    if (message.stopReason !== "length")
        return false;
    const blocks = Array.isArray(message.content) ? message.content : [];
    return !blocks.some((block) => block.type === "toolCall" ||
        (block.type === "text" && block.text.trim().length > 0));
};
export const getAgentCompletion = (agent) => {
    const latestAssistant = getLatestAssistantMessage(agent.state.messages);
    const finalText = extractAssistantText(latestAssistant);
    if (latestAssistant?.role === "assistant") {
        const assistantError = latestAssistant.errorMessage?.trim();
        if (latestAssistant.stopReason === "error" ||
            latestAssistant.stopReason === "aborted") {
            return {
                finalText,
                errorMessage: assistantError ||
                    agent.state.error ||
                    (latestAssistant.stopReason === "aborted"
                        ? "Request was aborted"
                        : "Agent failed"),
            };
        }
        if (assistantError) {
            return {
                finalText,
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
export const createBeforeProviderPayloadTransform = (hookEmitter, agentType) => hookEmitter
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
    const toolInactivityRaw = process.env.STELLA_TOOL_INACTIVITY_TIMEOUT_MS?.trim();
    const toolInactivityParsed = toolInactivityRaw ? Number(toolInactivityRaw) : Number.NaN;
    return new Agent({
        initialState: {
            systemPrompt: args.systemPrompt,
            model: resolveLlm().model,
            thinkingLevel: args.reasoningEffort ??
                resolveAgentThinkingLevel({ resolvedLlm: args.resolvedLlm }),
            tools: args.tools,
            messages: args.historySource,
        },
        sessionId: args.cacheSessionId ?? args.agentType,
        serviceTier: args.serviceTier,
        // Per-tool inactivity bound (default 10 min in agent-core): a tool that
        // goes fully silent is cancelled with an error tool result instead of
        // tripping the run-level idle watchdog and killing the whole agent.
        ...(Number.isFinite(toolInactivityParsed)
            ? { toolInactivityTimeoutMs: toolInactivityParsed }
            : {}),
        convertToLlm: PI_AGENT_MESSAGE_FILTER,
        transformContext: async (messages, signal) => buildDefaultTransformContext(resolveLlm())(messages, signal),
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
        onPayload: createBeforeProviderPayloadTransform(args.hookEmitter, args.agentType),
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
    if (args.agentContextReasoningEffort &&
        args.agentContextReasoningEffort !== "default") {
        return args.agentContextReasoningEffort;
    }
    return args.resolvedLlm.model.reasoning ? "medium" : "off";
};
