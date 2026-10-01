import { EventEmitter } from "node:events";
import type { JsonRpcMessage } from "@stella/contracts/protocol";
import {
  createRuntimeUnavailableError,
  JsonRpcPeer,
} from "@stella/contracts/protocol/rpc-peer";
import type { WorkerConnection } from "./worker-lifecycle.js";

/**
 * Two JSON-RPC peers wired back to back in one process. Each message is
 * copied through JSON, exactly what a socket would carry, and delivered on a
 * microtask so neither side re-enters the other synchronously.
 */
export const createInprocPeerPair = (
  options: { onError?: (error: unknown) => void } = {},
): { left: JsonRpcPeer; right: JsonRpcPeer; close: () => void } => {
  let left: JsonRpcPeer | null = null;
  let right: JsonRpcPeer | null = null;
  const deliverTo =
    (target: () => JsonRpcPeer | null) => (message: JsonRpcMessage) => {
      const copy = JSON.parse(JSON.stringify(message)) as JsonRpcMessage;
      queueMicrotask(() => {
        const peer = target();
        if (peer && !peer.isClosed()) void peer.handleMessage(copy);
      });
    };
  left = new JsonRpcPeer(deliverTo(() => right), options);
  right = new JsonRpcPeer(deliverTo(() => left), options);
  const close = () => {
    const reason = createRuntimeUnavailableError(
      "Runtime RPC transport is closed.",
    );
    left?.dispose(reason);
    right?.dispose(reason);
  };
  return { left, right, close };
};

/**
 * The worker's side of an in-process host: whatever accepts one peer and
 * returns how to detach it (the worker's peer broker).
 */
export type InprocWorkerAttach = (peer: JsonRpcPeer) => () => void;

/**
 * A process-shaped handle for a worker that shares this process. The
 * lifecycle controller disconnects by ending `stdin` and waiting for `exit`;
 * here that detaches the peer. There is no process to kill.
 */
const buildInprocProcessShim = (
  disconnect: () => void,
): WorkerConnection["process"] => {
  const emitter = new EventEmitter() as WorkerConnection["process"];
  const state = { exitCode: null as number | null };
  const exit = () => {
    if (state.exitCode != null) return;
    state.exitCode = 0;
    disconnect();
    emitter.emit("exit", 0, null);
  };
  Object.defineProperty(emitter, "exitCode", {
    get: () => state.exitCode,
  });
  Object.assign(emitter, {
    pid: process.pid,
    signalCode: null,
    stdin: { end: exit },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => {
      exit();
      return true;
    },
  });
  return emitter;
};

/** A `createConnectionAsync` for the lifecycle controller, in process. */
export const buildInprocConnectionFactory = (
  attachWorker: InprocWorkerAttach,
  options: { onError?: (error: unknown) => void } = {},
) => {
  return async (_workerEntryPath: string): Promise<WorkerConnection> => {
    const pair = createInprocPeerPair(options);
    const detach = attachWorker(pair.right);
    return {
      process: buildInprocProcessShim(() => {
        detach();
        pair.close();
      }),
      peer: pair.left,
      pid: process.pid,
      attachedToExistingWorker: false,
    };
  };
};
