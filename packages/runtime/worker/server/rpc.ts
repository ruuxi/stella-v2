import { Effect, Exit, type ManagedRuntime } from "effect";
import type { WorkerPeerLike } from "../peer-broker.js";
import { causeToThrowable } from "./errors.js";
import type * as HostBus from "./host-bus.js";
import type * as ModelCatalog from "./model-catalog.js";
import type * as WorkerSessions from "./sessions.js";

/**
 * The thin JSON-RPC adapter over the service layer. Handlers are Effects
 * over the base worker services; dispatch runs each request on the shared
 * ManagedRuntime (one run per request preserves the old unbounded handler
 * concurrency) and rethrows failures as the original error objects so the
 * peer serializes the same `error.message` strings as before.
 */
export type WorkerRpcContext =
  | HostBus.Service
  | ModelCatalog.Service
  | WorkerSessions.Service;

export type WorkerRpcHandler = (
  params: unknown,
) => Effect.Effect<unknown, unknown, WorkerRpcContext>;

export type WorkerRpcHandlers = Record<string, WorkerRpcHandler>;

/** Adapt an imperative promise into a handler Effect, failing with the raw
 * thrown value so the wire error is unchanged. */
export const fromPromise = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: f, catch: (error) => error });

export const attachWorkerRpcHandlers = (
  peer: WorkerPeerLike,
  runtime: ManagedRuntime.ManagedRuntime<WorkerRpcContext, never>,
  handlers: WorkerRpcHandlers,
): void => {
  for (const [method, handler] of Object.entries(handlers)) {
    peer.registerRequestHandler(method, async (params) => {
      const exit = await runtime.runPromiseExit(handler(params));
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      throw causeToThrowable(exit.cause);
    });
  }
};
