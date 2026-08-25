import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
} from "../../ai/types.js";
import type { streamSimple } from "../../ai/stream.js";
import { StringEnum } from "../../ai/utils/typebox-helpers.js";
import type { Static, TSchema } from "@sinclair/typebox";

export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

export const ToolExecutionModeSchema = StringEnum(
	["sequential", "parallel"] as const,
	{
		description: "How tool calls from a single assistant message are executed.",
		default: "sequential",
	},
);
export type ToolExecutionMode = Static<typeof ToolExecutionModeSchema>;

export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;
	context: AgentContext;
}

export interface AfterToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;

	result: AgentToolResult<unknown>;

	isError: boolean;
	context: AgentContext;
}

export interface AgentTurnBoundaryContext {
	context: AgentContext;
	completedMessages: AgentMessage[];

	pendingMessages: AgentMessage[];
}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<Api>;

	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	refreshApiKey?: () => Promise<string | undefined> | string | undefined;

	getSteeringMessages?: () => Promise<AgentMessage[]>;

	getFollowUpMessages?: () => Promise<AgentMessage[]>;

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

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CustomAgentMessages {

	runtimeInternal?: {
		role: "runtimeInternal";
		content: string | (TextContent | ImageContent)[];
		timestamp: number;
		customType?: string;
    eventId?: string;
		display?: boolean;
	};

	__customAgentMessagesBrand?: never;
}

export type AgentMessage = Message | NonNullable<CustomAgentMessages[keyof CustomAgentMessages]>;

export interface AgentState {
	systemPrompt: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T> {

	content: (TextContent | ImageContent)[];

	details: T;

	isError?: boolean;

	modelOutputTokens?: number;
}

export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
	label: string;

	workingText?: string;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool[];
}

export type AgentEvent =

	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }

	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }

	| { type: "message_start"; message: AgentMessage }

	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }

	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			statusText?: string;
			args: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: AgentToolResult<unknown>;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
	  };
