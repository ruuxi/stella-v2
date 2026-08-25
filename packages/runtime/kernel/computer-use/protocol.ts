import type { SkyClient } from "./client.js";

export const MAX_NODE_REPL_CODE_BYTES = 1 * 1024 * 1024;
export const MAX_NODE_REPL_OUTPUT_BYTES = 1 * 1024 * 1024;
export const MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_NODE_REPL_PENDING_SKY_CALLS = 64;
export const MAX_NODE_REPL_PENDING_BROWSER_CALLS = 64;
export const MAX_NODE_REPL_PENDING_TOOL_CALLS = 64;
export const MAX_NODE_REPL_PENDING_CONNECT_CALLS = 16;
/**
 * How long an evaluation waits, after the cell's own code finishes, for
 * nested `tools.*` calls the cell started without awaiting. A nested call
 * that never settles (wedged bridge, dead transport) must fail the
 * evaluation with a diagnosis instead of holding the tool call open until
 * the whole-kernel eval timeout kills the REPL (or forever).
 */
export const DEFAULT_NODE_REPL_TOOL_DRAIN_TIMEOUT_MS = 60_000;

/**
 * Reserved in-REPL tool name for the host-side catalog search. Always
 * installed on the worker's `tools` object and intercepted by the kernel
 * before the allowlist gate; `$`-prefixed names are rejected at tool
 * registration so no real tool can shadow it. The worker source keeps the
 * literal `"$search"` inline (it is serialized via `toString()`), so this
 * constant must never drift from that literal.
 */
export const NODE_REPL_TOOL_SEARCH_NAME = "$search";
/** Reserved exact-tool schema lookup intrinsic; see the `$search` note above. */
export const NODE_REPL_TOOL_DESCRIBE_NAME = "$describe";

export type SkyMethod = keyof SkyClient;
export type BrowserMethod = "command" | "chain" | "use";
/** Methods of the in-REPL `connect` client, dispatched host-side. */
export type ConnectMethod =
  | "discover"
  | "connectors"
  | "actions"
  | "schema"
  | "call"
  | "addMcp"
  | "remove";

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
};

export type NodeReplWorkerData = {
  cwd: string;
  moduleUrl: string;
  maxCodeBytes: number;
  maxEvalOutputBytes: number;
  maxProtocolMessageBytes: number;
  maxPendingSkyCalls: number;
  maxPendingBrowserCalls: number;
  maxPendingToolCalls: number;
  maxPendingConnectCalls: number;
  maxToolDrainWaitMs: number;
  toolNames: string[];
};

export type ParentToNodeReplWorkerMessage =
  | {
      type: "evaluate";
      evaluationId: number;
      code: string;
      /**
       * Current allowed tool names (exclusions already applied). Sent with
       * every evaluate so the worker's `tools` object tracks tools that are
       * added or removed mid-session; omitted → the worker keeps its
       * current set.
       */
      toolNames?: string[];
    }
  | {
      type: "sky-result";
      callId: number;
      ok: true;
      value: unknown;
    }
  | {
      type: "sky-result";
      callId: number;
      ok: false;
      error: SerializedError;
    }
  | {
      type: "browser-result";
      callId: number;
      ok: true;
      value: unknown;
    }
  | {
      type: "browser-result";
      callId: number;
      ok: false;
      error: SerializedError;
    }
  | {
      type: "tool-result";
      callId: number;
      ok: true;
      value: unknown;
    }
  | {
      type: "tool-result";
      callId: number;
      ok: false;
      error: SerializedError;
    }
  | {
      type: "connect-result";
      callId: number;
      ok: true;
      value: unknown;
    }
  | {
      type: "connect-result";
      callId: number;
      ok: false;
      error: SerializedError;
    };

export type WorkerToNodeReplParentMessage =
  | { type: "ready" }
  | { type: "evaluation-result"; evaluationId: number; output: string }
  | {
      type: "evaluation-error";
      evaluationId: number;
      error: SerializedError;
    }
  | {
      type: "sky-call";
      evaluationId: number;
      callId: number;
      method: SkyMethod;
      args: unknown[];
    }
  | {
      type: "browser-call";
      evaluationId: number;
      callId: number;
      method: BrowserMethod;
      args: unknown[];
    }
  | {
      type: "tool-call";
      evaluationId: number;
      callId: number;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "connect-call";
      evaluationId: number;
      callId: number;
      method: ConnectMethod;
      args: unknown[];
    };
