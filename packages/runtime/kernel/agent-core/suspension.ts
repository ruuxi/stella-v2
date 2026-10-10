import {
  isCloudBrowserSuspension,
  type CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";

/**
 * A trusted control-flow failure, not a model-facing tool failure.
 *
 * The descriptor is deliberately the secret-free shared contract. The error
 * message is fixed so a gateway response can never smuggle browser state into
 * logs or an assistant error placeholder through `Error.message`.
 */
export class AgentToolSuspendedError extends Error {
  readonly suspension: CloudBrowserSuspension;

  constructor(suspension: CloudBrowserSuspension) {
    if (!isCloudBrowserSuspension(suspension)) {
      throw new TypeError("Agent tool suspension descriptor is invalid.");
    }
    super("Agent tool execution is waiting for the user.");
    this.name = "AgentToolSuspendedError";
    this.suspension = Object.freeze({ ...suspension });
  }
}

/** Structural fallback keeps the control signal recognizable across bundles. */
export const isAgentToolSuspendedError = (
  value: unknown,
): value is AgentToolSuspendedError =>
  value instanceof AgentToolSuspendedError ||
  (typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "AgentToolSuspendedError" &&
    isCloudBrowserSuspension((value as { suspension?: unknown }).suspension));
