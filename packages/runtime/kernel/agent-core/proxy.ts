/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 *
 * Effect-native internals (M5 surface 3): the SSE consumption runs as a
 * scoped effect on a module-level ManagedRuntime. The caller-owned
 * `AbortSignal` is bridged once into a Deferred latch (`abort-bridge.ts`):
 * a scoped watcher fiber cancels the body reader when the latch completes,
 * and the read loop consults the latch instead of polling `signal.aborted`.
 * The public surface (`streamProxy` returning a `ProxyMessageEventStream`
 * synchronously) and every terminal event payload — including the exact
 * `"Proxy error: …"` / `"Request aborted by user"` strings and the
 * aborted-vs-error reason split — are unchanged.
 */

import { Cause, Deferred, Effect, Layer, ManagedRuntime } from "effect";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	ToolCall,
} from "../../ai/types.js";
import { EventStream } from "../../ai/utils/event-stream.js";
import { parseStreamingJson } from "../../ai/utils/json-parse.js";
import { acquireAbortLatch } from "./abort-bridge.js";

type StreamingToolCall = ToolCall & { partialJson?: string };

// Create stream class matching ProxyMessageEventStream
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

export interface ProxyStreamOptions extends SimpleStreamOptions {
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
}

/**
 * Requirements-free runtime for the proxy delivery pipelines (same
 * convention as `ai/stream.ts`: context rides in closures).
 */
const proxyStreamRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
export function streamProxy(model: Model<Api>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	// Initialize the partial message that we'll build up from events
	const partial: AssistantMessage = {
		role: "assistant",
		stopReason: "stop",
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
		timestamp: Date.now(),
	};

	void proxyStreamRuntime.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const abortLatch = yield* acquireAbortLatch(options.signal);
				let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

				// Latch watcher (legacy `abortHandler`): once the caller aborts,
				// cancel the body reader so the read loop drains and settles. The
				// fiber is scoped — interrupted automatically when the pipeline
				// finishes first.
				yield* Effect.forkScoped(
					Deferred.await(abortLatch).pipe(
						Effect.flatMap(() =>
							Effect.sync(() => {
								if (reader) {
									reader.cancel("Request aborted by user").catch(() => {});
								}
							}),
						),
					),
					{ startImmediately: true },
				);

				const consume = Effect.gen(function* () {
					// The raw caller signal still rides on fetch itself (seam
					// pass-through), so an abort during connection surfaces as
					// fetch's own rejection — exactly the legacy error text.
					const response = yield* Effect.tryPromise({
						try: () =>
							fetch(`${options.proxyUrl}/api/stream`, {
								method: "POST",
								headers: {
									Authorization: `Bearer ${options.authToken}`,
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									model,
									context,
									options: {
										temperature: options.temperature,
										maxTokens: options.maxTokens,
										reasoning: options.reasoning,
									},
								}),
								signal: options.signal,
							}),
						catch: (error) => error,
					});

					if (!response.ok) {
						let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
						const errorData = yield* Effect.promise(async () => {
							try {
								return (await response.json()) as { error?: string };
							} catch {
								// Couldn't parse error response
								return undefined;
							}
						});
						if (errorData?.error) {
							errorMessage = `Proxy error: ${errorData.error}`;
						}
						return yield* Effect.fail(new Error(errorMessage));
					}

					reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
					const decoder = new TextDecoder();
					let buffer = "";

					for (;;) {
						const boundReader = reader;
						const { done, value } = yield* Effect.tryPromise({
							try: () => boundReader.read(),
							catch: (error) => error,
						});
						if (done) break;

						if (Deferred.isDoneUnsafe(abortLatch)) {
							return yield* Effect.fail(new Error("Request aborted by user"));
						}

						// SSE parse + event projection; JSON/protocol failures fail
						// the pipeline and map to the terminal error event below.
						yield* Effect.try({
							try: () => {
								buffer += decoder.decode(value, { stream: true });
								const lines = buffer.split("\n");
								buffer = lines.pop() || "";

								for (const line of lines) {
									if (line.startsWith("data: ")) {
										const data = line.slice(6).trim();
										if (data) {
											const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
											const event = processProxyEvent(proxyEvent, partial);
											if (event) {
												stream.push(event);
											}
										}
									}
								}
							},
							catch: (error) => error,
						});
					}

					if (Deferred.isDoneUnsafe(abortLatch)) {
						return yield* Effect.fail(new Error("Request aborted by user"));
					}
				});

				yield* consume.pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							const error = Cause.squash(cause);
							const errorMessage = error instanceof Error ? error.message : String(error);
							const reason = Deferred.isDoneUnsafe(abortLatch) ? "aborted" : "error";
							partial.stopReason = reason;
							partial.errorMessage = errorMessage;
							stream.push({
								type: "error",
								reason,
								error: partial,
							});
						}),
					),
					Effect.ensuring(
						Effect.sync(() => {
							stream.end();
						}),
					),
				);
			}),
		),
	);

	return stream;
}

/**
 * Process a proxy event and update the partial message.
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };

		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start":
			{
				const toolCall: StreamingToolCall = {
					type: "toolCall",
					id: proxyEvent.id,
					name: proxyEvent.toolName,
					arguments: {},
					partialJson: "",
				};
				partial.content[proxyEvent.contentIndex] = toolCall;
			}
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				const streamingContent = content as StreamingToolCall;
				streamingContent.partialJson = `${streamingContent.partialJson ?? ""}${proxyEvent.delta}`;
				content.arguments = parseStreamingJson<Record<string, unknown>>(streamingContent.partialJson) || {};
				partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				delete (content as StreamingToolCall).partialJson;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			return { type: "error", reason: proxyEvent.reason, error: partial };

		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn("Unhandled proxy event type", _exhaustiveCheck);
			return undefined;
		}
	}
}
