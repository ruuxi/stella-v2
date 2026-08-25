import type { SkyClient } from "./client.js";

export const MAX_NODE_REPL_CODE_BYTES = 1 * 1024 * 1024;
export const MAX_NODE_REPL_OUTPUT_BYTES = 1 * 1024 * 1024;
export const MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_NODE_REPL_PENDING_SKY_CALLS = 64;
export const MAX_NODE_REPL_PENDING_BROWSER_CALLS = 64;
export const MAX_NODE_REPL_PENDING_TOOL_CALLS = 64;
export const MAX_NODE_REPL_PENDING_CONNECT_CALLS = 16;

export const DEFAULT_NODE_REPL_TOOL_DRAIN_TIMEOUT_MS = 60_000;

export const NODE_REPL_TOOL_SEARCH_NAME = "$search";
/** Reserved exact-tool schema lookup intrinsic; see the `$search` note above. */
export const NODE_REPL_TOOL_DESCRIBE_NAME = "$describe";

export type SkyMethod = keyof SkyClient;
export type BrowserMethod = "command" | "chain" | "use";

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

export type NodeReplContentItem =
  | { type: "text"; text: string }
  | {
      type: "image";
      path: string;
      mimeType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      detail?: NodeReplImageDetail;
      alreadyAttached?: boolean;

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
