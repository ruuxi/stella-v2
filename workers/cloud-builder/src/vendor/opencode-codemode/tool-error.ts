import { Schema } from "effect"

/** Safe operational refusal from a standard tool pack, reported as `ToolFailure`. */
// Stella: effect 4.0.0 names this `Schema.TaggedError` (upstream pins a beta with `TaggedErrorClass`).
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Creates a tool refusal whose message is safe to include in an execution diagnostic. */
export const toolError = (message: string, cause?: unknown): ToolError =>
  new ToolError({ message, ...(cause === undefined ? {} : { cause }) })
