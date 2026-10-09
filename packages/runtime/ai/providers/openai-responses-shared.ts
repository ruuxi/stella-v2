import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../cost.js";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { shortHash } from "../utils/hash.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { providerAbortedStopMessage } from "../utils/provider-stop.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { normalizeProviderToolInputSchema } from "../../kernel/tools/provider-tool-schema.js";
import { transformMessages } from "./transform-messages.js";

// =============================================================================
// Utilities
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
}

const OPENAI_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const LEGACY_OPENAI_FUNCTION_NAMES = new Map<string, string>([
	["multi_tool_use.parallel", "multi_tool_use_parallel"],
]);

export function normalizeOpenAIFunctionName(name: string): string {
	const migrated = LEGACY_OPENAI_FUNCTION_NAMES.get(name) ?? name;
	if (!OPENAI_FUNCTION_NAME_PATTERN.test(migrated)) {
		throw new Error(`Invalid OpenAI Responses function name: ${name}`);
	}
	return migrated;
}

// =============================================================================
// Message conversion
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			// Counts unsigned text blocks within this single assistant message so
			// 2nd+ fallback ids don't collide (OpenAI rejects duplicate input ids).
			let textBlockIndex = 0;
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
			} else if (block.type === "text") {
				const textBlock = block as TextContent;
				// Fireworks routers (kimi-k2p6, kimi-k2p5) do NOT understand the Responses
				// `{type: "message", content: [{type: "output_text", ...}]}`
				// replay shape for prior assistant turns — they echo the
				// entire content array back to the user as literal Python-
				// repr text (e.g. `[{'type': 'output_text', 'text': '…'}]`).
				// Send the prior assistant text as a chat-completions-style
				// `{role: "assistant", content: [{type: "input_text", …}]}`
				// instead, mirroring the backend's `openai_responses_shared`.
				if (model.provider === "fireworks") {
					messages.push({
						role: "assistant",
						content: [{ type: "input_text", text: sanitizeSurrogates(textBlock.text) }],
					} as ResponseInput[number]);
					continue;
				}
				const parsedSignature = parseTextSignature(textBlock.textSignature);
				// OpenAI requires id to be max 64 characters
				const fallbackMsgId =
					textBlockIndex === 0 ? `msg_${msgIndex}` : `msg_${msgIndex}_${textBlockIndex}`;
				textBlockIndex++;
				let msgId = parsedSignature?.id;
				if (!msgId) {
					msgId = fallbackMsgId;
				} else if (msgId.length > 64) {
					msgId = `msg_${shortHash(msgId)}`;
				}
				output.push({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
					status: "completed",
					id: msgId,
					phase: parsedSignature?.phase,
				} satisfies ResponseOutputMessage);
			} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}

					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: normalizeOpenAIFunctionName(toolCall.name),
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");

			// `function_call_output.output` is always a string. Several
			// OpenAI-Responses-compatible providers (Fireworks routers
			// including kimi-k2p6 and kimi-k2p5) cannot parse
			// `input_image` parts inside the output array — they
			// stringify the entire array (data URL included) and tokenize
			// it as raw text, blowing past the model's context window.
			// The image is forwarded as a follow-up user message instead,
			// matching `openai_completions.ts` and the backend variant.
			messages.push({
				type: "function_call_output",
				call_id: callId,
				output: sanitizeSurrogates(hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)"),
			});

			if (hasImages && model.input.includes("image")) {
				const followUpContent: ResponseInputContent[] = [
					{
						type: "input_text",
						text: "Attached image(s) from the previous tool result:",
					} satisfies ResponseInputText,
				];
				for (const block of msg.content) {
					if (block.type === "image") {
						followUpContent.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						} satisfies ResponseInputImage);
					}
				}
				if (followUpContent.length > 1) {
					messages.push({
						role: "user",
						content: followUpContent,
					});
				}
			}
		}
		msgIndex++;
	}

	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => ({
		type: "function",
		name: normalizeOpenAIFunctionName(tool.name),
		description: tool.description,
		parameters: normalizeProviderToolInputSchema(
			tool.parameters as Record<string, unknown>,
		) as any,
		strict,
	}));
}

// =============================================================================
// Stream processing
// =============================================================================

/**
 * Gateway mode: expand one complete Responses `Response` object into the
 * event sequence `processResponsesStream` would have consumed for the same
 * content, so both transports share one assembler. Per output item:
 * `response.output_item.added`, ONE whole-string delta, then
 * `response.output_item.done` (with the original item, so opaque round-trip
 * material — reasoning items, encrypted content, `${call_id}|${item_id}` —
 * is preserved verbatim), followed by the terminal `response.completed`,
 * `response.incomplete`, or `response.failed` event.
 */
export function synthesizeResponsesStreamEvents(response: OpenAI.Responses.Response): ResponseStreamEvent[] {
	const events: ResponseStreamEvent[] = [];
	let sequence = 0;
	const next = () => sequence++;

	events.push({ type: "response.created", response, sequence_number: next() });

	response.output.forEach((item, outputIndex) => {
		if (item.type === "reasoning") {
			// Hand the added event a copy so the original item's JSON (the
			// thinking signature) stays byte-identical.
			events.push({
				type: "response.output_item.added",
				item: { ...item, summary: [] },
				output_index: outputIndex,
				sequence_number: next(),
			});
			const summaryText = item.summary?.map((part) => part.text).join("\n\n") || "";
			const contentText = item.content?.map((part) => part.text).join("\n\n") || "";
			const thinking = summaryText || contentText;
			if (thinking.length > 0) {
				events.push({
					type: "response.reasoning_text.delta",
					item_id: item.id,
					output_index: outputIndex,
					content_index: 0,
					delta: thinking,
					sequence_number: next(),
				});
			}
		} else if (item.type === "message") {
			// Start the added item empty, as a live stream does; the full text
			// arrives as one delta and again on output_item.done.
			events.push({
				type: "response.output_item.added",
				item: { ...item, content: [], status: "in_progress" },
				output_index: outputIndex,
				sequence_number: next(),
			});
			const text = item.content.map((part) => (part.type === "output_text" ? part.text : part.refusal)).join("");
			if (text.length > 0) {
				events.push({
					type: "response.output_text.delta",
					item_id: item.id,
					output_index: outputIndex,
					content_index: 0,
					delta: text,
					logprobs: [],
					sequence_number: next(),
				});
			}
		} else if (item.type === "function_call") {
			events.push({
				type: "response.output_item.added",
				item: { ...item, arguments: "" },
				output_index: outputIndex,
				sequence_number: next(),
			});
			if (item.arguments.length > 0) {
				events.push({
					type: "response.function_call_arguments.delta",
					item_id: item.id ?? "",
					output_index: outputIndex,
					delta: item.arguments,
					sequence_number: next(),
				});
			}
		} else {
			events.push({
				type: "response.output_item.added",
				item,
				output_index: outputIndex,
				sequence_number: next(),
			});
		}
		events.push({
			type: "response.output_item.done",
			item,
			output_index: outputIndex,
			sequence_number: next(),
		});
	});

	if (response.status === "failed") {
		events.push({ type: "response.failed", response, sequence_number: next() });
	} else if (response.status === "incomplete") {
		events.push({ type: "response.incomplete", response, sequence_number: next() });
	} else {
		events.push({ type: "response.completed", response, sequence_number: next() });
	}
	return events;
}

type StreamingToolCall = ToolCall & { partialJson?: string };

type ResponsesOutputSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent> | Iterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	// Stream state is tracked per `output_index`, not as a single "current"
	// item: providers interleave items and complete them out of order (a
	// reasoning item finishing after the message that follows it), and a
	// single cursor would drop the reasoning or land deltas in the wrong
	// block. Servers that omit `output_index` all share the `undefined` key,
	// which degrades to the sequential behavior.
	const outputSlots = new Map<number | undefined, ResponsesOutputSlot>();
	const getSlot = <TType extends ResponsesOutputSlot["type"]>(
		outputIndex: number | undefined,
		type: TType,
	): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
		const slot = outputSlots.get(outputIndex);
		return slot?.type === type ? (slot as Extract<ResponsesOutputSlot, { type: TType }>) : undefined;
	};
	const createSlot = (
		outputIndex: number | undefined,
		item: ResponseOutputItem,
	): ResponsesOutputSlot | undefined => {
		let slot: ResponsesOutputSlot;
		if (item.type === "reasoning") {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output.content.push(block);
			slot = { type: "thinking", block, contentIndex: output.content.length - 1 };
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
		} else if (item.type === "message") {
			const block: TextContent = { type: "text", text: "" };
			output.content.push(block);
			slot = { type: "text", block, contentIndex: output.content.length - 1 };
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
		} else if (item.type === "function_call") {
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				partialJson: item.arguments || "",
			};
			output.content.push(block);
			slot = { type: "toolCall", block, contentIndex: output.content.length - 1 };
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
		} else {
			return undefined;
		}
		outputSlots.set(outputIndex, slot);
		return slot;
	};

	// Fireworks's Responses API for kimi-k2p6 and kimi-k2p5 sometimes emits
	// `response.output_text.delta` BEFORE the matching
	// `response.output_item.added` for the message they belong to. Without
	// this helper, those early deltas would be silently dropped — the reply
	// still ends up correct (because `response.output_item.done` writes the
	// full text from `item.content`), but no `text_delta` events are emitted
	// during streaming and the reply pops in all at once instead of
	// typewriter-ing. `ensureTextSlot` lazy-creates the text slot on the first
	// delta; the `response.output_item.added` handler below then ADOPTS it
	// instead of allocating a second block, which would otherwise render the
	// reply twice in the UI.
	const ensureTextSlot = (outputIndex: number | undefined) =>
		getSlot(outputIndex, "text") ??
		(createSlot(outputIndex, { type: "message" } as ResponseOutputMessage) as Extract<
			ResponsesOutputSlot,
			{ type: "text" }
		>);

	const pushThinkingDelta = (slot: Extract<ResponsesOutputSlot, { type: "thinking" }>, delta: string) => {
		slot.block.thinking += delta;
		stream.push({ type: "thinking_delta", contentIndex: slot.contentIndex, delta, partial: output });
	};

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			const existing = outputSlots.get(event.output_index);
			// Adopt a text slot lazily created by an early delta (see ensureTextSlot).
			if (!(event.item.type === "message" && existing?.type === "text")) {
				createSlot(event.output_index, event.item);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (slot) pushThinkingDelta(slot, event.delta);
		} else if (event.type === "response.reasoning_summary_part.done") {
			const slot = getSlot(event.output_index, "thinking");
			if (slot) pushThinkingDelta(slot, "\n\n");
		} else if (event.type === "response.reasoning_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (slot) pushThinkingDelta(slot, event.delta);
		} else if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
			const slot = ensureTextSlot(event.output_index);
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			slot.block.partialJson += event.delta;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);
			stream.push({
				type: "toolcall_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			const previousPartialJson = slot.block.partialJson;
			slot.block.partialJson = event.arguments;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);

			if (event.arguments.startsWith(previousPartialJson)) {
				const delta = event.arguments.slice(previousPartialJson.length);
				if (delta.length > 0) {
					stream.push({
						type: "toolcall_delta",
						contentIndex: slot.contentIndex,
						delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			const slot = outputSlots.get(event.output_index) ?? createSlot(event.output_index, item);

			if (item.type === "reasoning" && slot?.type === "thinking") {
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				slot.block.thinkingSignature = JSON.stringify(item);
				stream.push({
					type: "thinking_end",
					contentIndex: slot.contentIndex,
					content: slot.block.thinking,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "message" && slot?.type === "text") {
				slot.block.text = item.content.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("");
				slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: slot.contentIndex,
					content: slot.block.text,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "function_call" && slot?.type === "toolCall") {
				slot.block.arguments = slot.block.partialJson
					? parseStreamingJson(slot.block.partialJson)
					: parseStreamingJson(item.arguments || "{}");
				// Finalize in-place and strip the scratch buffer so replay only
				// carries parsed arguments (and so the call counts as finished).
				delete slot.block.partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			const response = event.response;
			if (response?.id) {
				output.responseId = response.id;
			}
			if (response?.usage) {
				const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					// OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input
					input: (response.usage.input_tokens || 0) - cachedTokens,
					output: response.usage.output_tokens || 0,
					reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: response.usage.total_tokens || 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}
			calculateCost(model, output.usage);
			if (options?.applyServiceTierPricing) {
				const serviceTier = options.resolveServiceTier
					? options.resolveServiceTier(response?.service_tier, options.serviceTier)
					: (response?.service_tier ?? options.serviceTier);
				options.applyServiceTierPricing(output.usage, serviceTier);
			}
			// The terminal event is authoritative when compatible endpoints omit
			// status. An explicit incomplete event is never a clean stop: only
			// max_output_tokens truncation is a length stop; content_filter and
			// any other reason are errors.
			const incompleteReason = response?.incomplete_details?.reason ?? undefined;
			output.stopReason = mapStopReason(
				event.type === "response.incomplete" ? "incomplete" : response?.status,
				incompleteReason,
			);
			if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
			// Keep the raw terminal status (and any error/incomplete detail on the
			// response) so the surfaced error explains why the stream died. An
			// incomplete reason is the more specific raw stop reason: it lets a
			// content_filter stop read as a content abort.
			if (output.stopReason === "error" && !output.errorMessage) {
				const responseError = response?.error;
				const detail = responseError
					? ` — ${responseError.code || "unknown"}: ${responseError.message || "no message"}`
					: incompleteReason
						? ` — incomplete: ${incompleteReason}`
						: "";
				output.errorMessage = `${providerAbortedStopMessage(incompleteReason ?? String(response?.status ?? "incomplete"))}${detail}`;
			}
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}

	// Every tool call in the final message gets executed. Refuse to hand over
	// calls whose output_item.done never arrived: their arguments may be cut
	// off or mixed up (e.g. a server that omits output_index). Finished calls
	// have their scratch buffer removed.
	if (output.stopReason === "toolUse") {
		for (const block of output.content) {
			if (block.type === "toolCall" && (block as StreamingToolCall).partialJson !== undefined) {
				throw new Error(
					`OpenAI Responses stream completed with an unfinished tool call: ${block.name} (${block.id})`,
				);
			}
		}
	}
}

function mapStopReason(
	status: OpenAI.Responses.ResponseStatus | undefined,
	incompleteReason?: string,
): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return incompleteReason === "max_output_tokens" ? "length" : "error";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			// This mapper runs only after a terminal completed event. Compatible
			// relays can carry a stale polled status; the event is authoritative.
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
