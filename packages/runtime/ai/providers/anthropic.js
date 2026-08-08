import Anthropic from "@anthropic-ai/sdk";
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import { sanitizeInlineImagePayload } from "../utils/image-payload.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.js";
import { anomalousStreamStopError, providerAbortedStopMessage } from "../utils/provider-stop.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { requestWithAuthRefresh } from "./auth-refresh.js";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";
/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
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
// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.75";
// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
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
// Convert tool name to CC canonical casing if it matches (case-insensitive)
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
/**
 * Substituted for an image block that cannot be sent as a valid Anthropic
 * base64 source (corrupt/truncated, unsupported format, or oversized). Keeping
 * a short note preserves turn structure without failing the whole request.
 */
const UNPROCESSABLE_IMAGE_NOTE = "[Image omitted: it could not be decoded as a valid image and was skipped.]";
/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content) {
    // If only text blocks, return as concatenated string for simplicity
    const hasImages = content.some((c) => c.type === "image");
    if (!hasImages) {
        return sanitizeSurrogates(content.map((c) => c.text).join("\n"));
    }
    // If we have images, convert to content block array
    const blocks = content.map((block) => {
        if (block.type === "text") {
            return {
                type: "text",
                text: sanitizeSurrogates(block.text),
            };
        }
        // Validate/repair the inline image before it reaches the wire. A
        // truncated or corrupt tool-produced image (e.g. a screenshot captured
        // mid-write) has clean base64 and a parseable header, so it slips
        // through attach-time checks, but Anthropic decodes it server-side and
        // fails the *entire* request with `400 "Could not process image"`.
        // Since the bad block is persisted in history, every resume re-fails.
        // Drop unprocessable images and leave a note instead of poisoning the
        // request; valid images (incl. every user-attached one) pass untouched.
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
    // If only images (no text), add placeholder text block
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
        // Close the transport exactly once on every exit path. An early
        // consumer exit (error/break mid-iteration without an abort) would
        // otherwise leave the response body — and its connection — open
        // until GC; cancel on an already-finished stream is a no-op. Same
        // pattern as openai-codex-responses.
        try {
            await reader.cancel();
        }
        catch {
            // The stream may already be closed or errored.
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
        // Boundary-aware interrupt: when an external abort lands while the model is
        // mid thinking block, hold the teardown until the block seals so we never
        // truncate a thinking block on the wire (which corrupts Anthropic threads).
        // The gate forwards the abort into `streamAbort` (which drives both the HTTP
        // request and the SSE reader) either at the next thinking-block-close or
        // after a bounded timeout. An abort outside a thinking block forwards
        // immediately. Declared outside the try so the finally can dispose it.
        //
        // Consequence: when an abort lands mid-thinking, teardown (and therefore
        // the start of the next turn) can lag by up to the defer timeout
        // (STELLA_THINKING_ABORT_DEFER_TIMEOUT_MS) while we wait for the block to
        // seal — an intentional trade for not corrupting the thread.
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
            // Reactive safety net for the Anthropic "thinking blocks in the latest
            // assistant message cannot be modified" 400. Interrupting a turn
            // mid-reasoning (send_input / follow-up while the assistant is thinking)
            // can leave a modified/partial thinking block in the latest assistant
            // message; convertMessages strips dangling ones preemptively, but if a
            // modified block still slips through, drop the most-recent thinking /
            // redacted_thinking block(s) from the offending message and retry.
            // Bounded so a persistent 400 can never loop forever.
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
                    // Capture initial token usage from message_start event
                    // This ensures we have input token counts even if the stream is aborted early
                    output.usage.input = event.message.usage.input_tokens || 0;
                    output.usage.output = event.message.usage.output_tokens || 0;
                    output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
                    output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
                    // Anthropic doesn't provide total_tokens, compute from components
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
                            // The thinking block is now sealed/signed and replay-safe: this is
                            // the clean boundary at which a deferred interrupt may be applied.
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
                            // Finalize in-place and strip the scratch buffer so replay only
                            // carries parsed arguments.
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
                        // Preserve the raw provider stop reason (refusal/sensitive/etc.)
                        // so the surfaced error explains WHY the stream died instead of
                        // collapsing into an opaque "unknown error".
                        if (output.stopReason === "error" && !output.errorMessage) {
                            output.errorMessage = providerAbortedStopMessage(event.delta.stop_reason);
                        }
                    }
                    // Only update usage fields if present (not null).
                    // Preserves input_tokens from message_start when proxies omit it in message_delta.
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
                    // Anthropic doesn't provide total_tokens, compute from components
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
                // partialJson is only a streaming scratch buffer; never persist it.
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
/**
 * Matches new-style Claude ids: `claude-<family>-<major>[.-<minor>]`, with or
 * without a date/revision suffix (e.g. `claude-sonnet-4-5-20250929`,
 * `us.anthropic.claude-opus-4-6`, `claude-fable-5`). Major/minor are capped at
 * two digits with a trailing digit guard so date suffixes (`-20241022`) never
 * parse as versions; old-style ids like `claude-3-5-sonnet-*` (version before
 * family) intentionally don't match and fall back to the legacy shape.
 */
const CLAUDE_FAMILY_VERSION_PATTERN = /claude[-.]([a-z]+)[-.](\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/;
/**
 * Check if a model requires the adaptive thinking request shape
 * (`thinking.type=adaptive` + `output_config.effort`) rather than the legacy
 * budget-based `thinking.type=enabled`:
 * - Every 5-generation (or later) Claude model (fable-5, sonnet-5, ...) —
 *   these reject `thinking.type=enabled` with a 400.
 * - Opus and Sonnet 4.6+ — adaptive since 4.6.
 * Older models (haiku 3.x/4.5, sonnet ≤4.5, opus ≤4.5) keep the legacy shape.
 */
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
/**
 * Check if a model accepts `thinking.type=disabled`.
 *
 * Fable-family models reject it with a 400 ("\"thinking.type.disabled\" is not
 * supported for this model. Thinking defaults to adaptive"): thinking cannot
 * be turned off on Fable, only left to the adaptive default. This silently
 * broke every no-reasoning `completeSimple` call (thread compaction summaries,
 * utility passes) the moment `stella/max` remapped to `claude-fable-5`
 * upstream. For these models the `thinking` param must be omitted entirely.
 */
export function supportsDisablingThinking(modelId) {
    const match = CLAUDE_FAMILY_VERSION_PATTERN.exec(modelId.toLowerCase());
    if (!match)
        return true;
    return match[1] !== "fable";
}
/**
 * Resolve the upstream model id to use for capability checks.
 *
 * The Stella relay sets `model.id` to the user-facing model alias
 * (e.g. `stella/designer`) so persisted records / UI keep the alias
 * shape; the actual upstream model slug is stashed on
 * `model.upstreamModelId`. Using only `model.id` here would route the
 * `designer` alias (which resolves to Opus 4.7) through the budget-based
 * thinking branch, and Opus 4.7 rejects `thinking.type=enabled`.
 */
function resolveModelIdForCapabilities(model) {
    const upstream = model
        .upstreamModelId;
    return typeof upstream === "string" && upstream.length > 0 ? upstream : model.id;
}
/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6, while Opus 4.7 supports "xhigh".
 */
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
    // For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
    // For older models: use budget-based thinking
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
    // Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
    // The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
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
    // Copilot: Bearer auth, selective betas.
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
    // OAuth: Bearer auth, Claude Code identity headers
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
    // Stella-relay auth: send the Stella JWT as `Authorization: Bearer ...`
    // (what the Convex relay reads), not Anthropic's native `x-api-key`.
    // Use the SDK's `authToken` constructor option so the SDK doesn't ALSO
    // emit `x-api-key` carrying the Stella token — same pattern as the
    // OAuth branch above. Detect the relay by baseUrl rather than a
    // sentinel header so a missing/renamed header never silently falls
    // back to anthropic-native auth against the relay (which would 401).
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
    // API key auth (native Anthropic / compatible direct-provider)
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
    // Dedupe by normalized name (OAuth tokens rewrite names, which can
    // collapse two catalog entries onto one wire name — last one wins).
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
    // For OAuth tokens, we MUST include Claude Code identity
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
        // Add cache control to system prompt for non-OAuth tokens
        params.system = [
            {
                type: "text",
                text: sanitizeSurrogates(context.systemPrompt),
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            },
        ];
    }
    // Temperature is incompatible with extended thinking (adaptive or budget-based).
    if (options?.temperature !== undefined && !options?.thinkingEnabled) {
        params.temperature = options.temperature;
    }
    if (immediateTools.length > 0) {
        params.tools = convertTools(immediateTools, isOAuthToken, compat.supportsEagerToolInputStreaming, cacheControl);
    }
    // Configure thinking mode: adaptive (Opus 4.6+ and Sonnet 4.6),
    // budget-based (older models), or explicitly disabled.
    if (model.reasoning) {
        if (options?.thinkingEnabled) {
            // Default to "summarized" so Opus 4.7 and Mythos Preview behave like
            // older Claude 4 models (whose API default is also "summarized").
            const display = options.thinkingDisplay ?? "summarized";
            if (supportsAdaptiveThinking(resolveModelIdForCapabilities(model))) {
                // Adaptive thinking: Claude decides when and how much to think.
                params.thinking = { type: "adaptive", display };
                if (options.effort) {
                    // The Anthropic SDK types can lag newly supported effort values such as "xhigh".
                    params.output_config =
                        options.effort === "xhigh"
                            ? { effort: options.effort }
                            : { effort: options.effort };
                }
            }
            else {
                // Budget-based thinking for older models
                params.thinking = {
                    type: "enabled",
                    budget_tokens: options.thinkingBudgetTokens || 1024,
                    display,
                };
            }
        }
        else if (options?.thinkingEnabled === false &&
            supportsDisablingThinking(resolveModelIdForCapabilities(model))) {
            // Models that can't disable thinking (Fable) 400 on this shape;
            // omitting the param leaves them on their adaptive default instead.
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
// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id) {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
/**
 * Max attempts to strip modified `thinking`/`redacted_thinking` blocks from the
 * latest assistant message and retry after Anthropic rejects the request with
 * "thinking blocks in the latest assistant message cannot be modified".
 */
const MAX_THINKING_STRIP_RETRIES = 2;
/**
 * Default bound (ms) on how long an external abort waits for an in-flight
 * Anthropic thinking block to seal before it is forced through anyway. Kept
 * short so a runaway reasoning block can't wedge user input; on timeout the
 * stream tears down and the strip-on-build / retry safety nets cover the
 * truncated block. Overridable via STELLA_THINKING_ABORT_DEFER_TIMEOUT_MS.
 *
 * 3s: thinking blocks seal quickly, so a modest bound keeps a fresh turn
 * snappy after an interrupt while still letting the common case reach the
 * clean block-close boundary.
 */
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
/**
 * Boundary-aware interrupt gate for the Anthropic stream.
 *
 * Anthropic streams reasoning as discrete content blocks that only become
 * replay-safe once sealed (signed). Tearing the stream down in the middle of an
 * open thinking block leaves a modified/partial block that corrupts the thread
 * (400 "thinking blocks ... cannot be modified"). This gate holds an external
 * abort that lands mid-block until the block closes, then forwards it at that
 * clean boundary. A bounded timeout forces the abort through anyway so a
 * runaway block can't wedge user input — in that case teardown proceeds and the
 * strip-on-build / retry safety nets cover the truncated block. An abort that
 * lands outside a thinking block is forwarded immediately.
 */
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
/** Matches Anthropic's 400 for a modified thinking block in the latest turn. */
const THINKING_MODIFIED_ERROR_PATTERN = /blocks in the latest assistant message cannot be modified/i;
/**
 * True when the error is Anthropic's "`thinking` or `redacted_thinking` blocks
 * in the latest assistant message cannot be modified" 400. The SDK surfaces
 * this as an APIError whose message and nested `error` payload carry the text.
 */
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
            // ignore non-serializable payloads
        }
    }
    return parts.some((part) => THINKING_MODIFIED_ERROR_PATTERN.test(part));
}
/**
 * Reactive strip: remove `thinking`/`redacted_thinking` blocks from the latest
 * assistant message in an already-built Anthropic payload, then return the new
 * message array (or null if nothing changed). If the assistant turn was made up
 * only of thinking, the whole (now-empty) message is dropped to avoid an empty
 * content error — safe because the following user/injected turn drives the run.
 */
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
/**
 * Preventive strip: clear dangling / incomplete `thinking` blocks from the
 * latest assistant message before it is serialized to the Anthropic API.
 *
 * Interrupting a turn mid-reasoning (send_input / follow-up while the assistant
 * is thinking) can leave the latest assistant message with a thinking block that
 * is either trailing (a completed turn always ends in text or a tool call, never
 * a bare thinking block) or incomplete (no signature, so it cannot be replayed
 * verbatim and would be re-encoded — i.e. "modified"). Either shape trips
 * Anthropic's "thinking blocks ... cannot be modified" 400, so we drop them
 * rather than send them. Verbatim, signed thinking that precedes real content
 * (e.g. thinking + tool_use) is preserved untouched, as Anthropic requires.
 *
 * Only the latest assistant message is touched; earlier turns keep their
 * existing handling in convertMessages.
 */
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
    // Index of the last non-thinking ("real") block. Anything after it is a
    // dangling thinking block left by a mid-reasoning interruption.
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
        // Trailing thinking block (or thinking-only turn): dangling interruption.
        if (i > lastRealIdx) {
            changed = true;
            return false;
        }
        // Incomplete: non-redacted thinking without a signature cannot be replayed
        // verbatim and would be re-encoded on the wire.
        //
        // We intentionally DROP this mid-thought reasoning for the interrupted
        // latest turn rather than keep it. This differs on purpose from
        // convertMessages, which downgrades an unsigned thinking block on an
        // *earlier* turn to a plain text block (preserving the words as context).
        // Here the block belongs to the turn the interrupt just cut, so keeping
        // it as thinking would trip Anthropic's "thinking blocks ... cannot be
        // modified" 400; discarding it is what makes the next turn clean. Don't
        // "fix" this into a text-preserving path — that reintroduces the 400.
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
// Exported for tests: asserts the outgoing Anthropic request shape, including
// validation/repair of tool-produced image blocks.
export function convertMessages(messages, model, isOAuthToken, cacheControl) {
    const params = [];
    // Transform messages for cross-provider compatibility
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
                        // Same validation/repair as the tool-result path: a
                        // complete, supported image passes through untouched;
                        // an unprocessable one is dropped with a note so a
                        // single bad block can't fail the whole request.
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
                    // Redacted thinking: pass the opaque payload back as redacted_thinking
                    if (block.redacted) {
                        blocks.push({
                            type: "redacted_thinking",
                            data: block.thinkingSignature,
                        });
                        continue;
                    }
                    if (block.thinking.trim().length === 0)
                        continue;
                    // If thinking signature is missing/empty (e.g., from aborted stream),
                    // convert to plain text block without <thinking> tags to avoid API rejection
                    // and prevent Claude from mimicking the tags in responses
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
            // Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
            const toolResults = [convertToolResult(msg)];
            // Look ahead for consecutive toolResult messages
            let j = i + 1;
            while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
                toolResults.push(convertToolResult(transformedMessages[j]));
                j++;
            }
            // Skip the messages we've already processed
            i = j - 1;
            // Add a single user message with all tool results
            params.push({
                role: "user",
                content: toolResults,
            });
        }
    }
    // Add cache_control to the last user message to cache conversation history
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
        const schema = structuredClone(tool.parameters);
        // Anthropic requires every tool input schema to be a root object and
        // rejects root combinators even when `type: "object"` is also present.
        // Stella still validates the full original schema before execution.
        delete schema.oneOf;
        delete schema.allOf;
        delete schema.anyOf;
        return {
            name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
            description: tool.description,
            ...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
            input_schema: {
                ...schema,
                type: "object",
                properties: schema.properties ?? {},
                required: schema.required ?? [],
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
        case "pause_turn": // Stop is good enough -> resubmit
            return "stop";
        case "stop_sequence":
            return "stop"; // We don't supply stop sequences, so this should never happen
        case "sensitive": // Content flagged by safety filters (not yet in SDK types)
            return "error";
        default:
            // Handle unknown stop reasons gracefully (API may add new values).
            // A fully-streamed message shouldn't collapse into an error just
            // because Anthropic introduced a new terminal stop_reason, so treat
            // it as a normal completion.
            return "stop";
    }
}
