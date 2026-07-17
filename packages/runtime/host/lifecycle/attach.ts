import type { Socket } from "node:net";
import { promises as fsPromises } from "node:fs";
import { Effect, type Scope } from "effect";
import {
  resolveRuntimePaths,
  type RuntimePaths,
} from "../../worker/runtime-paths.js";
import {
  probeRunningWorker,
  removeStaleRuntimeArtifacts,
} from "../../worker/lifecycle-server.js";
import { getFileLogger } from "../../observability/file-logger.js";
import {
  WorkerNotReadyError,
  WorkerProtocolMismatchError,
  WorkerReadyTimeoutError,
} from "./errors.js";
import { acquireHostLock } from "./lock.js";
import { pollWithDeadline } from "./poll.js";
import { connectReadySocket } from "./socket.js";
import { spawnAdoptedWorker } from "./spawn.js";
import { findSameRootWorkerPids, killWorkerProcess, stopPids } from "./kill.js";
import {
  defaultLifecycleBudgets,
  type LifecycleBudgets,
  type LifecycleConnection,
  type LifecycleStartOptions,
} from "./options.js";

/**
 * Host-side discover-or-spawn as one scoped Effect pipeline.
 *
 * Discovery flow (unchanged from the pre-Effect implementation):
 *   1. Resolve ~/.stella/runtime/<rootHash>/runtime.{pid,sock}
 *      or the equivalent Windows named pipe path.
 *   2. If pidfile points to a live process AND we can connect to the
 *      socket, reuse it. This is the "Electron just restarted, reattach"
 *      path. Protocol or host-executable mismatch is a hard worker restart;
 *      in-flight work is not preserved across that compatibility boundary.
 *   3. Otherwise (no pidfile, dead pid, or socket refusing connections),
 *      spawn a fresh detached worker pointed at the same paths and poll
 *      until it answers a lightweight RPC readiness probe.
 *
 * Resource ownership: the host lock, probe sockets, and the spawned child
 * are acquired into the pipeline's scope — failure and interruption release
 * them LIFO (spawned child reaped on interrupt only, see spawn.ts; lock
 * always unlinked). The final peer socket alone outlives the scope on
 * success; on any non-success scope exit its exit-aware release destroys it.
 */

const hostExecutableMatches = (
  paths: RuntimePaths,
  expectedHostExecutablePath?: string,
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    if (!expectedHostExecutablePath) return true;
    try {
      const raw = await fsPromises.readFile(paths.hostExecutableFile, "utf-8");
      return raw.trim() === expectedHostExecutablePath;
    } catch {
      return false;
    }
  });

/**
 * Poll `connectReadySocket` on a spaced Schedule, with attempt admission
 * checked against an absolute deadline anchored before attempt one
 * (`pollWithDeadline` — the old `while (Date.now() < deadline)` shape).
 * "version-mismatch" fails fast with the protocol parity error; deadline
 * lapse maps to the readiness-timeout parity error.
 *
 * Exported for the timing-parity regression tests only; the exports map
 * does not expose this module outside packages/runtime.
 */
export const pollForWorkerReady = (
  paths: RuntimePaths,
  timeoutMs: number,
  budgets: LifecycleBudgets,
  expectedProtocolVersion?: string,
): Effect.Effect<
  Socket,
  WorkerProtocolMismatchError | WorkerReadyTimeoutError,
  Scope.Scope
> =>
  pollWithDeadline({
    timeoutMs,
    intervalMs: budgets.startPollIntervalMs,
    attempt: connectReadySocket(
      paths.socketPath,
      budgets.socketConnectTimeoutMs,
      expectedProtocolVersion,
    ).pipe(
      Effect.flatMap(
        (
          result,
        ): Effect.Effect<
          Socket,
          WorkerNotReadyError | WorkerProtocolMismatchError
        > =>
          result.status === "ready"
            ? Effect.succeed(result.socket)
            : result.status === "version-mismatch"
              ? Effect.fail(
                  new WorkerProtocolMismatchError({
                    socketPath: paths.socketPath,
                  }),
                )
              : Effect.fail(
                  new WorkerNotReadyError({ socketPath: paths.socketPath }),
                ),
      ),
    ),
    retryWhile: (error) => error instanceof WorkerNotReadyError,
    onDeadline: () =>
      new WorkerReadyTimeoutError({ socketPath: paths.socketPath }),
  }).pipe(
    Effect.mapError((error) =>
      error instanceof WorkerNotReadyError
        ? new WorkerReadyTimeoutError({ socketPath: paths.socketPath })
        : error,
    ),
  );

const stopRunningWorkerForRestart = (
  stellaAppDir: string,
): Effect.Effect<void> => Effect.asVoid(stopRunningWorkerEffect(stellaAppDir));

/**
 * The discover-or-spawn decision tree, verbatim from the old
 * `startOrAttachWorker` critical section (it runs entirely under the host
 * lock). Returns an attach when a healthy same-executable, same-protocol
 * worker answers; otherwise clears whatever stale state it found and
 * returns null so the caller spawns fresh.
 */
const discoverExistingWorker = (
  options: LifecycleStartOptions,
  paths: RuntimePaths,
  budgets: LifecycleBudgets,
): Effect.Effect<LifecycleConnection | null, never, Scope.Scope> =>
  Effect.gen(function* () {
    const existingPid = yield* Effect.promise(() =>
      probeRunningWorker(options.stellaAppDir),
    );
    if (existingPid == null) {
      // No pidfile for this root: the overwhelmingly common case is a clean
      // fresh boot with no worker to reap, so we skip the process scan here.
      // On Windows that scan is a PowerShell cold start + full WMI/CIM
      // Win32_Process enumeration (commonly 0.5-2s) that would otherwise be
      // paid on EVERY launch with no live worker, for nothing. A genuinely
      // orphaned worker that lost its pidfile is exceedingly rare (clean
      // shutdown removes the pidfile; a crash leaves a stale one, which is
      // handled by the stale-pidfile branch below); spawning a fresh worker
      // binds the socket and supersedes it regardless.
      yield* Effect.promise(() =>
        removeStaleRuntimeArtifacts(options.stellaAppDir),
      );
      return null;
    }
    const executableMatches = yield* hostExecutableMatches(
      paths,
      options.hostExecutablePath,
    );
    if (!executableMatches) {
      console.warn(
        `[runtime-host] Existing worker executable mismatch; restarting detached worker (pid=${existingPid}). In-flight work cannot be preserved across host bundle changes.`,
      );
      yield* stopRunningWorkerForRestart(options.stellaAppDir);
      yield* Effect.promise(() =>
        removeStaleRuntimeArtifacts(options.stellaAppDir),
      );
      return null;
    }
    const ready = yield* connectReadySocket(
      paths.socketPath,
      budgets.socketConnectTimeoutMs,
      options.expectedProtocolVersion,
    );
    if (ready.status === "ready") {
      return { socket: ready.socket, pid: existingPid, paths, spawned: false };
    }
    if (ready.status === "version-mismatch") {
      console.warn(
        `[runtime-host] Existing worker protocol mismatch; restarting detached worker (pid=${existingPid}). In-flight work cannot be preserved across protocol changes.`,
      );
      yield* stopRunningWorkerForRestart(options.stellaAppDir);
      yield* Effect.promise(() =>
        removeStaleRuntimeArtifacts(options.stellaAppDir),
      );
      return null;
    }
    // Pid is alive but socket isn't reachable — likely a worker that's
    // still binding the socket. Wait briefly before declaring it stale.
    const retry = yield* pollForWorkerReady(
      paths,
      budgets.staleRetryTimeoutMs,
      budgets,
      options.expectedProtocolVersion,
    ).pipe(Effect.catch(() => Effect.succeed(null)));
    if (retry) {
      return { socket: retry, pid: existingPid, paths, spawned: false };
    }
    // Truly stale; only reap processes whose command line still matches
    // this Stella root. A pidfile can outlive the original worker, and
    // the OS may have reused that pid for an unrelated process.
    const orphanPids = yield* Effect.promise(() =>
      findSameRootWorkerPids(options.workerEntryPath, options.stellaAppDir),
    );
    if (!orphanPids.includes(existingPid)) {
      console.warn(
        `[runtime-host] Stale runtime pidfile pointed at pid ${existingPid}, but that pid no longer matches this worker root; leaving the process alone.`,
      );
    }
    if (orphanPids.length > 0) {
      console.warn(
        `[runtime-host] Reaping ${orphanPids.length} stale runtime worker(s) for ${options.stellaAppDir} before spawning a fresh worker.`,
      );
      yield* stopPids(orphanPids);
    }
    yield* Effect.promise(() =>
      removeStaleRuntimeArtifacts(options.stellaAppDir),
    );
    return null;
  });

/**
 * Resolve a connected socket to the runtime worker, spawning a new
 * worker if one is not already running for `stellaAppDir`. Idempotent
 * across hosts thanks to the host-side lock. The caller owns the returned
 * socket on success; every other resource is released when the scope
 * closes.
 */
export const startOrAttachWorkerEffect = (
  options: LifecycleStartOptions,
  budgets: LifecycleBudgets = defaultLifecycleBudgets,
): Effect.Effect<LifecycleConnection, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const paths = resolveRuntimePaths(options.stellaAppDir);
    yield* Effect.promise(() =>
      fsPromises.mkdir(paths.rootDir, { recursive: true }),
    );
    const hostLockFile = `${paths.lockFile}.host`;
    yield* acquireHostLock(hostLockFile, budgets.hostLockTimeoutMs);

    const existing = yield* discoverExistingWorker(options, paths, budgets);
    if (existing) {
      return existing;
    }

    yield* spawnAdoptedWorker(options, paths);
    const socket = yield* pollForWorkerReady(
      paths,
      budgets.startTimeoutMs,
      budgets,
      options.expectedProtocolVersion,
    );
    const newPid =
      (yield* Effect.promise(() =>
        probeRunningWorker(options.stellaAppDir),
      )) ?? 0;
    return { socket, pid: newPid, paths, spawned: true };
  });

/**
 * Stop a running worker by SIGTERM-then-SIGKILL. The worker also has its
 * own self-shutdown-on-idle timer, so this is mostly used by tests and
 * by `runtime restart` flows that want a synchronous tear-down.
 */
export const stopRunningWorkerEffect = (
  stellaAppDir: string,
  options?: { graceMs?: number },
): Effect.Effect<{ stopped: boolean; pid: number | null }> =>
  Effect.gen(function* () {
    const pid = yield* Effect.promise(() => probeRunningWorker(stellaAppDir));
    if (pid == null) return { stopped: false, pid: null };
    const startedAt = Date.now();
    const result = yield* killWorkerProcess(pid, options?.graceMs ?? 1_500);
    // Instrumentation for the restart-grace decision: how long SIGTERM→exit
    // actually takes, and whether the worker needed a SIGKILL escalation.
    getFileLogger()?.process("worker.kill-latency", {
      pid,
      ms: Date.now() - startedAt,
      escalatedToSigkill: result.escalatedToSigkill,
      stopped: result.stopped,
    });
    return { stopped: result.stopped, pid };
  });
