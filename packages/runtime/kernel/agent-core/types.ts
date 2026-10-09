import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";
import type { StoredImageContent } from "../storage/shared.js";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<
  AssistantMessage["content"][number],
  { type: "toolCall" }
>;

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@stella/kernel/agent-core" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
  /** Internal prompt/context messages that should participate in LLM context without masquerading as user-typed chat. */
  runtimeInternal?: {
    role: "runtimeInternal";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
    customType?: string;
    eventId?: string;
    display?: boolean;
  };
  /** Preserves declaration merging without widening the indexed union. */
  __customAgentMessagesBrand?: never;
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage =
  | Message
  | NonNullable<CustomAgentMessages[keyof CustomAgentMessages]>;

export interface AgentToolResult<T> {
  // Content blocks supporting text and images
  content: (TextContent | StoredImageContent)[];
  // Details to be displayed in a UI or logged
  details: T;
  // Native adapters set this when execution completed with a tool-level failure.
  isError?: boolean;
  // Optional model-facing text budget; durable content remains raw.
  modelOutputTokens?: number;
}

// Callback for streaming tool execution updates
export type AgentToolUpdateCallback<T = unknown> = (
  partialResult: AgentToolResult<T>,
) => void;

/** A tool a model can call, with the function that runs it. */
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
> {
  name: string;
  description: string;
  parameters: TParameters;
  // A human-readable label for the tool to be displayed in UI
  label: string;
  // User-facing status text while the tool is running.
  workingText?: string;
  /**
   * Optional compatibility shim for raw tool-call arguments, run before
   * schema validation. Must return an object that matches `TParameters`;
   * return the input unchanged when no rewrite applies.
   */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}
