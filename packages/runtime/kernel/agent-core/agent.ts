import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	ServiceTier,
	TextContent,
	ThinkingBudgets,
	Transport,
} from "../../ai/types.js";
import { getModel } from "../../ai/models.js";
import { streamSimple } from "../../ai/stream.js";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentTurnBoundaryContext,
	BeforeToolCallContext,
	BeforeToolCallResult,
	StreamFn,
	ThinkingLevel,
	ToolExecutionMode,
} from "./types.js";

function isBaseMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && "usage" in message;
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(isBaseMessage);
}

function errorMessageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface AgentOptions {
	initialState?: Partial<AgentState>;

	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	steeringMode?: "all" | "one-at-a-time";

	followUpMode?: "all" | "one-at-a-time";

	streamFn?: StreamFn;

	sessionId?: string;

	promptCacheKey?: string;

	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	refreshApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	onPayload?: SimpleStreamOptions["onPayload"];

	onProviderRetry?: SimpleStreamOptions["onProviderRetry"];

	thinkingBudgets?: ThinkingBudgets;

	transport?: Transport;

	serviceTier?: ServiceTier;

	maxRetryDelayMs?: number;

	toolExecution?: ToolExecutionMode;

	toolInactivityTimeoutMs?: number;

	onTurnBoundary?: (
		context: AgentTurnBoundaryContext,
		signal?: AbortSignal,
	) => Promise<AgentMessage[] | undefined>;

	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;

	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
}

export class Agent {
	private _state: AgentState = {
		systemPrompt: "",
		model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	private listeners = new Set<(e: AgentEvent) => void>();
	private abortController?: AbortController;
	private convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	private transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	private steeringQueue: AgentMessage[] = [];
	private followUpQueue: AgentMessage[] = [];
	private steeringMode: "all" | "one-at-a-time";
	private followUpMode: "all" | "one-at-a-time";
	public streamFn: StreamFn;
	private _sessionId?: string;
	private _promptCacheKey?: string;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public refreshApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	private _onPayload?: SimpleStreamOptions["onPayload"];
	private _onProviderRetry?: SimpleStreamOptions["onProviderRetry"];
	private runningPrompt?: Promise<void>;
	private resolveRunningPrompt?: () => void;
	private _thinkingBudgets?: ThinkingBudgets;
	private _transport: Transport;
	private _serviceTier?: ServiceTier;
	private _maxRetryDelayMs?: number;
	private _toolExecution: ToolExecutionMode;
	private _toolInactivityTimeoutMs?: number;
	private _onTurnBoundary?: (
		context: AgentTurnBoundaryContext,
		signal?: AbortSignal,
	) => Promise<AgentMessage[] | undefined>;
	private _beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	private _afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;

	constructor(opts: AgentOptions = {}) {
		this._state = { ...this._state, ...opts.initialState };
		this.convertToLlm = opts.convertToLlm || defaultConvertToLlm;
		this.transformContext = opts.transformContext;
		this.steeringMode = opts.steeringMode || "one-at-a-time";
		this.followUpMode = opts.followUpMode || "one-at-a-time";
		this.streamFn = opts.streamFn || streamSimple;
		this._sessionId = opts.sessionId;
		this._promptCacheKey = opts.promptCacheKey;
		this.getApiKey = opts.getApiKey;
		this.refreshApiKey = opts.refreshApiKey;
		this._onPayload = opts.onPayload;
		this._onProviderRetry = opts.onProviderRetry;
		this._thinkingBudgets = opts.thinkingBudgets;
		this._transport = opts.transport ?? "sse";
		this._serviceTier = opts.serviceTier;
		this._maxRetryDelayMs = opts.maxRetryDelayMs;
		this._toolExecution = opts.toolExecution ?? "parallel";
		this._toolInactivityTimeoutMs = opts.toolInactivityTimeoutMs;
		this._onTurnBoundary = opts.onTurnBoundary;
		this._beforeToolCall = opts.beforeToolCall;
		this._afterToolCall = opts.afterToolCall;
	}

	get sessionId(): string | undefined {
		return this._sessionId;
	}

	set sessionId(value: string | undefined) {
		this._sessionId = value;
	}

	get thinkingBudgets(): ThinkingBudgets | undefined {
		return this._thinkingBudgets;
	}

	set thinkingBudgets(value: ThinkingBudgets | undefined) {
		this._thinkingBudgets = value;
	}

	get transport(): Transport {
		return this._transport;
	}

	setTransport(value: Transport) {
		this._transport = value;
	}

	get maxRetryDelayMs(): number | undefined {
		return this._maxRetryDelayMs;
	}

	set maxRetryDelayMs(value: number | undefined) {
		this._maxRetryDelayMs = value;
	}

	get toolExecution(): ToolExecutionMode {
		return this._toolExecution;
	}

	setToolExecution(value: ToolExecutionMode) {
		this._toolExecution = value;
	}

	setBeforeToolCall(
		value:
			| ((context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>)
			| undefined,
	) {
		this._beforeToolCall = value;
	}

	setAfterToolCall(
		value:
			| ((context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>)
			| undefined,
	) {
		this._afterToolCall = value;
	}

	get state(): AgentState {
		return this._state;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	setSystemPrompt(v: string) {
		this._state.systemPrompt = v;
	}

	setModel(m: Model<Api>) {
		this._state.model = m;
	}

	setThinkingLevel(l: ThinkingLevel) {
		this._state.thinkingLevel = l;
	}

	setServiceTier(serviceTier: ServiceTier | undefined) {
		this._serviceTier = serviceTier;
	}

	setSteeringMode(mode: "all" | "one-at-a-time") {
		this.steeringMode = mode;
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.steeringMode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time") {
		this.followUpMode = mode;
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.followUpMode;
	}

	setTools(t: AgentTool[]) {
		this._state.tools = t;
	}

	replaceMessages(ms: AgentMessage[]) {
		this._state.messages = ms.slice();
	}

	appendMessage(m: AgentMessage) {
		this._state.messages = [...this._state.messages, m];
	}

	steer(m: AgentMessage) {
		this.steeringQueue.push(m);
	}

	followUp(m: AgentMessage) {
		this.followUpQueue.push(m);
	}

	clearSteeringQueue() {
		this.steeringQueue = [];
	}

	clearFollowUpQueue() {
		this.followUpQueue = [];
	}

	clearAllQueues() {
		this.steeringQueue = [];
		this.followUpQueue = [];
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
	}

	private dequeueSteeringMessages(): AgentMessage[] {
		if (this.steeringMode === "one-at-a-time") {
			if (this.steeringQueue.length > 0) {
				const first = this.steeringQueue[0];
				this.steeringQueue = this.steeringQueue.slice(1);
				return [first];
			}
			return [];
		}

		const steering = this.steeringQueue.slice();
		this.steeringQueue = [];
		return steering;
	}

	private dequeueFollowUpMessages(): AgentMessage[] {
		if (this.followUpMode === "one-at-a-time") {
			if (this.followUpQueue.length > 0) {
				const first = this.followUpQueue[0];
				this.followUpQueue = this.followUpQueue.slice(1);
				return [first];
			}
			return [];
		}

		const followUp = this.followUpQueue.slice();
		this.followUpQueue = [];
		return followUp;
	}

	clearMessages() {
		this._state.messages = [];
	}

	abort() {
		this.abortController?.abort();
	}

	waitForIdle(): Promise<void> {
		return this.runningPrompt ?? Promise.resolve();
	}

	reset() {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set<string>();
		this._state.error = undefined;
		this.steeringQueue = [];
		this.followUpQueue = [];
	}

	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
		if (this._state.isStreaming) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		const model = this._state.model;
		if (!model) throw new Error("No model configured");

		let msgs: AgentMessage[];

		if (Array.isArray(input)) {
			msgs = input;
		} else if (typeof input === "string") {
			const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
			if (images && images.length > 0) {
				content.push(...images);
			}
			msgs = [
				{
					role: "user",
					content,
					timestamp: Date.now(),
				},
			];
		} else {
			msgs = [input];
		}

		await this._runLoop(msgs);
	}

	async continue() {
		if (this._state.isStreaming) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const messages = this._state.messages;
		if (messages.length === 0) {
			throw new Error("No messages to continue from");
		}
		const lastMessage = messages[messages.length - 1];
		if (lastMessage && lastMessage.role === "assistant") {
			const queuedSteering = this.dequeueSteeringMessages();
			if (queuedSteering.length > 0) {
				await this._runLoop(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUp = this.dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				await this._runLoop(queuedFollowUp);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this._runLoop(undefined);
	}

	private _processLoopEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_start":
				this._state.streamMessage = isAssistantMessage(event.message) ? event.message : this._state.streamMessage;
				break;

			case "message_update":
				this._state.streamMessage = event.message;
				break;

			case "message_end":
				this._state.streamMessage = null;
				this.appendMessage(event.message);
				break;

			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				if (isAssistantMessage(event.message) && event.message.errorMessage) {
					this._state.error = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.isStreaming = false;
				this._state.streamMessage = null;
				break;
		}

		this.emit(event);
	}

	private async _runLoop(messages?: AgentMessage[], options?: { skipInitialSteeringPoll?: boolean }) {
		const model = this._state.model;
		if (!model) throw new Error("No model configured");

		this.runningPrompt = new Promise<void>((resolve) => {
			this.resolveRunningPrompt = resolve;
		});

		this.abortController = new AbortController();
		this._state.isStreaming = true;
		this._state.streamMessage = null;
		this._state.error = undefined;

		const reasoning = this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel;

		const context: AgentContext = {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools,
		};

		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;

		const config: AgentLoopConfig = {
			model,
			reasoning,
			sessionId: this._sessionId,
			onPayload: this._onPayload,
			onProviderRetry: this._onProviderRetry,
			transport: this._transport,
			serviceTier: this._serviceTier,
			promptCacheKey: this._promptCacheKey,
			thinkingBudgets: this._thinkingBudgets,
			maxRetryDelayMs: this._maxRetryDelayMs,
			toolExecution: this._toolExecution,
			toolInactivityTimeoutMs: this._toolInactivityTimeoutMs,
			onTurnBoundary: this._onTurnBoundary
				? async (boundaryContext, signal) => {
						try {
							const replacement = await this._onTurnBoundary?.(boundaryContext, signal);
							if (!replacement) return undefined;
							this.replaceMessages(replacement);
							return replacement.slice();
						} catch {
							return undefined;
						}
					}
				: undefined,
			beforeToolCall: this._beforeToolCall
				? async (toolContext, signal) => {
						try {
							return await this._beforeToolCall?.(toolContext, signal);
						} catch {
							return undefined;
						}
					}
				: undefined,
			afterToolCall: this._afterToolCall
				? async (toolContext, signal) => {
						try {
							return await this._afterToolCall?.(toolContext, signal);
						} catch {
							return undefined;
						}
					}
				: undefined,
			convertToLlm: async (agentMessages) => {
				try {
					return await this.convertToLlm(agentMessages);
				} catch {
					return defaultConvertToLlm(agentMessages);
				}
			},
			transformContext: this.transformContext
				? async (agentMessages, signal) => {
						const transformContext = this.transformContext;
						try {
							if (!transformContext) {
								return agentMessages;
							}
							return await transformContext(agentMessages, signal);
						} catch {
							return agentMessages;
						}
					}
				: undefined,
			getApiKey: this.getApiKey
				? async (provider) => await this.getApiKey?.(provider)
				: undefined,
			refreshApiKey: this.refreshApiKey
				? async () => {
						try {
							return await this.refreshApiKey?.(model.provider);
						} catch {
							return undefined;
						}
					}
				: undefined,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				try {
					return this.dequeueSteeringMessages();
				} catch {
					return [];
				}
			},
			getFollowUpMessages: async () => {
				try {
					return this.dequeueFollowUpMessages();
				} catch {
					return [];
				}
			},
		};

		try {
			if (messages) {
				await runAgentLoop(
					messages,
					context,
					config,
					async (event) => this._processLoopEvent(event),
					this.abortController.signal,
					this.streamFn,
				);
			} else {
				await runAgentLoopContinue(
					context,
					config,
					async (event) => this._processLoopEvent(event),
					this.abortController.signal,
					this.streamFn,
				);
			}

			this._state.messages = context.messages.slice();
			} catch (err: unknown) {

				this._state.messages = this._state.messages.filter(
					(message) =>
						message.role !== "assistant" ||
						(message.stopReason !== "error" && message.stopReason !== "aborted"),
				);

			const errorMessage = errorMessageOf(err);
			const errorMsg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
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
				stopReason: this.abortController?.signal.aborted ? "aborted" : "error",
				errorMessage,
				timestamp: Date.now(),
			};

			this._state.error = errorMessage;
			this._processLoopEvent({
				type: "message_start",
				message: { ...errorMsg },
			});
			this._processLoopEvent({ type: "message_end", message: errorMsg });
			this._processLoopEvent({ type: "agent_end", messages: [errorMsg] });
		} finally {
			this._state.isStreaming = false;
			this._state.streamMessage = null;
			this._state.pendingToolCalls = new Set<string>();
			this.abortController = undefined;
			this.resolveRunningPrompt?.();
			this.runningPrompt = undefined;
			this.resolveRunningPrompt = undefined;
		}
	}

	private emit(e: AgentEvent) {
		for (const listener of this.listeners) {
			listener(e);
		}
	}
}
