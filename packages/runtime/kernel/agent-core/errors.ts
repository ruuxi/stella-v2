import { Schema } from "effect";

/**
 * Tagged failures for the agent-core loop (M5 surface 3).
 *
 * The plain-Promise facades in `agent-loop.ts` rethrow these across the
 * Effect boundary via `Cause.squash`, and the tool-window failures surface
 * as error tool-result text via `.message`, so every escaping message is
 * byte-identical to the string the pre-Effect loop produced. Do not reword
 * them.
 */

/** Parity error for continuing a loop with an empty context. */
export class AgentContinueEmptyContextError extends Schema.TaggedErrorClass<AgentContinueEmptyContextError>()(
	"@stella/runtime/kernel/agent-core/AgentContinueEmptyContextError",
	{},
) {
	override get message() {
		return "Cannot continue: no messages in context";
	}
}

/** Parity error for continuing a loop whose context ends on an assistant message. */
export class AgentContinueFromAssistantError extends Schema.TaggedErrorClass<AgentContinueFromAssistantError>()(
	"@stella/runtime/kernel/agent-core/AgentContinueFromAssistantError",
	{},
) {
	override get message() {
		return "Cannot continue from message role: assistant";
	}
}

/**
 * A tool emitted no `onUpdate` progress within the inactivity bound and was
 * cancelled. This error becomes both the tool's abort reason and the error
 * tool-result text the model sees; the agent itself keeps running.
 */
export class ToolInactivityTimeoutError extends Schema.TaggedErrorClass<ToolInactivityTimeoutError>()(
	"@stella/runtime/kernel/agent-core/ToolInactivityTimeoutError",
	{ toolName: Schema.String, timeoutMs: Schema.Number },
) {
	override get message() {
		return `Tool ${this.toolName} produced no output for ${Math.round(this.timeoutMs / 1000)}s and was cancelled. The agent may retry or continue without it.`;
	}
}

/**
 * A cancelled tool kept running past the abort grace and was abandoned. The
 * pending tool call settles with this message as an error tool result; the
 * tool's external work is left to the tool host's own reaping.
 */
export class ToolAbortAbandonedError extends Schema.TaggedErrorClass<ToolAbortAbandonedError>()(
	"@stella/runtime/kernel/agent-core/ToolAbortAbandonedError",
	{ toolName: Schema.String, graceMs: Schema.Number },
) {
	override get message() {
		return `Tool ${this.toolName} ignored cancellation for ${Math.round(this.graceMs / 1000)}s and was abandoned.`;
	}
}
