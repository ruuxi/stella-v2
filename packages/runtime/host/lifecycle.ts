import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { causeToThrowable } from "./lifecycle/errors.js";
import {
  startOrAttachWorkerEffect,
  stopRunningWorkerEffect,
} from "./lifecycle/attach.js";
import type {
  LifecycleConnection,
  LifecycleStartOptions,
} from "./lifecycle/options.js";

/**
 * Host-side lifecycle: discover or launch the detached worker and
 * return a connected local-IPC Socket the caller can wrap with a JSON-RPC
 * peer.
 *
 * This file is the plain-Promise facade over the Effect implementation in
 * `host/lifecycle/` (attach pipeline, lockfile resource, UDS readiness
 * probe, spawn adoption, kill ladder). Same exported names, signatures,
 * decisions, timing budgets, and error strings as the pre-Effect
 * implementation; Effect types never cross this boundary.
 *
 * Lifecycle ops are serialized per-stellaAppDir via a flock-style file
 * (`runtime.host.lock`) so concurrent host starts don't race the spawn.
 */

export type { LifecycleConnection, LifecycleStartOptions };

const lifecycleRuntime = ManagedRuntime.make(Layer.empty);

/** Run a lifecycle Effect, rejecting with the original failure object. */
const runLifecycle = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await lifecycleRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw causeToThrowable(exit.cause);
};

/**
 * Resolve a connected socket to the runtime worker, spawning a new
 * worker if one is not already running for `stellaAppDir`. Idempotent
 * across hosts thanks to the host-side lock.
 */
export const startOrAttachWorker = async (
  options: LifecycleStartOptions,
): Promise<LifecycleConnection> =>
  runLifecycle(Effect.scoped(startOrAttachWorkerEffect(options)));

/**
 * Stop a running worker by SIGTERM-then-SIGKILL. The worker also has its
 * own self-shutdown-on-idle timer, so this is mostly used by tests and
 * by `runtime restart` flows that want a synchronous tear-down.
 */
export const stopRunningWorker = async (
  stellaAppDir: string,
  options?: { graceMs?: number },
): Promise<{ stopped: boolean; pid: number | null }> =>
  runLifecycle(stopRunningWorkerEffect(stellaAppDir, options));
