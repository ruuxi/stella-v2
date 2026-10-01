/**
 * The runtime client protocol: what an app process (Electron today, the
 * launcher later) speaks to the runtime over its socket.
 *
 * The runtime is one process running the worker and the runtime host. A
 * client attaches, calls host methods, receives host events, and serves the
 * host's callbacks that need the app: secrets kept in the OS keychain,
 * prompts, notifications and windows. The runtime outlives its clients, so
 * an app restart loses nothing; a callback made while no client is attached
 * waits for the next one.
 */

import type { RuntimeInitializeParams } from "./index.js";

/** Answered by the socket's readiness probe; a mismatch respawns the runtime. */
export const STELLA_RUNTIME_CLIENT_PROTOCOL_VERSION = "client-v1";

export const RUNTIME_CLIENT_METHODS = {
  /** Client → runtime: attach, creating the host on first attach. */
  ATTACH: "runtime.attach",
  /** Client → runtime: call one host method. */
  CALL: "runtime.call",
  /**
   * Client → runtime: stop the runtime (a reset that deletes its files). It
   * exits; the next attach starts a fresh one.
   */
  SHUTDOWN: "runtime.shutdown",
  /** Runtime → client request: run one host callback in the app. */
  HOST_HANDLER: "runtime.hostHandler",
  /** Runtime → client notification: one host event. */
  EVENT: "runtime.event",
} as const;

export type RuntimeClientAttachParams = {
  initializeParams: Omit<RuntimeInitializeParams, "protocolVersion">;
  disableLocalScheduler?: boolean;
};

export type RuntimeClientAttachResult = {
  pid: number;
  /** False when this client joined a host an earlier client started. */
  hostCreated: boolean;
};

export type RuntimeClientCallParams = { method: string; args: unknown[] };

export type RuntimeClientHostHandlerParams = { name: string; args: unknown[] };

export type RuntimeClientEventParams = { name: string; payload: unknown };
