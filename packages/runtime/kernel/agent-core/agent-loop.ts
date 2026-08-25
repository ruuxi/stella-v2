/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 *
 * Effect-native core (M5 surface 3): the turn loop itself runs as Effect
 * fibers on one module-level ManagedRuntime. The public surface is a plain
 * TS/Promise facade with the exact pre-Effect names, signatures, event
 * ordering, and error strings:
 *
 * - The turn loop body is `Effect.gen`; provider streaming is consumed as an
 *   Effect `Stream` (`Stream.fromAsyncIterable` over the `streamFn` seam,
 *   which still yields AsyncIterables).
 * - The caller-owned `AbortSignal` is bridged ONCE into a `Deferred` latch
 *   (`abort-bridge.ts`); cancellation of tool windows and the post-abort
 *   abandonment grace race that latch instead of listener/`finally`
 *   plumbing. The raw signal object still flows unchanged through the
 *   caller-facing seams (`streamFn` options, hook callbacks), because the
 *   cancel path is deliberately cooperative: the provider terminates with an
 *   "aborted" assistant message and the loop emits its normal terminal
 *   events (`turn_end` → `agent_end`) — interrupting the loop fiber itself
 *   would break that observable ordering.
 * - Tool-call execution windows are scoped effects: the inactivity watchdog
 *   and abort-grace timers are fibers forked into the window's scope, so
 *   scope close (any exit path) replaces the old `clearTimeout` + `finally`
 *   bookkeeping, and losing race arms are fiber-interrupted.
 * - Failures escape the facades via `Cause.squash`, so callers observe the
 *   byte-identical original errors; loop-owned errors are
 *   `Schema.TaggedErrorClass`es carrying the exact legacy strings
 *   (`errors.ts`).
 */

import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	ManagedRuntime,
	Stream,
} from "effect";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ToolResultMessage,
} from "../../ai/types.js";
import { streamSimple } from "../../ai/stream.js";
import { EventStream } from "../../ai/utils/event-stream.js";
import { isContextOverflow } from "../../ai/utils/overflow.js";
import { validateToolArguments } from "../../ai/utils/validation.js";
import { acquireAbortLatch } from "./abort-bridge.js";
import {
	AgentContinueEmptyContextError,
	AgentContinueFromAssistantError,
	ToolAbortAbandonedError,
	ToolInactivityTimeoutError,
} from "./errors.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * True when an assistant message looks like an upstream pathology:
 * the model terminated but produced neither user-visible text nor a
 * tool call. Covers two flavors:
 *  - `stopReason: "stop"` with only thinking content — Kimi K2 family
 *    pathology where the model self-terminates after burning its
 *    reasoning trace.
 *  - `stopReason: "length"` with no usable output — provider-side
 *    truncation that hit a cap before any visible text was emitted
 *    (e.g. a reasoning model that exhausted the combined cap during
 *    thinking).
 * Reasoning-only `thinking` blocks do not count as a usable result.
 */
const isDegenerateAssistantMessage = (
	message: AssistantMessage | null,
): boolean => {
	if (!message) return false;
	if (message.stopReason !== "stop" && message.stopReason !== "length") {
		return false;
	}
	let hasText = false;
	let hasToolCall = false;
	for (const part of message.content) {
		if (part.type === "text" && part.text.trim().length > 0) {
			hasText = true;
			break;
		}
		if (part.type === "toolCall") {
			hasToolCall = true;
			break;
		}
	}
	return !hasText && !hasToolCall;
};

/**
 * Requirements-free runtime for the loop fibers (house convention: one
 * module-level ManagedRuntime, context rides in closures — never a
 * per-call `Effect.runPromise`).
 */
const agentLoopRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a loop Effect on the shared runtime, rejecting with the ORIGINAL
 * failure object. `Cause.squash` recovers the error the effect failed or
 * died with, so callbacks that throw (emit sinks, `afterToolCall`, a
 * misbehaving `streamFn`) surface to callers byte-identically to the
 * pre-Effect loop.
 */
const runLoopPromise = async <A>(
	effect: Effect.Effect<A, unknown>,
): Promise<A> => {
	const exit = await agentLoopRuntime.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) {
		return exit.value;
	}
	throw Cause.squash(exit.cause);
};

/** Emit one agent event through the caller's sink, awaited in order. */
const emitEvent = (
	emit: AgentEventSink,
	event: AgentEvent,
): Effect.Effect<void> =>
	Effect.promise(() => Promise.resolve(emit(event)));

/**
 * Everything one loop run carries. The mutable `currentContext.messages` /
 * `newMessages` arrays are shared with the facade caller exactly as before —
 * the loop is the single writer while it runs.
 */
type LoopEnv = {
	currentContext: AgentContext;
	newMessages: AgentMessage[];
	config: AgentLoopConfig;
	/** Caller-owned signal; passed through to caller-facing seams verbatim. */
	signal: AbortSignal | undefined;
	/** The one Effect-side view of `signal` (see abort-bridge.ts). */
	abortLatch: Deferred.Deferred<unknown>;
	emit: AgentEventSink;
	streamFn?: StreamFn;
};

/**
 * Start an agent loop with new prompt messages and expose emitted events as a stream.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context and expose emitted events as a stream.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new AgentContinueEmptyContextError();
	}

	if (context.messages[context.messages.length - 1]?.role === "assistant") {
		throw new AgentContinueFromAssistantError();
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	return runLoopPromise(
		Effect.scoped(
			Effect.gen(function* () {
					const abortLatch = yield* acquireAbortLatch(signal);
					const newMessages: AgentMessage[] = [...prompts];
					// Reuse the caller's context object so a later boundary replacement releases
					// its pre-compaction history reference during a normal prompt run too.
					const currentContext = context;
					currentContext.messages = [...currentContext.messages, ...prompts];

				yield* emitEvent(emit, { type: "agent_start" });
				yield* emitEvent(emit, { type: "turn_start" });
				for (const prompt of prompts) {
					yield* emitEvent(emit, { type: "message_start", message: prompt });
					yield* emitEvent(emit, { type: "message_end", message: prompt });
				}

				yield* runLoop({
					currentContext,
					newMessages,
					config,
					signal,
					abortLatch,
					emit,
					streamFn,
				});
				return newMessages;
			}),
		),
	);
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new AgentContinueEmptyContextError();
	}

	if (context.messages[context.messages.length - 1]?.role === "assistant") {
		throw new AgentContinueFromAssistantError();
	}

	return runLoopPromise(
		Effect.scoped(
			Effect.gen(function* () {
					const abortLatch = yield* acquireAbortLatch(signal);
					const newMessages: AgentMessage[] = [];
					// Keep one context object so a boundary replacement also releases the
					// caller's reference to the pre-compaction message array.
					const currentContext = context;

				yield* emitEvent(emit, { type: "agent_start" });
				yield* emitEvent(emit, { type: "turn_start" });

				yield* runLoop({
					currentContext,
					newMessages,
					config,
					signal,
					abortLatch,
					emit,
					streamFn,
				});
				return newMessages;
			}),
		),
	);
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/** Poll the steering seam; `[]` when absent or empty (legacy `|| []`). */
const pollSteeringMessages = (
	config: AgentLoopConfig,
): Effect.Effect<AgentMessage[]> =>
	Effect.promise(async () => (await config.getSteeringMessages?.()) || []);

/** Poll the follow-up seam; `[]` when absent or empty (legacy `|| []`). */
const pollFollowUpMessages = (
	config: AgentLoopConfig,
): Effect.Effect<AgentMessage[]> =>
	Effect.promise(async () => (await config.getFollowUpMessages?.()) || []);

/**
 * Main loop logic shared by the agent loop entrypoints.
 *
 * Emission order is observable by the desktop UI and preserved exactly:
 * turn_start → [steering message_start/message_end]* → assistant streaming →
 * tool events → turn_end → (steering | follow-up | agent_end).
 */
const runLoop = (env: LoopEnv): Effect.Effect<void, unknown> =>
		Effect.gen(function* () {
			const { currentContext, newMessages, config, emit } = env;
			let firstTurn = true;
			let pendingMessages: AgentMessage[] = yield* pollSteeringMessages(config);
			let completedTurnMessages: AgentMessage[] = [];

			const refreshAtTurnBoundary = (
				nextMessages: AgentMessage[] = pendingMessages,
			): Effect.Effect<void, unknown> =>
				Effect.gen(function* () {
					if (!config.onTurnBoundary || completedTurnMessages.length === 0) return;
					const replacement = yield* Effect.promise(() =>
						config.onTurnBoundary!(
							{
								context: currentContext,
								completedMessages: completedTurnMessages.slice(),
								pendingMessages: nextMessages.slice(),
							},
							env.signal,
						),
					);
					completedTurnMessages = [];
					if (!replacement) return;
					currentContext.messages = replacement.slice();
					// The replacement durably represents everything completed before this
					// boundary, so do not retain those messages in the loop result as well.
					newMessages.length = 0;
				});

		for (;;) {
			let hasMoreToolCalls = true;
			let steeringAfterTools: AgentMessage[] | null = null;

			while (hasMoreToolCalls || pendingMessages.length > 0) {
				if (!firstTurn) {
					yield* emitEvent(emit, { type: "turn_start" });
				} else {
					firstTurn = false;
				}

				if (pendingMessages.length > 0) {
					for (const message of pendingMessages) {
						yield* emitEvent(emit, { type: "message_start", message });
						yield* emitEvent(emit, { type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
				}

				const message = yield* streamAssistantResponse(env);
				newMessages.push(message);

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					yield* emitEvent(emit, { type: "turn_end", message, toolResults: [] });
					yield* emitEvent(emit, { type: "agent_end", messages: newMessages });
					return;
				}

				const toolCalls = message.content.filter((c) => c.type === "toolCall");
				hasMoreToolCalls = toolCalls.length > 0;

				const toolResults: ToolResultMessage[] = [];
				if (hasMoreToolCalls) {
					const toolExecution = yield* executeToolCalls(env, message);
					toolResults.push(...toolExecution.toolResults);
					steeringAfterTools = toolExecution.steeringMessages ?? null;

						for (const result of toolResults) {
							currentContext.messages.push(result);
							newMessages.push(result);
						}
					}
					completedTurnMessages = [message, ...toolResults];

					yield* emitEvent(emit, { type: "turn_end", message, toolResults });

				if (steeringAfterTools && steeringAfterTools.length > 0) {
					pendingMessages = steeringAfterTools;
					steeringAfterTools = null;
					} else {
						pendingMessages = yield* pollSteeringMessages(config);
					}

					if (hasMoreToolCalls || pendingMessages.length > 0) {
						yield* refreshAtTurnBoundary();
					}
				}

				const followUpMessages = yield* pollFollowUpMessages(config);
				if (followUpMessages.length > 0) {
					yield* refreshAtTurnBoundary(followUpMessages);
					pendingMessages = followUpMessages;
					continue;
			}

			break;
		}

		yield* emitEvent(emit, { type: "agent_end", messages: newMessages });
	});

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 *
 * The provider stream — still an AsyncIterable at the `streamFn` seam — is
 * consumed as an Effect Stream: `Stream.takeUntil` stops at the terminal
 * `done`/`error` event (the legacy early `return` out of `for await`), and
 * every event is handled sequentially so `message_start`/`message_update`
 * ordering is unchanged.
 */
const streamAssistantResponse = (
	env: LoopEnv,
	): Effect.Effect<AssistantMessage, unknown> =>
		Effect.gen(function* () {
			const { currentContext: context, config, signal, emit, streamFn } = env;
			const throwIfAbortedBeforeDispatch = (): void => {
				if (!signal?.aborted) return;
				if (signal.reason instanceof Error) throw signal.reason;
				const error = new Error(
					typeof signal.reason === "string"
						? signal.reason
						: "Operation aborted before provider dispatch",
				);
				error.name = "AbortError";
				throw error;
			};

			throwIfAbortedBeforeDispatch();
			const requestBudget = config.requestBudget;
		if (requestBudget && !requestBudget.active) {
			requestBudget.used = 0;
			requestBudget.active = true;
			delete requestBudget.exhaustionReason;
		}
		let messages = context.messages;
			if (config.transformContext) {
				const transformContext = config.transformContext;
				messages = yield* Effect.promise(() => transformContext(messages, signal));
				throwIfAbortedBeforeDispatch();
			}

			const llmMessages = yield* Effect.promise(async () =>
				config.convertToLlm(messages),
			);
			throwIfAbortedBeforeDispatch();

		const llmContext: Context = {
			systemPrompt: context.systemPrompt,
			messages: llmMessages,
			tools: context.tools,
		};

		const streamFunction = streamFn || streamSimple;
		const getApiKey = config.getApiKey;
			const resolvedApiKey =
				(getApiKey
					? yield* Effect.promise(async () => getApiKey(config.model.provider))
					: undefined) || config.apiKey;
			throwIfAbortedBeforeDispatch();

		// Intentionally do NOT inject a `maxTokens` cap here. Setting a
		// hard cap truncates mid-sentence / mid-tool-call when hit, and
		// for reasoning models can leave zero budget for the visible
		// answer (cap exhausted by thinking). Trust the model to
		// self-terminate; the degenerate-response retry below handles
		// pathological terminations, and `Model.maxTokens` is reserved
		// for explicit per-call overrides via `config.maxTokens`.
		const streamOptions = {
			...config,
			apiKey: resolvedApiKey,
			refreshApiKey: config.refreshApiKey
				? async () => {
						try {
							return await config.refreshApiKey?.();
						} catch {
							return undefined;
						}
					}
				: undefined,
			signal,
		};

		const normalizeFinalMessage = (message: AssistantMessage): AssistantMessage => {
			const detectsSilentOverflow = [config.model.provider, message.provider].some(
				(provider) => provider.toLowerCase().replace(/[^a-z0-9]/g, "") === "zai",
			);
			if (
				!isContextOverflow(
					message,
					detectsSilentOverflow ? config.model.contextWindow : undefined,
				)
			) {
				return message;
			}
			return {
				...message,
				stopReason: "error",
				errorMessage:
					message.errorMessage?.trim() ||
					`Context overflow: model context window is ${config.model.contextWindow} tokens.`,
			};
		};

		const runOnce: Effect.Effect<AssistantMessage, unknown> = Effect.gen(
			function* () {
				const response = yield* Effect.promise(async () =>
					streamFunction(config.model, llmContext, streamOptions),
				);
				let partialMessage: AssistantMessage | null = null;
				let addedPartial = false;

				yield* Stream.fromAsyncIterable(
					response as AsyncIterable<AssistantMessageEvent>,
					(error) => error,
				).pipe(
					// Stop at the terminal event: parity with the legacy loop's
					// early `return` on done/error, including for foreign
					// StreamFn implementations that could keep yielding.
					Stream.takeUntil(
						(event) => event.type === "done" || event.type === "error",
					),
					Stream.runForEach((event) =>
						Effect.gen(function* () {
							switch (event.type) {
								case "start":
									partialMessage = event.partial;
									context.messages.push(partialMessage);
									addedPartial = true;
									yield* emitEvent(emit, {
										type: "message_start",
										message: { ...partialMessage },
									});
									break;

								case "text_start":
								case "text_delta":
								case "text_end":
								case "thinking_start":
								case "thinking_delta":
								case "thinking_end":
								case "toolcall_start":
								case "toolcall_delta":
								case "toolcall_end":
									if (partialMessage) {
										partialMessage = event.partial;
										context.messages[context.messages.length - 1] = partialMessage;
										yield* emitEvent(emit, {
											type: "message_update",
											assistantMessageEvent: event,
											message: { ...partialMessage },
										});
									}
									break;

								case "done":
								case "error":
									// Terminal: takeUntil ends the stream; the
									// finalize step below settles the message.
									break;
							}
						}),
					),
				);

				const next = normalizeFinalMessage(
					yield* Effect.promise(() => response.result()),
				);
				if (requestBudget && next.stopReason !== "error" && next.stopReason !== "aborted") {
					requestBudget.used = 0;
					requestBudget.active = false;
					delete requestBudget.exhaustionReason;
				}
				if (addedPartial) {
					context.messages[context.messages.length - 1] = next;
					} else {
						context.messages.push(next);
						yield* emitEvent(emit, { type: "message_start", message: { ...next } });
					}
					return next;
			},
		);

		let finalMessage = yield* runOnce;

		// Standalone Agent users retain the defensive one-shot retry. Runtime
		// sessions disable it so one visible run-level policy owns the provider
		// attempt budget instead of multiplying inner and outer retries. The
		// retry is deliberately immediate (no Schedule backoff): it papers over
		// a degenerate termination, not a transport failure — provider
		// retry/backoff timing lives in the provider adapters.
		const maxDegenerateRetries = Math.max(0, Math.floor(config.degenerateResponseRetries ?? 1));
		for (
			let retry = 0;
			retry < maxDegenerateRetries && isDegenerateAssistantMessage(finalMessage);
			retry += 1
		) {
				if (context.messages[context.messages.length - 1] === finalMessage) {
					context.messages.pop();
				}
				yield* emitEvent(emit, {
					type: "message_end",
					message: {
						...finalMessage,
						stopReason: "error",
						errorMessage: "Provider returned no usable assistant output; retrying once.",
					},
				});
				finalMessage = yield* runOnce;
			}

			yield* emitEvent(emit, { type: "message_end", message: finalMessage });

			return finalMessage;
	});

/**
 * Execute tool calls from an assistant message.
 */
const executeToolCalls = (
	env: LoopEnv,
	assistantMessage: AssistantMessage,
): Effect.Effect<
	{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] },
	unknown
> => {
	const toolCalls = assistantMessage.content.filter(
		(c): c is AgentToolCall => c.type === "toolCall",
	);
	if (env.config.toolExecution === "sequential") {
		return executeToolCallsSequential(env, assistantMessage, toolCalls);
	}
	return executeToolCallsParallel(env, assistantMessage, toolCalls);
};


const canonicalizeToolCallValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalizeToolCallValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, canonicalizeToolCallValue(nested)]),
		);
	}
	return value;
};

const toolCallExecutionKey = (toolCall: AgentToolCall): string =>
	`${toolCall.name}\u0000${JSON.stringify(canonicalizeToolCallValue(toolCall.arguments))}`;

const createDuplicateToolCallResult = (original: ToolResultMessage): AgentToolResult<unknown> => ({
	content: [
		{
			type: "text",
			text: `[Exact duplicate skipped. Reused the result from tool call ${original.toolCallId}; do not run this identical call again.]`,
		},
	],
	details: { deduplicated: true, reusedToolCallId: original.toolCallId },
});

const executeToolCallsSequential = (
	env: LoopEnv,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
): Effect.Effect<
	{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] },
	unknown
> =>
	Effect.gen(function* () {
		const { currentContext, config, emit } = env;
		const results: ToolResultMessage[] = [];
		const resultByExecutionKey = new Map<string, ToolResultMessage>();
		let steeringMessages: AgentMessage[] | undefined;

		for (const toolCall of toolCalls) {
			const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
			yield* emitEvent(emit, {
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				...(tool?.workingText ? { statusText: tool.workingText } : {}),
				args: toolCall.arguments,
			});

			const executionKey = toolCallExecutionKey(toolCall);
			const originalResult = resultByExecutionKey.get(executionKey);
			if (originalResult) {
				results.push(
					yield* emitToolCallOutcome(
						emit,
						toolCall,
						createDuplicateToolCallResult(originalResult),
						originalResult.isError,
					),
				);
				continue;
			}

			const preparation = yield* prepareToolCall(env, assistantMessage, toolCall);
			if (preparation.kind === "immediate") {
				const result = yield* emitToolCallOutcome(
					emit,
					toolCall,
					preparation.result,
					preparation.isError,
				);
				results.push(result);
				resultByExecutionKey.set(executionKey, result);
			} else {
				const executed = yield* executeToolWindow({
					prepared: preparation,
					signal: env.signal,
					abortLatch: env.abortLatch,
					emit,
					inactivityTimeoutMs: config.toolInactivityTimeoutMs,
				});
				const result = yield* finalizeExecutedToolCall(
					env,
					assistantMessage,
					preparation,
					executed,
				);
				results.push(result);
				resultByExecutionKey.set(executionKey, result);
			}
		}

		if (config.getSteeringMessages) {
			const getSteeringMessages = config.getSteeringMessages;
			const steering = yield* Effect.promise(() => getSteeringMessages());
			if (steering.length > 0) {
				steeringMessages = steering;
			}
		}

		return { toolResults: results, steeringMessages };
	});

const executeToolCallsParallel = (
	env: LoopEnv,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
): Effect.Effect<
	{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] },
	unknown
> =>
	Effect.gen(function* () {
		const { currentContext, config, emit } = env;
		const results: ToolResultMessage[] = [];
		const runnableCalls: PreparedToolCall[] = [];
		const originalCallByExecutionKey = new Map<string, AgentToolCall>();
		const duplicateOriginalByCall = new Map<AgentToolCall, AgentToolCall>();
		const resultByCall = new Map<AgentToolCall, ToolResultMessage>();
		let steeringMessages: AgentMessage[] | undefined;

		for (const toolCall of toolCalls) {
			const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
			yield* emitEvent(emit, {
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				...(tool?.workingText ? { statusText: tool.workingText } : {}),
				args: toolCall.arguments,
			});

			const executionKey = toolCallExecutionKey(toolCall);
			const originalCall = originalCallByExecutionKey.get(executionKey);
			if (originalCall) {
				duplicateOriginalByCall.set(toolCall, originalCall);
				continue;
			}
			originalCallByExecutionKey.set(executionKey, toolCall);

			const preparation = yield* prepareToolCall(env, assistantMessage, toolCall);
			if (preparation.kind === "immediate") {
				const result = yield* emitToolCallOutcome(
					emit,
					toolCall,
					preparation.result,
					preparation.isError,
				);
				results.push(result);
				resultByCall.set(toolCall, result);
			} else {
				runnableCalls.push(preparation);
			}
		}

		// Fork every runnable window eagerly (the legacy `.map(execute)` start
		// order), then join in assistant source order so final tool events are
		// emitted in-order while executions overlap. The children are fibers of
		// this turn's fiber: joins settle before the turn continues.
		const runningCalls: Array<{
			prepared: PreparedToolCall;
			fiber: Fiber.Fiber<ExecutedToolCallOutcome>;
		}> = [];
		for (const prepared of runnableCalls) {
			const fiber = yield* Effect.forkChild(
				executeToolWindow({
					prepared,
					signal: env.signal,
					abortLatch: env.abortLatch,
					emit,
					inactivityTimeoutMs: config.toolInactivityTimeoutMs,
				}),
				{ startImmediately: true },
			);
			runningCalls.push({ prepared, fiber });
		}

		for (const running of runningCalls) {
			const executed = yield* Fiber.join(running.fiber);
			const result = yield* finalizeExecutedToolCall(
				env,
				assistantMessage,
				running.prepared,
				executed,
			);
			results.push(result);
			resultByCall.set(running.prepared.toolCall, result);
		}

		for (const toolCall of toolCalls) {
			const originalCall = duplicateOriginalByCall.get(toolCall);
			if (!originalCall) continue;
			const originalResult = resultByCall.get(originalCall);
			if (!originalResult) continue;
			results.push(
				yield* emitToolCallOutcome(
					emit,
					toolCall,
					createDuplicateToolCallResult(originalResult),
					originalResult.isError,
				),
			);
		}

		if (!steeringMessages && config.getSteeringMessages) {
			const getSteeringMessages = config.getSteeringMessages;
			const steering = yield* Effect.promise(() => getSteeringMessages());
			if (steering.length > 0) {
				steeringMessages = steering;
			}
		}

		return { toolResults: results, steeringMessages };
	});

export type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<unknown>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<unknown>;
	isError: boolean;
};

const prepareToolCall = (
	env: LoopEnv,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
): Effect.Effect<PreparedToolCall | ImmediateToolCallOutcome> => {
	const { currentContext, config, signal } = env;
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return Effect.succeed<ImmediateToolCallOutcome>({
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		});
	}

	return Effect.tryPromise({
		try: async (): Promise<PreparedToolCall | ImmediateToolCallOutcome> => {
			const validatedArgs = validateToolArguments(tool, toolCall);
			if (config.beforeToolCall) {
				const beforeResult = await config.beforeToolCall(
					{
						assistantMessage,
						toolCall,
						args: validatedArgs,
						context: currentContext,
					},
					signal,
				);
				if (beforeResult?.block) {
					return {
						kind: "immediate",
						result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
						isError: true,
					};
				}
			}
			return {
				kind: "prepared",
				toolCall,
				tool,
				args: validatedArgs,
			};
		},
		catch: (error) => error,
	}).pipe(
		Effect.catch((error) =>
			Effect.succeed<ImmediateToolCallOutcome>({
				kind: "immediate",
				result: createErrorToolResult(
					error instanceof Error ? error.message : String(error),
				),
				isError: true,
			}),
		),
	);
};

/**
 * Tools that emit no `onUpdate` progress for this long are cancelled and
 * reported to the model as an error tool result; the agent loop keeps
 * running. Progress resets the clock, so a long-running tool survives as
 * long as it shows signs of life. Ten minutes of TOTAL silence almost
 * always means stuck — and because only the tool dies (the agent gets the
 * error and can retry), a rare false positive is cheap, so the bound errs
 * tight rather than leaving a wedged tool holding the turn for half an
 * hour. Override via `AgentLoopConfig.toolInactivityTimeoutMs`; <= 0
 * disables the bound.
 */
export const DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long a cancelled tool may keep running before it is abandoned. Once
 * the outer signal aborts, a cooperative tool settles almost immediately;
 * one that ignores its abort signal previously held the pending tool call
 * (and the turn) hostage until the full inactivity bound. Cancellation is
 * an explicit teardown request, so the grace errs short: after it expires
 * the call is settled with an error result and the tool's external work is
 * left to the tool host's own reaping (shell kill-all on shutdown).
 */
export const DEFAULT_TOOL_ABORT_GRACE_MS = 5_000;

type ToolWindowArgs = {
	prepared: PreparedToolCall;
	/** Caller-owned signal: only read for the composed tool-abort reason. */
	signal: AbortSignal | undefined;
	/** Effect-side cancellation latch bridged from the caller's signal. */
	abortLatch: Deferred.Deferred<unknown>;
	emit: AgentEventSink;
	inactivityTimeoutMs?: number;
	abortGraceMs?: number;
};

/**
 * One tool-call execution window as a scoped effect.
 *
 * Topology: the tool's promise (raced first against a failure latch) plus
 * two supervisory fibers forked into the window's scope —
 *
 * - **Inactivity watchdog:** sleeps toward `lastActivityAt + timeoutMs`
 *   (each `onUpdate` pushes the deadline), then aborts the tool's composed
 *   signal and fails the latch with the exact legacy cancellation message.
 * - **Abort grace:** awaits the run's abort latch, forwards the caller's
 *   abort reason into the tool's own AbortController (a cooperative tool
 *   that still settles in time wins the race with its real result), then
 *   after the grace fails the latch with the exact legacy abandonment
 *   message.
 *
 * Scope close interrupts both fibers on every exit path — the Effect
 * replacement for the legacy `clearTimeout`/`removeEventListener` `finally`
 * block. Pending `tool_execution_update` emissions are awaited before the
 * outcome is returned, on the success and failure paths alike (legacy
 * `Promise.all(updateEvents)` ordering).
 */
const executeToolWindow = (
	args: ToolWindowArgs,
): Effect.Effect<ExecutedToolCallOutcome> =>
	Effect.scoped(
		Effect.gen(function* () {
			const { prepared, signal, abortLatch, emit } = args;
			const timeoutMs = args.inactivityTimeoutMs ?? DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS;
			const graceMs = args.abortGraceMs ?? DEFAULT_TOOL_ABORT_GRACE_MS;

			// Bound the tool, not the agent. The tool gets a composed abort
			// controller so a cooperative implementation can clean up; a tool
			// that ignores it is abandoned via the race below so the loop still
			// gets its error result. (Effect-ratchet pin: tool `execute`
			// implementations are plain TS taking a REAL AbortSignal, so the
			// seam controller stays even though the window itself is a scoped
			// effect.)
			const toolAbort = new AbortController();
			const updateEvents: Promise<void>[] = [];
			let timedOut = false;
			let lastActivityAt = Date.now();

			// Failure latch: the watchdog and the post-abort grace fail it; the
			// execution race below loses to it (legacy `rejectOnInactivity`).
			const failure = yield* Deferred.make<never, unknown>();

			// A signal already aborted at window entry must be visible to the
			// tool synchronously, before `execute` is invoked (legacy
			// `if (signal?.aborted) onOuterAbort()`).
			if (signal?.aborted) {
				toolAbort.abort(signal.reason);
			}

			const onUpdate = (partialResult: AgentToolResult<unknown>) => {
				if (timedOut) return;
				lastActivityAt = Date.now();
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			};

			if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
				yield* Effect.forkScoped(
					Effect.gen(function* () {
						for (;;) {
							const remainingMs = timeoutMs - (Date.now() - lastActivityAt);
							if (remainingMs <= 0) break;
							yield* Effect.sleep(remainingMs);
						}
						timedOut = true;
						const error = new ToolInactivityTimeoutError({
							toolName: prepared.toolCall.name,
							timeoutMs,
						});
						toolAbort.abort(error);
						yield* Deferred.fail(failure, error);
					}),
					{ startImmediately: true },
				);
			}

			// Abandonment after cancellation is bounded: don't let an
			// abort-ignoring tool hold the pending call for the full
			// inactivity window.
			yield* Effect.forkScoped(
				Effect.gen(function* () {
					const reason = yield* Deferred.await(abortLatch);
					toolAbort.abort(reason);
					if (!Number.isFinite(graceMs) || graceMs <= 0) return;
					yield* Effect.sleep(graceMs);
					timedOut = true;
					yield* Deferred.fail(
						failure,
						new ToolAbortAbandonedError({
							toolName: prepared.toolCall.name,
							graceMs,
						}),
					);
				}),
				{ startImmediately: true },
			);

			const outcome = yield* Effect.tryPromise({
				try: () =>
					prepared.tool.execute(
						prepared.toolCall.id,
						prepared.args as never,
						toolAbort.signal,
						onUpdate,
					),
				catch: (error) => error,
			}).pipe(
				Effect.raceFirst(Deferred.await(failure)),
				Effect.map(
					(result): ExecutedToolCallOutcome => ({
						result,
						isError: result.isError === true,
					}),
				),
				Effect.catch((error) =>
					Effect.succeed<ExecutedToolCallOutcome>({
						result: createErrorToolResult(
							error instanceof Error ? error.message : String(error),
						),
						isError: true,
					}),
				),
			);

			yield* Effect.promise(() => Promise.all(updateEvents));
			return outcome;
		}),
	);

/**
 * Execute a prepared tool call with the loop's inactivity/abandonment
 * bounds. Public seam kept for external hosts of the loop: the provided
 * `signal` is bridged into a per-call abort latch whose listener is removed
 * when the call settles.
 */
export async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	inactivityTimeoutMs?: number,
	abortGraceMs?: number,
): Promise<ExecutedToolCallOutcome> {
	return runLoopPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const abortLatch = yield* acquireAbortLatch(signal);
				return yield* executeToolWindow({
					prepared,
					signal,
					abortLatch,
					emit,
					inactivityTimeoutMs,
					abortGraceMs,
				});
			}),
		),
	);
}

const finalizeExecutedToolCall = (
	env: LoopEnv,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
): Effect.Effect<ToolResultMessage> =>
	Effect.gen(function* () {
		const { currentContext, config, signal, emit } = env;
		let result = executed.result;
		let isError = executed.isError;

		if (config.afterToolCall) {
			const afterToolCall = config.afterToolCall;
			const afterResult = yield* Effect.promise(() =>
				afterToolCall(
					{
						assistantMessage,
						toolCall: prepared.toolCall,
						args: prepared.args,
						result,
						isError,
						context: currentContext,
					},
					signal,
				),
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
				};
				isError = afterResult.isError ?? isError;
			}
		}

		return yield* emitToolCallOutcome(emit, prepared.toolCall, result, isError);
	});

function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

const emitToolCallOutcome = (
	emit: AgentEventSink,
	toolCall: AgentToolCall,
	result: AgentToolResult<unknown>,
	isError: boolean,
): Effect.Effect<ToolResultMessage> =>
	Effect.gen(function* () {
		yield* emitEvent(emit, {
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};

		yield* emitEvent(emit, { type: "message_start", message: toolResultMessage });
		yield* emitEvent(emit, { type: "message_end", message: toolResultMessage });
		return toolResultMessage;
	});
