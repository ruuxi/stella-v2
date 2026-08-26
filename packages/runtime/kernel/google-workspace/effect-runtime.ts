/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one module-level ManagedRuntime for the Google Workspace tree (M5
 * kernel/google-workspace pass), plus the shared IO adapters.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts,
 * kernel/connectors/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - Promise facades reject with the ORIGINAL failure object (`Cause.squash`),
 *   so callers observe byte-identical error objects and messages (the
 *   connection-state strings are user-visible and matched upstream).
 * - Google API calls keep gaxios' own retry/backoff configuration
 *   (`GaxiosConfig.ts` — retry 3, statuses [100..199, 408, 429, 500..599],
 *   1s delay). Re-expressing that as a Schedule would double-retry; the
 *   Effect layer owns only the token/profile IO seams around it.
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";

/** Shared runtime for every Effect run in `kernel/google-workspace`. */
export const googleWorkspaceRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a Google Workspace Effect on the shared runtime, rejecting with the
 * ORIGINAL failure object (`Cause.squash`) so facade callers see the exact
 * error the pre-Effect code would have thrown.
 */
export const runGoogleWorkspaceEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await googleWorkspaceRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/**
 * Wrap one async Google Workspace IO call (connector token-store access,
 * googleapis client calls, attachment fs writes); failures carry the
 * original error object.
 */
export const tryGoogleWorkspaceOp = <A>(
  op: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: op,
    catch: (error) => error,
  });

/** Wrap one sync Google Workspace call; failures carry the original error. */
export const tryGoogleWorkspaceSync = <A>(
  op: () => A,
): Effect.Effect<A, unknown> =>
  Effect.try({
    try: op,
    catch: (error) => error,
  });
