import Anthropic from "@anthropic-ai/sdk";
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import { sanitizeInlineImagePayload } from "../utils/image-payload.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.js";
import { anomalousStreamStopError, providerAbortedStopMessage } from "../utils/provider-stop.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { normalizeProviderToolInputSchema } from "../utils/tool-schema.js";
import { resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { requestWithAuthRefresh } from "./auth-refresh.js";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";

function resolveCacheRetention(cacheRetention) {
    if (cacheRetention) {
        return cacheRetention;
    }
    if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
        return "long";
    }
    return "short";
}
function getCacheControl(model, cacheRetention) {
    const retention = resolveCacheRetention(cacheRetention);
    if (retention === "none") {
        return { retention };
    }
    const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
    return {
        retention,
        cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
    };
}

const claudeCodeVersion = "2.1.75";

const claudeCodeTools = [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
    "EnterPlanMode",
    "ExitPlanMode",
    "KillShell",
    "NotebookEdit",
    "Skill",
    "Task",
    "TaskOutput",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
];
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

const toClaudeCodeName = (name) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name, tools) => {
    if (tools && tools.length > 0) {
        const lowerName = name.toLowerCase();
        const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
        if (matchedTool)
            return matchedTool.name;
    }
    return name;
};

const UNPROCESSABLE_IMAGE_NOTE = "[Image omitted: it could not be decoded as a valid image and was skipped.]";

function convertContentBlocks(content) {

    const hasImages = content.some((c) => c.type === "image");
    if (!hasImages) {
        return sanitizeSurrogates(content.map((c) => c.text).join("\n"));
    }

    const blocks = content.map((block) => {
        if (block.type === "text") {
            return {
                type: "text",
                text: sanitizeSurrogates(block.text),
            };
        }

        const sanitized = sanitizeInlineImagePayload(block.data, block.mimeType);
        if (!sanitized) {
            return {
                type: "text",
                text: UNPROCESSABLE_IMAGE_NOTE,
            };
        }
        return {
            type: "image",
            source: {
                type: "base64",
                media_type: sanitized.mediaType,
                data: sanitized.data,
            },
        };
    });

    const hasText = blocks.some((b) => b.type === "text");
    if (!hasText) {
        blocks.unshift({
            type: "text",
            text: "(see attached image)",
        });
    }
    return blocks;
}
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
function getAnthropicCompat(model) {
    return {
        supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
        supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
    };
}
function mergeHeaders(...headerSources) {
    const merged = {};
    for (const headers of headerSources) {
        if (headers) {
            Object.assign(merged, headers);
        }
    }
    return merged;
}
const ANTHROPIC_MESSAGE_EVENTS = new Set([
    "message_start",
    "message_delta",
    "message_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
]);
function flushSseEvent(state) {
    if (!state.event && state.data.length === 0) {
        return null;
    }
    const event = {
        event: state.event,
        data: state.data.join("\n"),
        raw: [...state.raw],
    };
    state.event = null;
    state.data = [];
    state.raw = [];
    return event;
}
function decodeSseLine(line, state) {
    if (line === "") {
        return flushSseEvent(state);
    }
    state.raw.push(line);
    if (line.startsWith(":")) {
        return null;
    }
    const delimiterIndex = line.indexOf(":");
    const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
    let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
    if (value.startsWith(" ")) {
        value = value.slice(1);
    }
    if (fieldName === "event") {
        state.event = value;
    }
    else if (fieldName === "data") {
        state.data.push(value);
    }
    return null;
}
function nextLineBreakIndex(text) {
    const carriageReturnIndex = text.indexOf("\r");
    const newlineIndex = text.indexOf("\n");
    if (carriageReturnIndex === -1) {
        return newlineIndex;
    }
    if (newlineIndex === -1) {
        return carriageReturnIndex;
    }
    return Math.min(carriageReturnIndex, newlineIndex);
}
function consumeLine(text) {
    const lineBreakIndex = nextLineBreakIndex(text);
    if (lineBreakIndex === -1) {
        return null;
    }
    let nextIndex = lineBreakIndex + 1;
    if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
        nextIndex += 1;
    }
    return {
        line: text.slice(0, lineBreakIndex),
        rest: text.slice(nextIndex),
    };
}
async function* iterateSseMessages(body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const state = { event: null, data: [], raw: [] };
    let buffer = "";
    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let consumed = consumeLine(buffer);
            while (consumed) {
                buffer = consumed.rest;
                const event = decodeSseLine(consumed.line, state);
                if (event) {
                    yield event;
                }
                consumed = consumeLine(buffer);
            }
        }
        buffer += decoder.decode();
        let consumed = consumeLine(buffer);
        while (consumed) {
            buffer = consumed.rest;
            const event = decodeSseLine(consumed.line, state);
            if (event) {
                yield event;
            }
            consumed = consumeLine(buffer);
        }
        if (buffer.length > 0) {
            const event = decodeSseLine(buffer, state);
            if (event) {
                yield event;
            }
        }
        const trailingEvent = flushSseEvent(state);
        if (trailingEvent) {
            yield trailingEvent;
        }
    }
    finally {

        try {
            await reader.cancel();
        }
        catch {

        }
        reader.releaseLock();
    }
}
async function* iterateAnthropicEvents(response, signal) {
    if (!response.body) {
        throw new Error("Attempted to iterate over an Anthropic response with no body");
    }
    let sawMessageStart = false;
    let sawMessageEnd = false;
    for await (const sse of iterateSseMessages(response.body, signal)) {
        if (sse.event === "error") {
            throw new Error(sse.data);
        }
        if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
            continue;
        }
        try {
            const event = parseJsonWithRepair(sse.data);
            if (event.type === "message_start") {
                sawMessageStart = true;
            }
            else if (event.type === "message_stop") {
                sawMessageEnd = true;
            }
            yield event;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`);
        }
    }
    if (sawMessageStart && !sawMessageEnd) {
        throw new Error("Anthropic stream ended before message_stop");
    }
}
export const streamAnthropic = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    (async () => {
        const output = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
        };

        const externalSignal = options?.signal;
        const streamAbort = new AbortController();
        const abortGate = createThinkingAbortGate({
            timeoutMs: resolveThinkingAbortDeferTimeoutMs(),
            onForwardAbort: () => {
                if (!streamAbort.signal.aborted) {
                    streamAbort.abort(externalSignal?.reason);
                }
            },
        });
        const onExternalAbort = () => abortGate.requestAbort();
        if (externalSignal) {
            if (externalSignal.aborted) {
                abortGate.requestAbort();
            }
            else {
                externalSignal.addEventListener("abort", onExternalAbort);
            }
        }
        const effectiveSignal = externalSignal ? streamAbort.signal : undefined;
        try {
            let client;
            let isOAuth;
            let apiKey = "";
            let createRequestClient;
            if (options?.client) {
                client = options.client;
                isOAuth = false;
                createRequestClient = () => client;
            }
            else {
                apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
                let copilotDynamicHeaders;
                if (model.provider === "github-copilot") {
                    const hasImages = hasCopilotVisionInput(context.messages);
                    copilotDynamicHeaders = buildCopilotDynamicHeaders({
                        messages: context.messages,
                        hasImages,
                    });
                }
                const createForKey = (requestApiKey) => createClient(model, requestApiKey, options?.interleavedThinking ?? true, shouldUseFineGrainedToolStreamingBeta(model, context), options?.headers, copilotDynamicHeaders);
                const created = createForKey(apiKey);
                client = created.client;
                isOAuth = created.isOAuthToken;
                createRequestClient = (requestApiKey) => createForKey(requestApiKey).client;
            }
            let params = buildParams(model, context, isOAuth, options);
            const nextParams = await options?.onPayload?.(params, model);
            if (nextParams !== undefined) {
                params = nextParams;
            }
            const requestOptions = {
                ...(effectiveSignal ? { signal: effectiveSignal } : {}),
                ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
                ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
            };

            let response;
            let thinkingStripAttempts = 0;
            while (true) {
                try {
                    response = await requestWithAuthRefresh({
                        apiKey,
                        refreshApiKey: options?.client ? undefined : options?.refreshApiKey,
                        request: (requestApiKey) => createRequestClient(requestApiKey).messages.create({ ...params, stream: true }, requestOptions).asResponse(),
                    });
                    break;
                }
                catch (err) {
                    if (thinkingStripAttempts < MAX_THINKING_STRIP_RETRIES &&
                        isLatestAssistantThinkingModifiedError(err)) {
                        const stripped = stripThinkingFromLastAssistantParam(params.messages);
                        if (stripped) {
                            params = { ...params, messages: stripped };
                            thinkingStripAttempts++;
                            continue;
                        }
                    }
                    throw err;
                }
            }
            await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
            stream.push({ type: "start", partial: output });
            const blocks = output.content;
            for await (const event of iterateAnthropicEvents(response, effectiveSignal)) {
                if (event.type === "message_start") {
                    output.responseId = event.message.id;

                    output.usage.input = event.message.usage.input_tokens || 0;
                    output.usage.output = event.message.usage.output_tokens || 0;
                    output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
                    output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;

                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    calculateCost(model, output.usage);
                }
                else if (event.type === "content_block_start") {
                    if (event.content_block.type === "text") {
                        const block = {
                            type: "text",
                            text: "",
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
                    }
                    else if (event.content_block.type === "thinking") {
                        abortGate.openThinkingBlock();
                        const block = {
                            type: "thinking",
                            thinking: "",
                            thinkingSignature: "",
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
                    }
                    else if (event.content_block.type === "redacted_thinking") {
                        abortGate.openThinkingBlock();
                        const block = {
                            type: "thinking",
                            thinking: "[Reasoning redacted]",
                            thinkingSignature: event.content_block.data,
                            redacted: true,
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
                    }
                    else if (event.content_block.type === "tool_use") {
                        const block = {
                            type: "toolCall",
                            id: event.content_block.id,
                            name: isOAuth
                                ? fromClaudeCodeName(event.content_block.name, context.tools)
                                : event.content_block.name,
                            arguments: event.content_block.input ?? {},
                            partialJson: "",
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
                    }
                }
                else if (event.type === "content_block_delta") {
                    if (event.delta.type === "text_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "text") {
                            block.text += event.delta.text;
                            stream.push({
                                type: "text_delta",
                                contentIndex: index,
                                delta: event.delta.text,
                                partial: output,
                            });
                        }
                    }
                    else if (event.delta.type === "thinking_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "thinking") {
                            block.thinking += event.delta.thinking;
                            stream.push({
                                type: "thinking_delta",
                                contentIndex: index,
                                delta: event.delta.thinking,
                                partial: output,
                            });
                        }
                    }
                    else if (event.delta.type === "input_json_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "toolCall") {
                            block.partialJson += event.delta.partial_json;
                            block.arguments = parseStreamingJson(block.partialJson);
                            stream.push({
                                type: "toolcall_delta",
                                contentIndex: index,
                                delta: event.delta.partial_json,
                                partial: output,
                            });
                        }
                    }
                    else if (event.delta.type === "signature_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "thinking") {
                            block.thinkingSignature = block.thinkingSignature || "";
                            block.thinkingSignature += event.delta.signature;
                        }
                    }
                }
                else if (event.type === "content_block_stop") {
                    const index = blocks.findIndex((b) => b.index === event.index);
                    const block = blocks[index];
                    if (block) {
                        delete block.index;
                        if (block.type === "text") {
                            stream.push({
                                type: "text_end",
                                contentIndex: index,
                                content: block.text,
                                partial: output,
                            });
                        }
                        else if (block.type === "thinking") {

                            abortGate.closeThinkingBlock();
                            stream.push({
                                type: "thinking_end",
                                contentIndex: index,
                                content: block.thinking,
                                partial: output,
                            });
                        }
                        else if (block.type === "toolCall") {
                            block.arguments = parseStreamingJson(block.partialJson);

                            delete block.partialJson;
                            stream.push({
                                type: "toolcall_end",
                                contentIndex: index,
                                toolCall: block,
                                partial: output,
                            });
                        }
                    }
                }
                else if (event.type === "message_delta") {
                    if (event.delta.stop_reason) {
                        output.stopReason = mapStopReason(event.delta.stop_reason);

                        if (output.stopReason === "error" && !output.errorMessage) {
                            output.errorMessage = providerAbortedStopMessage(event.delta.stop_reason);
                        }
                    }

                    if (event.usage.input_tokens != null) {
                        output.usage.input = event.usage.input_tokens;
                    }
                    if (event.usage.output_tokens != null) {
                        output.usage.output = event.usage.output_tokens;
                    }
                    if (event.usage.cache_read_input_tokens != null) {
                        output.usage.cacheRead = event.usage.cache_read_input_tokens;
                    }
                    if (event.usage.cache_creation_input_tokens != null) {
                        output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
                    }

                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    calculateCost(model, output.usage);
                }
            }
            if (options?.signal?.aborted) {
                throw new Error("Request was aborted");
            }
            if (output.stopReason === "aborted" || output.stopReason === "error") {
                throw anomalousStreamStopError(output);
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
            for (const block of output.content) {
                delete block.index;

                delete block.partialJson;
            }
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
        finally {
            abortGate.dispose();
            if (externalSignal) {
                externalSignal.removeEventListener("abort", onExternalAbort);
            }
        }
    })();
    return stream;
};

const CLAUDE_FAMILY_VERSION_PATTERN = /claude[-.]([a-z]+)[-.](\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/;

export function supportsAdaptiveThinking(modelId) {
    const match = CLAUDE_FAMILY_VERSION_PATTERN.exec(modelId.toLowerCase());
    if (!match)
        return false;
    const family = match[1];
    const major = Number(match[2]);
    const minor = match[3] !== undefined ? Number(match[3]) : 0;
    if (major >= 5)
        return true;
    return (family === "opus" || family === "sonnet") && major === 4 && minor >= 6;
}

export function supportsDisablingThinking(modelId) {
    const match = CLAUDE_FAMILY_VERSION_PATTERN.exec(modelId.toLowerCase());
    if (!match)
        return true;
    return match[1] !== "fable";
}

function resolveModelIdForCapabilities(model) {
    const upstream = model
        .upstreamModelId;
    return typeof upstream === "string" && upstream.length > 0 ? upstream : model.id;
}

function mapThinkingLevelToEffort(model, level) {
    const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
    if (typeof mapped === "string")
        return mapped;
    switch (level) {
        case "minimal":
        case "low":
            return "low";
        case "medium":
            return "medium";
        case "high":
            return "high";
        default:
            return "high";
    }
}
export const streamSimpleAnthropic = (model, context, options) => {
    const apiKey = options?.apiKey || getEnvApiKey(model.provider);
    if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
    }
    const base = buildBaseOptions(model, options, apiKey);
    if (!options?.reasoning) {
        return streamAnthropic(model, context, { ...base, thinkingEnabled: false });
    }

    if (supportsAdaptiveThinking(resolveModelIdForCapabilities(model))) {
        const effort = mapThinkingLevelToEffort(model, options.reasoning);
        return streamAnthropic(model, context, {
            ...base,
            thinkingEnabled: true,
            effort,
        });
    }
    const adjusted = adjustMaxTokensForThinking(base.maxTokens || 0, model.maxTokens, options.reasoning, options.thinkingBudgets);
    return streamAnthropic(model, context, {
        ...base,
        maxTokens: adjusted.maxTokens,
        thinkingEnabled: true,
        thinkingBudgetTokens: adjusted.thinkingBudget,
    });
};
function isOAuthToken(apiKey) {
    return apiKey.includes("sk-ant-oat");
}
function createClient(model, apiKey, interleavedThinking, useFineGrainedToolStreamingBeta, optionsHeaders, dynamicHeaders) {

    const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinking(resolveModelIdForCapabilities(model));
    const betaFeatures = [];
    if (useFineGrainedToolStreamingBeta) {
        betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
    }
    if (needsInterleavedBeta) {
        betaFeatures.push(INTERLEAVED_THINKING_BETA);
    }
    if (model.provider === "cloudflare-ai-gateway") {
        const client = new Anthropic({
            apiKey: null,
            authToken: null,
            baseURL: resolveCloudflareBaseUrl(model),
            dangerouslyAllowBrowser: true,
            defaultHeaders: mergeHeaders({
                accept: "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                "cf-aig-authorization": `Bearer ${apiKey}`,
                "x-api-key": null,
                Authorization: null,
                ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
            }, model.headers, optionsHeaders),
        });
        return { client, isOAuthToken: false };
    }

    if (model.provider === "github-copilot") {
        const client = new Anthropic({
            apiKey: null,
            authToken: apiKey,
            baseURL: model.baseUrl,
            dangerouslyAllowBrowser: true,
            defaultHeaders: mergeHeaders({
                accept: "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
            }, model.headers, dynamicHeaders, optionsHeaders),
        });
        return { client, isOAuthToken: false };
    }

    if (isOAuthToken(apiKey)) {
        const client = new Anthropic({
            apiKey: null,
            authToken: apiKey,
            baseURL: model.baseUrl,
            dangerouslyAllowBrowser: true,
            defaultHeaders: mergeHeaders({
                accept: "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                "anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
                "user-agent": `claude-cli/${claudeCodeVersion}`,
                "x-app": "cli",
            }, model.headers, optionsHeaders),
        });
        return { client, isOAuthToken: true };
    }

    const isStellaRelay = typeof model.baseUrl === "string"
        && /\/api\/stella(?:\/|$)/i.test(model.baseUrl);
    if (isStellaRelay) {
        const client = new Anthropic({
            apiKey: null,
            authToken: apiKey,
            baseURL: model.baseUrl,
            dangerouslyAllowBrowser: true,
            defaultHeaders: mergeHeaders({
                accept: "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
            }, model.headers, optionsHeaders),
        });
        return { client, isOAuthToken: false };
    }

    const client = new Anthropic({
        apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        defaultHeaders: mergeHeaders({
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
        }, model.headers, optionsHeaders),
    });
    return { client, isOAuthToken: false };
}
function buildParams(model, context, isOAuthToken, options) {
    const { cacheControl } = getCacheControl(model, options?.cacheRetention);
    const compat = getAnthropicCompat(model);
    const normalizeToolName = isOAuthToken ? toClaudeCodeName : (name) => name;

    const uniqueTools = new Map();
    for (const tool of context.tools ?? []) {
        uniqueTools.set(normalizeToolName(tool.name), tool);
    }
    const immediateTools = [...uniqueTools.values()];
    const params = {
        model: model.id,
        messages: convertMessages(context.messages, model, isOAuthToken, cacheControl),
        max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
        stream: true,
    };

    if (isOAuthToken) {
        params.system = [
            {
                type: "text",
                text: "You are Claude Code, Anthropic's official CLI for Claude.",
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            },
        ];
        if (context.systemPrompt) {
            params.system.push({
                type: "text",
                text: sanitizeSurrogates(context.systemPrompt),
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            });
        }
    }
    else if (context.systemPrompt) {

        params.system = [
            {
                type: "text",
                text: sanitizeSurrogates(context.systemPrompt),
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            },
        ];
    }

    if (options?.temperature !== undefined && !options?.thinkingEnabled) {
        params.temperature = options.temperature;
    }
    if (immediateTools.length > 0) {
        params.tools = convertTools(immediateTools, isOAuthToken, compat.supportsEagerToolInputStreaming, cacheControl);
    }

    if (model.reasoning) {
        if (options?.thinkingEnabled) {

            const display = options.thinkingDisplay ?? "summarized";
            if (supportsAdaptiveThinking(resolveModelIdForCapabilities(model))) {

                params.thinking = { type: "adaptive", display };
                if (options.effort) {

                    params.output_config =
                        options.effort === "xhigh"
                            ? { effort: options.effort }
                            : { effort: options.effort };
                }
            }
            else {

                params.thinking = {
                    type: "enabled",
                    budget_tokens: options.thinkingBudgetTokens || 1024,
                    display,
                };
            }
        }
        else if (options?.thinkingEnabled === false &&
            supportsDisablingThinking(resolveModelIdForCapabilities(model))) {

            params.thinking = { type: "disabled" };
        }
    }
    if (options?.metadata) {
        const userId = options.metadata.user_id;
        if (typeof userId === "string") {
            params.metadata = { user_id: userId };
        }
    }
    if (options?.toolChoice) {
        if (typeof options.toolChoice === "string") {
            params.tool_choice = { type: options.toolChoice };
        }
        else {
            params.tool_choice = options.toolChoice;
        }
    }
    return params;
}

function normalizeToolCallId(id) {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

const MAX_THINKING_STRIP_RETRIES = 2;

const DEFAULT_THINKING_ABORT_DEFER_TIMEOUT_MS = 3_000;
function resolveThinkingAbortDeferTimeoutMs() {
    const raw = typeof process !== "undefined" ? process.env.STELLA_THINKING_ABORT_DEFER_TIMEOUT_MS?.trim() : undefined;
    if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 0)
            return parsed;
    }
    return DEFAULT_THINKING_ABORT_DEFER_TIMEOUT_MS;
}

export function createThinkingAbortGate(opts) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_THINKING_ABORT_DEFER_TIMEOUT_MS;
    const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle));
    let open = false;
    let pending = false;
    let forwarded = false;
    let timer;
    const clearPendingTimer = () => {
        if (timer !== undefined) {
            clearTimer(timer);
            timer = undefined;
        }
    };
    const forward = () => {
        if (forwarded)
            return;
        forwarded = true;
        pending = false;
        clearPendingTimer();
        opts.onForwardAbort();
    };
    return {
        requestAbort() {
            if (forwarded)
                return;
            if (open) {
                pending = true;
                if (timer === undefined) {
                    timer = setTimer(forward, timeoutMs);
                    timer.unref?.();
                }
                return;
            }
            forward();
        },
        openThinkingBlock() {
            open = true;
        },
        closeThinkingBlock() {
            open = false;
            if (pending)
                forward();
        },
        get isDeferring() {
            return pending && !forwarded;
        },
        dispose() {
            clearPendingTimer();
        },
    };
}

const THINKING_MODIFIED_ERROR_PATTERN = /blocks in the latest assistant message cannot be modified/i;

export function isLatestAssistantThinkingModifiedError(error) {
    if (!error || typeof error !== "object")
        return false;
    const parts = [];
    const anyErr = error;
    if (typeof anyErr.message === "string")
        parts.push(anyErr.message);
    const nested = anyErr.error;
    if (nested && typeof nested === "object") {
        if (typeof nested.message === "string")
            parts.push(nested.message);
        if (nested.error && typeof nested.error.message === "string")
            parts.push(nested.error.message);
        try {
            parts.push(JSON.stringify(nested));
        }
        catch {

        }
    }
    return parts.some((part) => THINKING_MODIFIED_ERROR_PATTERN.test(part));
}

export function stripThinkingFromLastAssistantParam(messages) {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
            idx = i;
            break;
        }
    }
    if (idx === -1)
        return null;
    const msg = messages[idx];
    if (!Array.isArray(msg.content))
        return null;
    const filtered = msg.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
    if (filtered.length === msg.content.length)
        return null;
    const next = messages.slice();
    if (filtered.length === 0) {
        next.splice(idx, 1);
    }
    else {
        next[idx] = { ...msg, content: filtered };
    }
    return next;
}

export function stripDanglingThinkingFromLatestAssistant(messages) {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
            idx = i;
            break;
        }
    }
    if (idx === -1)
        return messages;
    const assistant = messages[idx];
    if (!assistant.content.some((block) => block.type === "thinking"))
        return messages;

    let lastRealIdx = -1;
    for (let i = assistant.content.length - 1; i >= 0; i--) {
        if (assistant.content[i].type !== "thinking") {
            lastRealIdx = i;
            break;
        }
    }
    let changed = false;
    const nextContent = assistant.content.filter((block, i) => {
        if (block.type !== "thinking")
            return true;
        const thinking = block;

        if (i > lastRealIdx) {
            changed = true;
            return false;
        }

        if (!thinking.redacted && (!thinking.thinkingSignature || thinking.thinkingSignature.trim() === "")) {
            changed = true;
            return false;
        }
        return true;
    });
    if (!changed)
        return messages;
    const next = messages.slice();
    next[idx] = { ...assistant, content: nextContent };
    return next;
}

export function convertMessages(messages, model, isOAuthToken, cacheControl) {
    const params = [];

    const transformedMessages = stripDanglingThinkingFromLatestAssistant(transformMessages(messages, model, normalizeToolCallId));
    for (let i = 0; i < transformedMessages.length; i++) {
        const msg = transformedMessages[i];
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                if (msg.content.trim().length > 0) {
                    params.push({
                        role: "user",
                        content: sanitizeSurrogates(msg.content),
                    });
                }
            }
            else {
                const blocks = msg.content.map((item) => {
                    if (item.type === "text") {
                        return {
                            type: "text",
                            text: sanitizeSurrogates(item.text),
                        };
                    }
                    else {

                        const sanitized = sanitizeInlineImagePayload(item.data, item.mimeType);
                        if (!sanitized) {
                            return {
                                type: "text",
                                text: UNPROCESSABLE_IMAGE_NOTE,
                            };
                        }
                        return {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: sanitized.mediaType,
                                data: sanitized.data,
                            },
                        };
                    }
                });
                const filteredBlocks = blocks.filter((b) => {
                    if (b.type === "text") {
                        return b.text.trim().length > 0;
                    }
                    return true;
                });
                if (filteredBlocks.length === 0)
                    continue;
                params.push({
                    role: "user",
                    content: filteredBlocks,
                });
            }
        }
        else if (msg.role === "assistant") {
            const blocks = [];
            for (const block of msg.content) {
                if (block.type === "text") {
                    if (block.text.trim().length === 0)
                        continue;
                    blocks.push({
                        type: "text",
                        text: sanitizeSurrogates(block.text),
                    });
                }
                else if (block.type === "thinking") {

                    if (block.redacted) {
                        blocks.push({
                            type: "redacted_thinking",
                            data: block.thinkingSignature,
                        });
                        continue;
                    }
                    if (block.thinking.trim().length === 0)
                        continue;

                    if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
                        blocks.push({
                            type: "text",
                            text: sanitizeSurrogates(block.thinking),
                        });
                    }
                    else {
                        blocks.push({
                            type: "thinking",
                            thinking: sanitizeSurrogates(block.thinking),
                            signature: block.thinkingSignature,
                        });
                    }
                }
                else if (block.type === "toolCall") {
                    blocks.push({
                        type: "tool_use",
                        id: block.id,
                        name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
                        input: block.arguments ?? {},
                    });
                }
            }
            if (blocks.length === 0)
                continue;
            params.push({
                role: "assistant",
                content: blocks,
            });
        }
        else if (msg.role === "toolResult") {

            const toolResults = [convertToolResult(msg)];

            let j = i + 1;
            while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
                toolResults.push(convertToolResult(transformedMessages[j]));
                j++;
            }

            i = j - 1;

            params.push({
                role: "user",
                content: toolResults,
            });
        }
    }

    if (cacheControl && params.length > 0) {
        const lastMessage = params[params.length - 1];
        if (lastMessage.role === "user") {
            if (Array.isArray(lastMessage.content)) {
                const lastBlock = lastMessage.content[lastMessage.content.length - 1];
                if (lastBlock &&
                    (lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")) {
                    lastBlock.cache_control = cacheControl;
                }
            }
            else if (typeof lastMessage.content === "string") {
                lastMessage.content = [
                    {
                        type: "text",
                        text: lastMessage.content,
                        cache_control: cacheControl,
                    },
                ];
            }
        }
    }
    return params;
}
const convertToolResult = (msg) => ({
    type: "tool_result",
    tool_use_id: msg.toolCallId,
    content: convertContentBlocks(msg.content),
    is_error: msg.isError,
});
function shouldUseFineGrainedToolStreamingBeta(model, context) {
    return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}
export function convertTools(tools, isOAuthToken, supportsEagerToolInputStreaming, cacheControl) {
    if (!tools)
        return [];
    return tools.map((tool, index) => {
        const schema = normalizeProviderToolInputSchema(tool.parameters);
        return {
            name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
            description: tool.description,
            ...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
            input_schema: {
                ...schema,
            },
            ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
        };
    });
}
function mapStopReason(reason) {
    switch (reason) {
        case "end_turn":
            return "stop";
        case "max_tokens":
            return "length";
        case "tool_use":
            return "toolUse";
        case "refusal":
            return "error";
        case "pause_turn":
            return "stop";
        case "stop_sequence":
            return "stop";
        case "sensitive":
            return "error";
        default:

            return "stop";
    }
}
