import { METHOD_NAMES } from "@stella/contracts/protocol";
import type { RpcRequestOptions } from "@stella/contracts/protocol/rpc-peer";

export const AGENT_RUN_LIVENESS_INTERVAL_MS = 60_000;
export const AGENT_RUN_UNRESPONSIVE_MS = 5 * 60_000;

/**
 * Every run the host hands to the worker and then waits on for as long as it
 * takes: a placed or local agent run, and a chat turn handed to this computer
 * from another device. None of them has a deadline, because the work decides
 * how long it takes; a wedged worker is caught by asking it for its health
 * every minute instead, and five unanswered checks in a row fail the run.
 */
export const BLOCKING_RUN_RPC_OPTIONS: RpcRequestOptions = {
  timeoutMs: null,
  liveness: {
    method: METHOD_NAMES.INTERNAL_WORKER_HEALTH,
    intervalMs: AGENT_RUN_LIVENESS_INTERVAL_MS,
    unresponsiveMs: AGENT_RUN_UNRESPONSIVE_MS,
  },
};

export const AGENT_RUN_RPC_OPTIONS = BLOCKING_RUN_RPC_OPTIONS;
