/**
 * Tagged failures for run-owned resources (M5 surface 3, phase 2 batch 5).
 *
 * Same idiom and boundary policy as `host/lifecycle/errors.ts`: the class
 * is an Effect Data tagged error internally, but its message is
 * byte-identical to the plain string the resource seam surfaced before
 * typing. Do not reword it — logs and telemetry carry it verbatim.
 */

import * as Data from "effect/Data";

/**
 * A cancelled run resource (an external engine turn) ignored its abort signal past the join grace and was released as
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
