import { existsSync, readFileSync, promises as fs } from "node:fs";
import { Effect, Schedule } from "effect";
import type { RuntimePaths } from "../worker/runtime-paths.js";
import {
  computeRuntimeBuildStamp,
  RUNTIME_BUILD_STAMP_UNAVAILABLE,
} from "../worker/runtime-build-stamp.js";

/**
 * The host↔worker staleness/build-stamp handshake, as Effects.
 *
 * The detached worker survives Electron restarts by design; the cost is
 * that a host reconnecting after a desktop update can silently adopt a
 * worker running old runtime code. The worker persists the build stamp of
 * the tree it loaded at boot (`build-stamp.txt`); on reattach the host
 * recomputes the stamp from the on-disk tree and compares. A persisted
 * pending-restart flag (written when a stale worker was busy) forces the
 * stale verdict across host generations.
 *
 * `StellaRuntimeHost` runs these on its module-level runtime and keeps the
 * deferral state machine (quiescence gating, restart flush) itself — the
 * verdict and the flag persistence are the handshake; the restart is host
 * orchestration.
 */

export type WorkerStalenessReason =
  | "pending-restart-flag"
  | "worker-stamp-missing"
  | "build-stamp-mismatch";

export type WorkerStalenessVerdict =
  | { stale: false }
  | { stale: true; reason: WorkerStalenessReason };

export type PendingWorkerRestartRecord = {
  reason: string;
  detectedAtMs: number;
};

/** Build stamp the running worker recorded at boot, or null (pre-stamp worker). */
const readWorkerReportedBuildStamp = (
  paths: RuntimePaths,
): Effect.Effect<string | null> =>
  Effect.sync(() => {
    try {
      const raw = readFileSync(paths.buildStampFile, "utf-8").trim();
      return raw || null;
    } catch {
      return null;
    }
  });

export const hasPersistedPendingWorkerRestart = (
  paths: RuntimePaths,
): Effect.Effect<boolean> =>
  Effect.sync(() => existsSync(paths.pendingWorkerRestartFile));

/**
 * Reconnect handshake: decide whether the worker we just connected to is
 * running stale runtime code. A freshly spawned worker loaded the current
 * on-disk code by definition, so it is never stale.
 */
export const evaluateWorkerStaleness = (args: {
  attachedToExistingWorker: boolean;
  paths: RuntimePaths;
  workerEntryPath: string;
}): Effect.Effect<WorkerStalenessVerdict> =>
  Effect.gen(function* () {
    if (!args.attachedToExistingWorker) {
      return { stale: false };
    }
    if (yield* hasPersistedPendingWorkerRestart(args.paths)) {
      return { stale: true, reason: "pending-restart-flag" };
    }
    const workerStamp = yield* readWorkerReportedBuildStamp(args.paths);
    if (!workerStamp) {
      // Pre-stamp worker (older build) — by definition running old code.
      return { stale: true, reason: "worker-stamp-missing" };
    }
    const onDiskStamp = computeRuntimeBuildStamp(args.workerEntryPath);
    if (
      onDiskStamp !== RUNTIME_BUILD_STAMP_UNAVAILABLE &&
      workerStamp !== onDiskStamp
    ) {
      return { stale: true, reason: "build-stamp-mismatch" };
    }
    return { stale: false };
  });

/**
 * Persist the pending-restart flag so the deferral survives an Electron
 * restart. Fails with the underlying error; the host warns and continues
 * (an unpersisted deferral still restarts within this host's lifetime).
 */
export const persistPendingWorkerRestartFlag = (
  paths: RuntimePaths,
  record: PendingWorkerRestartRecord,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(paths.rootDir, { recursive: true });
      await fs.writeFile(
        paths.pendingWorkerRestartFile,
        JSON.stringify(record, null, 2),
        "utf-8",
      );
    },
    catch: (error) => error as Error,
  });

/** Cleared whenever a freshly spawned worker connects (fresh == current code). */
export const clearPendingWorkerRestartFlag = (
  paths: RuntimePaths,
): Effect.Effect<void> =>
  Effect.promise(() =>
    fs.unlink(paths.pendingWorkerRestartFile).catch(() => undefined),
  ).pipe(Effect.asVoid);

/**
 * The stale-worker quiescence safety poll, with the old `setInterval`
 * cadence: the first tick fires `intervalMs` after the poll starts (never
 * immediately — the 1s nudge owns "soon"), and subsequent ticks stay on the
 * fixed-rate grid via `Schedule.fixed`, NOT fixed-delay-after-completion —
 * a slow flush must not push later ticks. A flush rejection is ignored so
 * the poll keeps ticking, matching the old `void this.flushWorkerRestart()`.
 */
export const quiescencePollEffect = (
  flush: () => Promise<void>,
  intervalMs = 30_000,
): Effect.Effect<void> =>
  Effect.sleep(intervalMs).pipe(
    Effect.andThen(
      Effect.repeat(
        Effect.ignore(Effect.tryPromise(() => flush())),
        Schedule.fixed(intervalMs),
      ),
    ),
    Effect.asVoid,
  );
