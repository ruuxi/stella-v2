/**
 * What recovery does with a tool call its process never answered.
 *
 * A turn resumed after isolate loss (a deploy, an eviction) finds its journal
 * ending in an assistant message whose tool calls have no results. Each one is
 * answered here before the loop continues, by the call's declared replay
 * policy (`ToolReplayPolicy`, the field desktop `ToolDefinition`s carry):
 *
 *   - `safe` / `keyed`: rerun with the stored arguments. A `keyed` tool finds
 *     its first attempt's effect through an id derived from the tool call id,
 *     so the rerun reports that effect instead of repeating it.
 *   - `unsafe`, the call that was in flight: answered as interrupted. Its
 *     effect is unknown and the model is told to verify before assuming.
 *   - `unsafe`, a later call of the same message: both hosts run tool calls
 *     sequentially and journal each result the moment it settles, so only the
 *     first unanswered call can have started. A later one provably never ran,
 *     and the model is told it can simply issue it again.
 *
 * An undeclared tool is `unsafe`.
 */

import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { ToolReplayPolicy } from "@stella/runtime/kernel/tools/defs/replay-policy.js";
import { INTERRUPTED_TOOL_RESULT_TEXT } from "./agent-turn-journal.js";

export type { ToolReplayPolicy };

export type ReplayableAgentTool = AgentTool & { replay?: ToolReplayPolicy };

export const INTERRUPTED_TOOL_CALL_TEXT = INTERRUPTED_TOOL_RESULT_TEXT;

export const NOT_STARTED_TOOL_CALL_TEXT =
  "This tool call never started: the turn was interrupted before it could run. Nothing was done; call it again if it is still needed.";

export const mayRerun = (policy: ToolReplayPolicy | undefined): boolean =>
  policy === "safe" || policy === "keyed";

export const replayPolicyOf = (
  tools: readonly AgentTool[],
  toolName: string,
): ToolReplayPolicy =>
  (tools.find((tool) => tool.name === toolName) as
    | ReplayableAgentTool
    | undefined)?.replay ?? "unsafe";

export type OpenToolCall = Readonly<{
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
}>;

export type OpenToolCallDisposition = "rerun" | "interrupted" | "not_started";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toolResultMessage = (
  call: OpenToolCall,
  result: Pick<AgentToolResult<unknown>, "content" | "details" | "isError">,
  now: number,
): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    content: result.content,
    details: result.details,
    isError: result.isError === true,
    timestamp: now,
  }) as AgentMessage;

/**
 * Answer one unanswered call. `started` is whether this call may have begun
 * executing — true only for the first unanswered call of the message.
 * A rerun that the turn's own abort interrupts rethrows: the turn is being
 * stopped, and recording a result for it would be a lie either way.
 */
export const resolveOpenToolCall = async (args: {
  tools: readonly AgentTool[];
  call: OpenToolCall;
  started: boolean;
  signal: AbortSignal;
  now: () => number;
}): Promise<{ message: AgentMessage; disposition: OpenToolCallDisposition }> => {
  const { call } = args;
  const tool = args.tools.find((candidate) => candidate.name === call.toolName);
  if (tool && mayRerun((tool as ReplayableAgentTool).replay)) {
    try {
      const result = await tool.execute(
        call.toolCallId,
        call.params as never,
        args.signal,
      );
      return {
        message: toolResultMessage(call, result, args.now()),
        disposition: "rerun",
      };
    } catch (error) {
      args.signal.throwIfAborted();
      return {
        message: toolResultMessage(
          call,
          {
            content: [{ type: "text", text: errorText(error) }],
            details: null,
            isError: true,
          },
          args.now(),
        ),
        disposition: "rerun",
      };
    }
  }
  const text = args.started
    ? INTERRUPTED_TOOL_CALL_TEXT
    : NOT_STARTED_TOOL_CALL_TEXT;
  return {
    message: toolResultMessage(
      call,
      { content: [{ type: "text", text }], details: null, isError: true },
      args.now(),
    ),
    disposition: args.started ? "interrupted" : "not_started",
  };
};
