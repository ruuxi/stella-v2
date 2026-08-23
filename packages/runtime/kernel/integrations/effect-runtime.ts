/**
 * The one module-level ManagedRuntime for the external-engine integrations
 * tree (M5 kernel/integrations pass), plus the Effect combinators the
 * claude-code / codex CLI runtimes share.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/shell.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - The CLI child-process kill ladders (SIGINT/SIGTERM → bounded wait →
 *   SIGKILL) are forked fibers racing the child's `exit` event (a `Deferred`
 *   exit latch) against the escalation deadline — the Effect replacement for
 *   the unref'd `setTimeout` rungs, with byte-identical signal ordering and
 *   timings.
 * - Every idle watchdog / grace timer in the integrations is a
 *   `forkCancelableTimeout` fiber: fork on arm, interrupt (via a cancel
 *   latch) on disarm, exactly the old `setTimeout`/`clearTimeout` pair.
 */

import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Shared runtime for every Effect run in `kernel/integrations`. */
export const integrationsRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Fork a bounded, cancelable timeout fiber: after `timeoutMs`, run
 * `onTimeout`. Returns a cancel thunk that both completes the cancel latch
 * (interrupting the pending sleep) and fences a sleep that already won the
 * race but has not run its callback yet — so, like a synchronous
 * `clearTimeout`, a cancel always beats the firing.
 */
export const forkCancelableTimeout = (
  timeoutMs: number,
  onTimeout: () => void,
): (() => void) => {
  let canceled = false;
  const cancelLatch = Deferred.makeUnsafe<void>();
  integrationsRuntime.runFork(
    Effect.raceFirst(
      Effect.sleep(timeoutMs).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            if (!canceled) onTimeout();
          }),
        ),
      ),
      Deferred.await(cancelLatch),
    ),
  );
  return () => {
    canceled = true;
    Deferred.doneUnsafe(cancelLatch, Effect.void);
  };
};

/** Grace between the soft SIGINT and the SIGTERM rung of the abort ladder. */
const SIGTERM_TIMEOUT_MS = 1_500;
/** Grace between SIGTERM and the final SIGKILL rung. */
const SIGKILL_TIMEOUT_MS = 4_000;

/**
 * True only when the child has actually terminated. `child.killed` must NOT
 * be used for ladder guards: it flips true as soon as any signal was SENT,
 * which previously made every later rung unreachable — after a SIGINT,
 * neither SIGTERM nor SIGKILL could ever fire, so a signal-ignoring CLI
 * survived cancellation.
 */
export const externalCliProcessIsDead = (
  child: ChildProcessWithoutNullStreams,
): boolean => child.exitCode !== null || child.signalCode !== null;

/**
 * SIGTERM→4s→SIGKILL ladder. The escalation is a forked fiber racing the
 * child's `exit` event (a `Deferred` exit latch) against the 4s deadline:
 * if the child exits first the fiber ends immediately; if it is still alive
 * at the deadline it is SIGKILLed. Bounded to 4s of fiber lifetime per
 * invocation, so repeated kills stay cheap.
 */
export const killExternalCliProcess = (
  child: ChildProcessWithoutNullStreams,
): void => {
  if (externalCliProcessIsDead(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Process may have already exited.
  }

  integrationsRuntime.runFork(
    Effect.gen(function* () {
      const exited = yield* Deferred.make<void>();
      const onExit = () => {
        Deferred.doneUnsafe(exited, Effect.void);
      };
      child.once("exit", onExit);
      yield* Effect.ensuring(
        Effect.raceFirst(
          Effect.sleep(SIGKILL_TIMEOUT_MS),
          Deferred.await(exited),
        ),
        Effect.sync(() => {
          child.removeListener("exit", onExit);
        }),
      );
      if (externalCliProcessIsDead(child)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Process may have already exited.
      }
    }),
  );
};

/**
 * Cooperative abort ladder: SIGINT first (the CLIs flush partial state on
 * it), then after 1.5s hand off to the SIGTERM→SIGKILL ladder. The handoff
 * fiber is deliberately not canceled on early exit —
 * `killExternalCliProcess` is a no-op on a dead child, exactly like the old
 * always-firing `setTimeout` rung.
 */
export const abortExternalCliProcess = (
  child: ChildProcessWithoutNullStreams,
): void => {
  if (externalCliProcessIsDead(child)) return;
  try {
    child.kill("SIGINT");
  } catch {
    // Ignore and fall through to SIGTERM/SIGKILL.
  }

  integrationsRuntime.runFork(
    Effect.sleep(SIGTERM_TIMEOUT_MS).pipe(
      Effect.flatMap(() =>
        Effect.sync(() => {
          killExternalCliProcess(child);
        }),
      ),
    ),
  );
};
