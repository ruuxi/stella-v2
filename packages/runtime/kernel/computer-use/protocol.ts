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

export type NodeReplImageDetail = "auto" | "low" | "high" | "original";

/**
 * Typed output emitted by the REPL worker. The worker never manufactures
 * model-facing attachment markers; the host formats those only at the legacy
 * ToolResult boundary while retaining this structured representation for
 * resumable cells and future native multimodal delivery.
 */
export type NodeReplContentItem =
  | { type: "text"; text: string }
  | {
      type: "image";
      path: string;
      mimeType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      detail?: NodeReplImageDetail;
      alreadyAttached?: boolean;
      /** Kernel-owned temporary file; the outer adapter deletes it after read. */
      deleteAfterAttach?: boolean;
    }
  | {
      type: "audio";
      path: string;
      mimeType?: string;
    };

export type NodeReplResetReason =
  | "explicit"
  | "timeout"
  | "cancelled"
  | "terminated"
  | "uncaught_error"
  | "worker_error"
  | "protocol_error"
  | "transport_error"
  | "closed";

export type NodeReplResetReceipt = Readonly<{
  reset: true;
  reason: NodeReplResetReason;
  previousGeneration: number;
  nextGeneration: number;
  bindingsDiscarded: true;
  requestedAt: number;
}>;

export type NodeReplWorkerData = {
  cwd: string;
  generation: number;
  generationStartedAt: number;
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
  | {
      type: "evaluation-content";
      evaluationId: number;
      cursor: number;
      item: NodeReplContentItem;
    }
  | {
      type: "reset-request";
      evaluationId: number;
      requestedAt: number;
    }
  | {
      type: "evaluation-result";
      evaluationId: number;
      finalCursor: number;
    }
  | {
      type: "evaluation-error";
      evaluationId: number;
      error: SerializedError;
      finalCursor: number;
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
