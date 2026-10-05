/**
 * ChatGPT plan usage through Sign in with ChatGPT: the public Responses API
 * (`POST https://api.openai.com/v1/responses`) with the signed-in account's
 * OAuth access token as the bearer. On the owner's cloud the same adapter
 * points at the model gateway's native lane, which swaps in the cloud host's
 * token.
 *
 * Every request keeps the preview limits
 * (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations):
 * `store: false` and `stream: true` over HTTP, the whole history in `input`
 * (never `previous_response_id`), system guidance in `instructions`,
 * function tools only, and none of the unsupported fields (temperature,
 * max_output_tokens, metadata, ...). A response counts only once
 * `response.completed` arrives; a usage limit can still end it mid-stream as
 * `response.failed`.
 */
import type {
	Tool as OpenAITool,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

import {
	CHATGPT_SIWC,
	CHATGPT_USAGE_LIMIT_CODE,
	ChatGptError,
	chatGptErrorFrom,
} from "@stella/contracts/chatgpt-siwc";

import { iterateStream, scopedBodyChunks, sleepWithAbort } from "../effect-runtime.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../thinking-levels.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.js";
import { formatThrownValue } from "../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { anomalousStreamStopError } from "../utils/provider-stop.js";
import { requestWithAuthRefresh, subscriptionLimitOfError } from "./auth-refresh.js";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

/** Retries of a transient failure before the stream opens. */
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
/** Tool calls from these providers keep their Responses item ids. */
const RESPONSES_TOOL_CALL_PROVIDERS = new Set(["openai", "chatgpt", "opencode"]);

export interface ChatGptResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	textVerbosity?: "low" | "medium" | "high";
}

export interface ChatGptRequestBody {
	model: string;
	store: false;
	stream: true;
	instructions: string;
	input: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: "auto";
	parallel_tool_calls?: boolean;
	reasoning?: { effort?: string; summary?: string };
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	sleepWithAbort(ms, signal, () => new Error("Request was aborted"));

// ============================================================================
// Request
// ============================================================================

export const resolveChatGptReasoningEffort = (
	model: Model<"chatgpt-responses">,
	requested: ModelThinkingLevel | undefined,
): ChatGptResponsesOptions["reasoningEffort"] => {
	if (!requested) return undefined;
	const supported = getSupportedThinkingLevels(model);
	const effectiveRequest = requested === "off" && !supported.includes("off") ? "low" : requested;
	const clamped = clampThinkingLevel(model, effectiveRequest);
	return clamped === "off" ? "none" : clamped;
};

export function buildChatGptRequestBody(
	model: Model<"chatgpt-responses">,
	context: Context,
	options?: ChatGptResponsesOptions,
): ChatGptRequestBody {
	// System guidance goes in `instructions`: the route rejects system-role
	// message items, so any that conversion produced become developer ones.
	const input = convertResponsesMessages(model, context, RESPONSES_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
	}).map((item) =>
		"role" in item && item.role === "system" ? ({ ...item, role: "developer" } as typeof item) : item,
	);
	// Dedupe by name — last definition wins, matching historical behavior.
	const uniqueTools = [...new Map((context.tools ?? []).map((tool) => [tool.name, tool])).values()];

	const body: ChatGptRequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt || "You are a helpful assistant.",
		input,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		tool_choice: "auto",
		parallel_tool_calls: true,
	};
	if (options?.sessionId) body.prompt_cache_key = options.sessionId;
	if (uniqueTools.length > 0) {
		body.tools = convertResponsesTools(uniqueTools, { strict: null });
	}
	if (options?.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? (model.thinkingLevelMap?.off ?? "none")
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		if (effort !== null) {
			body.reasoning = { effort, summary: options.reasoningSummary ?? "auto" };
		}
	}
	return body;
}

/** `<base>/responses`; the public API unless the model points at the gateway. */
const responsesUrl = (baseUrl?: string): string =>
	`${(baseUrl?.trim() || CHATGPT_SIWC.apiBaseUrl).replace(/\/+$/u, "")}/responses`;

/** A ChatGPT verdict keeps its code in the text, for overflow and limit detection. */
const withCode = (error: ChatGptError): ChatGptError => {
	if (error.code === "api_error" || error.message.includes(error.code)) return error;
	return new ChatGptError(error.code, `${error.message} (${error.code})`, error.retryable, error.status);
};

/** Pre-stream failures that may clear on their own. */
const isRetryable = (error: ChatGptError): boolean =>
	error.retryable && error.code !== CHATGPT_USAGE_LIMIT_CODE;

// ============================================================================
// Stream
// ============================================================================

export const streamChatGptResponses: StreamFunction<"chatgpt-responses", ChatGptResponsesOptions> = (
	model: Model<"chatgpt-responses">,
	context: Context,
	options?: ChatGptResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "chatgpt-responses" as Api,
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
			// A response is successful only after `response.completed`.
			stopReason: "error",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error("Sign in with ChatGPT to use ChatGPT models.");
			}
			let body: unknown = buildChatGptRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) body = nextBody;
			const bodyJson = JSON.stringify(body);
			const url = responsesUrl(model.baseUrl);

			const request = async (bearer: string): Promise<Response> => {
				for (let attempt = 0; ; attempt++) {
					if (options?.signal?.aborted) throw new Error("Request was aborted");
					const headers = new Headers(model.headers);
					for (const [key, value] of Object.entries(options?.headers ?? {})) headers.set(key, value);
					headers.set("authorization", `Bearer ${bearer}`);
					headers.set("content-type", "application/json");
					headers.set("accept", "text/event-stream");
					let response: Response;
					try {
						response = await (model.fetch ?? fetch)(url, {
							method: "POST",
							headers,
							body: bodyJson,
							signal: options?.signal,
						});
					} catch (error) {
						if (options?.signal?.aborted) throw new Error("Request was aborted");
						if (attempt < MAX_RETRIES) {
							await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
							continue;
						}
						throw error instanceof Error ? error : new Error(formatThrownValue(error));
					}
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);
					if (response.ok) return response;
					const text = await response.text().catch(() => "");
					let parsed: unknown;
					try {
						parsed = JSON.parse(text);
					} catch {
						parsed = undefined;
					}
					const error = withCode(chatGptErrorFrom(parsed, response.status));
					if (attempt < MAX_RETRIES && isRetryable(error)) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}
					throw error;
				}
			};

			// One refreshed-credential retry on 401, or one retry on another
			// account after a usage limit, before any event is exposed.
			const response = await requestWithAuthRefresh({
				apiKey,
				refreshApiKey: options?.refreshApiKey,
				onSubscriptionLimit: options?.onSubscriptionLimit,
				request,
			});
			if (!response.body) throw new Error("ChatGPT returned no response stream.");

			stream.push({ type: "start", partial: output });
			try {
				await processResponsesStream(mapEvents(parseSSE(response)), output, stream, model);
			} catch (error) {
				// A usage limit that ends a started stream can't be retried here;
				// still cool the account down so the next request uses another.
				const onLimit = options?.onSubscriptionLimit;
				const limit = onLimit ? subscriptionLimitOfError(error) : null;
				if (onLimit && limit) await Promise.resolve().then(() => onLimit(limit)).catch(() => undefined);
				throw error;
			}

			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw anomalousStreamStopError(output);
			}
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleChatGptResponses: StreamFunction<"chatgpt-responses", SimpleStreamOptions> = (
	model: Model<"chatgpt-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error("Sign in with ChatGPT to use ChatGPT models.");
	}
	// The request body never carries temperature or an output limit: the
	// route rejects both.
	const base = buildBaseOptions(model, options, apiKey);
	return streamChatGptResponses(model, context, {
		...base,
		reasoningEffort: resolveChatGptReasoningEffort(model, options?.disableReasoning ? "off" : options?.reasoning),
	} satisfies ChatGptResponsesOptions);
};

// ============================================================================
// Events
// ============================================================================

/**
 * Responses events, with failures turned into ChatGPT errors that carry the
 * provider's code (`subscription_sharing_usage_limit_exceeded` mid-stream,
 * `context_length_exceeded`, ...).
 */
async function* mapEvents(events: AsyncIterable<Record<string, unknown>>): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;
		if (type === "error" || type === "response.failed") {
			const failure =
				type === "response.failed" && event.response && typeof event.response === "object"
					? ((event.response as Record<string, unknown>).error ?? event.response)
					: event;
			throw withCode(chatGptErrorFrom({ error: failure }));
		}
		yield event as unknown as ResponseStreamEvent;
		if (type === "response.completed" || type === "response.incomplete") return;
	}
}

/** Server-sent events: LF, CRLF or CR line endings; `data:` lines joined. */
async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;
	const decoder = new TextDecoder();
	let buffer = "";
	let pendingCr = false;
	const parseFrames = function* (): Generator<Record<string, unknown>> {
		let index = buffer.indexOf("\n\n");
		while (index !== -1) {
			const chunk = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const data = chunk
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /u, ""))
				.join("\n")
				.trim();
			if (data && data !== "[DONE]") {
				try {
					yield JSON.parse(data) as Record<string, unknown>;
				} catch (cause) {
					throw new Error(`ChatGPT sent an invalid stream event: ${formatThrownValue(cause)}`);
				}
			}
			index = buffer.indexOf("\n\n");
		}
	};
	const append = (text: string, final: boolean) => {
		let next = (pendingCr ? "\r" : "") + text;
		pendingCr = !final && next.endsWith("\r");
		if (pendingCr) next = next.slice(0, -1);
		buffer += next.replace(/\r\n?/gu, "\n");
	};
	for await (const value of iterateStream(scopedBodyChunks(response.body))) {
		append(decoder.decode(value, { stream: true }), false);
		yield* parseFrames();
	}
	// EOF terminates the residual frame.
	append(decoder.decode(), true);
	if (buffer.trim()) {
		buffer += "\n\n";
		yield* parseFrames();
	}
}
