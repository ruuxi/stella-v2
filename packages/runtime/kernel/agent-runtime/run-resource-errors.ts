/**
 * Tagged failures for run-owned resources (M5 surface 3, phase 2 batch 5).
 *
 * Same idiom and boundary policy as `host/lifecycle/errors.ts`: the classes
 * are Effect Data tagged errors internally, but every message that crosses
 * the promise boundary is byte-identical to the plain string the resource
 * seam surfaced before typing. Do not reword them — the agent loop's error
 * tool results and run terminal records carry these verbatim.
 */

import * as Data from "effect/Data";

/**
 * A second concurrent execution was attempted for a toolCallId that is
 * still live. Thrown by the tool execution supervisor's duplicate guard;
 * the agent loop's existing catch maps it to a canonical error tool
 * result, so the model sees the same message a plain Error produced.
 */
export class DuplicateToolExecutionError extends Data.TaggedError(
  "@stella/runtime/agent-runtime/DuplicateToolExecutionError",
)<{ readonly toolCallId: string; readonly toolName: string }> {
  override get message() {
    return `Tool call ${this.toolCallId} (${this.toolName}) is already executing.`;
  }
}

/**
 * A cancelled run resource (provider stream, tool call, external engine
 * turn) ignored its abort signal past the join grace and was released as
 * abandoned. Never escapes to callers — abandonment deliberately does not
 * change any public outcome — but the lifecycle modules log this message
 * and telemetry keys on the tag.
 */
export class RunResourceAbandonedError extends Data.TaggedError(
  "@stella/runtime/agent-runtime/RunResourceAbandonedError",
)<{ readonly label: string; readonly graceMs: number }> {
  override get message() {
    return `Run resource ${this.label} ignored cancellation for ${this.graceMs}ms and was abandoned.`;
  }
}
