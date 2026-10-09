/**
 * Tool calls an agent whose conversation runs in the cloud sends to one of
 * the owner's computers, relayed by the owner gate over that computer's
 * presence socket. The agent's brain (its conversation, in the
 * conversation's Durable Object) stays where it is; only the call runs on
 * the computer, through the desktop runtime's own tool host, exactly as the
 * agent's container would have run it.
 *
 *   conversation object --RPC--> owner gate --presence socket--> computer
 *   conversation object <--RPC-- owner gate <--result frame------ computer
 *
 * One call is one `tool.call` frame. The computer answers `tool.accepted`
 * at once, then exactly one `tool.result` or `tool.error`. Output is not
 * streamed: the container path returns a call's output when it ends too, and
 * a command that outlives its yield time hands back a session that
 * `write_stdin` drives, so no call needs to stream to make progress.
 *
 * Idempotency: the request id is derived from the conversation, the agent
 * and the model's tool call id, so it is the same on every attempt of one
 * call. The gate joins a call already pending under that id, and the
 * computer answers a call it already ran (or is running) from that run
 * instead of running it again.
 *
 * Authority: the gate relays only to a device that is online, ready, and
 * whose owner enabled remote execution on it (`remoteExecution: enabled`),
 * checked on every call. The frames carry no credential: the socket is the
 * device's proven presence socket.
 */

/** The file and shell tools an agent's container serves, which a computer serves the same way. */
export const DEVICE_TOOL_NAMES = [
  "Bash",
  "exec_command",
  "write_stdin",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "apply_patch",
] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

export const isDeviceToolName = (value: unknown): value is DeviceToolName =>
  typeof value === "string" &&
  (DEVICE_TOOL_NAMES as readonly string[]).includes(value);

export const DEVICE_TOOL_LIMITS = {
  requestId: 160,
  /** A call's JSON (a Write's content included). */
  callBytes: 1_000_000,
  /** A result's JSON, images included; one presence frame carries it. */
  resultBytes: 1_000_000,
  /** Calls one computer runs at once. */
  concurrentPerDevice: 8,
} as const;

/** How long the gate waits for the computer to take a call (`tool.accepted`). */
export const DEVICE_TOOL_ACCEPT_TIMEOUT_MS = 20_000;
/** The most one call may run; a shell command's own timeout ends it far sooner. */
export const DEVICE_TOOL_RUN_TIMEOUT_MS = 20 * 60_000;
/**
 * How long a call waits for its computer to come back after its socket
 * dropped. A computer reconnects on its own (to present a fresh token, or
 * after a network blip) and then sends the result it finished meanwhile.
 */
export const DEVICE_TOOL_RECONNECT_GRACE_MS = 20_000;

/** What a computer is asked: one tool call, or a description of itself. */
export type DeviceToolCall =
  | {
      kind: "tool";
      toolName: DeviceToolName;
      params: Record<string, unknown>;
      /** The model's tool call id. */
      callId: string;
      /** The Stella conversation the agent belongs to. */
      conversationId: string;
      /** The agent's thread; its shell sessions are kept apart by it. Absent for Stella herself. */
      threadId?: string;
    }
  /** Where tools run on it: what an agent is told when it switches there. */
  | { kind: "describe" };

/** A computer's answer to `describe`. */
export type DeviceToolDescription = {
  hostname: string;
  /** `process.platform` and the OS release. */
  platform: string;
  /** `~` there, and a shell command's working directory when none is given. */
  home: string;
};

/** A tool call's outcome, as the model reads it. */
export type DeviceToolResult = {
  text: string;
  isError?: boolean;
  images?: Array<{ data: string; mimeType: string }>;
  details?: unknown;
};

export type DeviceToolErrorCode =
  /** No live presence socket, or it dropped and did not come back. */
  | "device_offline"
  /** The owner has not enabled remote execution on it. */
  | "not_enabled"
  /** Online but not taking work (signed out, cloud sync off, starting up). */
  | "not_ready"
  /** Its Stella does not run tools for the cloud (an older version). */
  | "unsupported"
  | "device_busy"
  | "timeout"
  | "too_large"
  | "bad_request"
  | "canceled"
  | "failed";

export type DeviceToolOutcome =
  | { ok: true; result: DeviceToolResult }
  | { ok: true; description: DeviceToolDescription }
  | { ok: false; code: DeviceToolErrorCode; message: string };

/** Server -> computer, on the presence socket. */
export type DeviceToolServerFrame =
  | { type: "tool.call"; requestId: string; callJson: string }
  /** The caller stopped waiting (a pause or stop); stop the call. */
  | { type: "tool.cancel"; requestId: string };

/** Computer -> server, on the presence socket. */
export type DeviceToolDeviceFrame =
  | { type: "tool.accepted"; requestId: string }
  /** `DeviceToolResult` JSON for a tool, `DeviceToolDescription` JSON for `describe`. */
  | { type: "tool.result"; requestId: string; resultJson: string }
  | {
      type: "tool.error";
      requestId: string;
      code: DeviceToolErrorCode;
      message: string;
    };
