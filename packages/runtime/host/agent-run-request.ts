import { METHOD_NAMES } from "@stella/contracts/protocol";
import type { RpcRequestOptions } from "@stella/contracts/protocol/rpc-peer";

export const AGENT_RUN_LIVENESS_INTERVAL_MS = 60_000;
export const AGENT_RUN_UNRESPONSIVE_MS = 5 * 60_000;

export const AGENT_RUN_RPC_OPTIONS: RpcRequestOptions = {
  timeoutMs: null,
  liveness: {
    method: METHOD_NAMES.INTERNAL_WORKER_HEALTH,
    intervalMs: AGENT_RUN_LIVENESS_INTERVAL_MS,
    unresponsiveMs: AGENT_RUN_UNRESPONSIVE_MS,
  },
};
