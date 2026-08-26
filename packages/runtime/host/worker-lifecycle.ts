import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { Deferred, Effect, Fiber } from "effect";
import {
  createRuntimeUnavailableError,
  type JsonRpcPeer,
} from "@stella/contracts/protocol/rpc-peer";
import type {
  AgentHealth,
  RuntimeActiveRun,
  SocialSessionServiceSnapshot,
} from "@stella/contracts/protocol";
import { hostRuntime, runHostEffect } from "./effect-runtime.js";

export type WorkerConnection = {
  process: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  pid: number;
  /**
   * True when the connection factory attached to an already-running
   * detached worker instead of spawning a fresh one. Reattached workers may
   * be running stale runtime code (the desktop restarted across a
   * apply or update), so the host runs the staleness handshake on them;
   * freshly spawned workers are by definition current.
   */
  attachedToExistingWorker?: boolean;
};

export type WorkerLifecycleState = "idle" | "starting" | "running" | "stopping";

export type WorkerHealthSnapshot = {
  health: AgentHealth;
  activeRun: RuntimeActiveRun | null;
  activeAgentCount: number;
  protocolVersion?: string;
  pid: number;
  deviceId: string | null;
  voiceBusy?: boolean;
  pendingVoiceRequestCount?: number;
  socialSessions?: SocialSessionServiceSnapshot;
};

/**
 * Wait for the child to exit after a SIGTERM, escalating to SIGKILL when the
 * grace window lapses. Listener-before-kill ordering matches the old
 * promise loop; the SIGKILL branch settles immediately (it does not wait for
 * the post-KILL exit event), exactly like the old timeout callback.
 */
const waitForWorkerProcessExitEffect = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Effect.Effect<void> =>
  Effect.raceFirst(
    Effect.callback<void>((resume) => {
      const finish = () => resume(Effect.void);
      child.once("exit", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
      return Effect.sync(() => {
        child.off("exit", finish);
      });
    }),
    Effect.sleep(timeoutMs).pipe(
      Effect.andThen(
        Effect.sync(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Best effort during process shutdown.
          }
        }),
      ),
    ),
  );

export const waitForWorkerProcessExit = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 1_500,
) => {
  await hostRuntime.runPromise(waitForWorkerProcessExitEffect(child, timeoutMs));
};

/**
 * Close the IPC channel without killing the worker process. Used when
 * the worker self-supervises (UDS detached mode) so an Electron restart
 * leaves the worker running for the next host to attach.
 */
const disconnectWorkerEffect = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    // Fast path: the process already exited (e.g. an explicit killWorker()
    // just confirmed it dead, so its socket is already closing). The shim's
    // `exit` event has likely fired before we could attach a listener, which
    // would make the race below sit out the entire timeout fallback waiting
    // for an event that won't come again. Closing stdin is a no-op on a dead
    // socket.
    if (child.exitCode != null || child.signalCode != null) {
      try {
        child.stdin?.end();
      } catch {
        // Best effort.
      }
      return Effect.void;
    }
    return Effect.raceFirst(
      Effect.callback<void>((resume) => {
        const finish = () => resume(Effect.void);
        child.once("exit", finish);
        // For UDS adapters, buildProcessShim intentionally maps stdin to the
        // underlying Socket; ending stdin is the IPC-disconnect operation. For
        // real ChildProcessWithoutNullStreams, ending stdin makes the child
        // read EOF and exit naturally — but the timeout fallback keeps a
        // noncooperative worker from hanging the host.
        try {
          child.stdin?.end();
        } catch {
          // Best effort.
        }
        return Effect.sync(() => {
          child.off("exit", finish);
        });
      }),
      Effect.sleep(timeoutMs),
    );
  });

export const disconnectWorker = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 1_500,
) => {
  await hostRuntime.runPromise(disconnectWorkerEffect(child, timeoutMs));
};

export type RuntimeWorkerLifecycleControllerOptions = {
  workerEntryPath: string;
  isHostStarted: () => boolean;
  /**
   * Connection factory. Production path: spawns or attaches to the
   * detached worker via `runtime/host/lifecycle.ts`, then wraps the
   * resulting Unix-domain-socket in a JsonRpcPeer. Returns a
   * `WorkerConnection` whose `process.kill()` only kills the worker if
   * `killWorkerOnStop?.(reason)` is true (so an Electron restart leaves
   * the worker running for the next host).
   */
  createConnectionAsync: (workerEntryPath: string) => Promise<WorkerConnection>;
  initializeConnection: (connection: WorkerConnection) => Promise<void>;
  onConnectionStarted: (connection: WorkerConnection) => Promise<void>;
  onUnexpectedExit: () => Promise<void> | void;
  onAfterStop: (reason: "idle" | "restart" | "stopped") => Promise<void> | void;
  onStateChange?: (state: WorkerLifecycleState) => void;
  fetchHealth: (
    connection: WorkerConnection,
  ) => Promise<WorkerHealthSnapshot | null>;
  /**
   * Decide whether `stop(reason)` should also kill the underlying worker
   * process via SIGTERM/SIGKILL, or whether closing the IPC channel is
   * enough because the worker self-supervises (UDS-detached path).
   * Defaults to "always kill" (legacy stdio-child semantics).
   *
   * Production passes `(reason) => reason === "restart"` so:
   *   - "stopped" / "idle" close the socket; worker stays alive ~10s
   *     so the next Electron host can reattach without loss.
   *   - "restart" actually kills the worker pid (e.g. runtime code
   *     reload that needs a fresh process).
   */
  killWorkerOnStop?: (reason: "idle" | "restart" | "stopped") => boolean;
  /**
   * Optional explicit worker kill — used by the UDS path when
   * `killWorkerOnStop` returns true. Falls back to
   * `connection.process.kill("SIGTERM")` when omitted.
   */
  killWorker?: () => Promise<void>;
};

/**
 * The host-side worker lifecycle state machine, rewritten on structured
 * Effect primitives (M5 completion, phase 5):
 *
 * - Single-flight startup is a forked fiber on the host runtime; joiners
 *   share its `Fiber.join` promise, so every concurrent `ensureStarted`
 *   observes the same success or the same original failure.
 * - The in-flight request drain race is a `Deferred` latch resolved by the
 *   last decrement, raced against the old 1.5s cap.
 * - `stop()` runs the kill/disconnect branch as one Effect whose
 *   `Effect.ensuring` cleanup performs the old `.finally` bookkeeping
 *   (connection/stoppingPid/state reset) on success, failure, and
 *   interruption alike.
 *
 * The outward surface is unchanged: plain Promise methods, the same
 * `WorkerLifecycleState` transitions, and byte-identical error strings —
 * Electron main never sees an Effect type. Startup is deliberately never
 * interrupted (parity: a concurrent `stop()` sees no connection until the
 * factory settles, exactly as before).
 */
export class RuntimeWorkerLifecycleController {
  private connection: WorkerConnection | null = null;
  private startupPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stoppingPid: number | null = null;
  private state: WorkerLifecycleState = "idle";
  private inFlightWorkerRequests = 0;
  private inFlightDrainLatch: Deferred.Deferred<void> | null = null;

  constructor(
    private readonly options: RuntimeWorkerLifecycleControllerOptions,
  ) {}

  getState() {
    return this.state;
  }

  getConnection() {
    return this.connection;
  }

  private getLivePeer() {
    const peer = this.connection?.peer;
    return peer && !peer.isClosed() ? peer : null;
  }

  private setState(nextState: WorkerLifecycleState) {
    this.state = nextState;
    this.options.onStateChange?.(nextState);
  }

  private getOrCreateInFlightDrainLatch() {
    if (this.inFlightDrainLatch) {
      return this.inFlightDrainLatch;
    }
    this.inFlightDrainLatch = Deferred.makeUnsafe<void>();
    return this.inFlightDrainLatch;
  }

  private incrementInFlightWorkerRequests() {
    this.inFlightWorkerRequests += 1;
  }

  private decrementInFlightWorkerRequests() {
    this.inFlightWorkerRequests = Math.max(0, this.inFlightWorkerRequests - 1);
    if (this.inFlightWorkerRequests === 0 && this.inFlightDrainLatch) {
      const latch = this.inFlightDrainLatch;
      this.inFlightDrainLatch = null;
      Deferred.doneUnsafe(latch, Effect.void);
    }
  }

  private async waitForInFlightWorkerRequestsToDrain(timeoutMs = 1_500) {
    if (this.inFlightWorkerRequests === 0) {
      return;
    }
    const latch = this.getOrCreateInFlightDrainLatch();
    await hostRuntime.runPromise(
      Effect.raceFirst(Deferred.await(latch), Effect.sleep(timeoutMs)),
    );
  }

  /** The startup transaction as one fiber-run Effect (single-flight). */
  private startupEffect(): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.gen(function* () {
      // The detached-UDS factory manages its own lifecycle (single-instance
      // via flock, idempotent attach), so there is no stale-child sweep here.
      const connection = yield* Effect.tryPromise({
        try: () =>
          self.options.createConnectionAsync(self.options.workerEntryPath),
        catch: (error) => error,
      });
      self.connection = connection;
      self.stoppingPid = null;

      connection.peer.on("closed", () => {
        if (self.connection?.peer !== connection.peer) {
          return;
        }
        self.connection = null;
        if (self.state === "running") {
          self.setState("idle");
        }
      });

      connection.process.once("exit", () => {
        const wasIntentional = self.stoppingPid === connection.pid;
        if (self.connection?.process === connection.process) {
          self.connection = null;
        }
        if (!wasIntentional) {
          self.setState("idle");
        }
        if (self.stopPromise && wasIntentional) return;
        if (self.options.isHostStarted()) {
          void self.options.onUnexpectedExit();
        }
      });

      yield* Effect.tryPromise({
        try: () => self.options.initializeConnection(connection),
        catch: (error) => error,
      }).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => self.options.onConnectionStarted(connection),
            catch: (error) => error,
          }),
        ),
        Effect.andThen(Effect.sync(() => self.setState("running"))),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (self.connection?.pid === connection.pid) {
              self.connection = null;
            }
            self.setState("idle");
          }).pipe(
            Effect.andThen(
              Effect.ignore(
                waitForWorkerProcessExitEffect(connection.process, 1_500),
              ),
            ),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
    });
  }

  async ensureStarted() {
    if (!this.options.isHostStarted()) {
      throw createRuntimeUnavailableError(
        "Stella runtime host is not started.",
      );
    }
    if (this.state === "running" && this.getLivePeer()) return;
    if (this.state === "stopping" && this.stopPromise) {
      await this.stopPromise;
    }
    if (this.startupPromise) {
      await this.startupPromise;
      return;
    }

    this.setState("starting");
    // Fork the startup fiber and share its join: concurrent callers await
    // the same completion and observe the same original failure.
    const startupFiber = hostRuntime.runFork(this.startupEffect());
    this.startupPromise = runHostEffect(Fiber.join(startupFiber));

    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
      if (!this.connection?.peer && this.state === "starting") {
        this.setState("idle");
      }
    }
  }

  async stop(reason: "idle" | "restart" | "stopped") {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    const connection = this.connection;
    if (!connection) return;
    if (reason !== "idle") {
      await this.waitForInFlightWorkerRequestsToDrain();
    }
    this.setState("stopping");
    this.stoppingPid = connection.pid;
    const shouldKill = this.options.killWorkerOnStop?.(reason) ?? true;
    const killWorker = this.options.killWorker;
    const stopCore: Effect.Effect<void, unknown> = shouldKill
      ? killWorker
        ? Effect.tryPromise({
            try: () => killWorker(),
            catch: (error) => error,
          }).pipe(Effect.andThen(disconnectWorkerEffect(connection.process, 100)))
        : waitForWorkerProcessExitEffect(connection.process, 1_500)
      : disconnectWorkerEffect(connection.process, 1_500);
    this.stopPromise = runHostEffect(
      stopCore.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.connection?.pid === connection.pid) {
              this.connection = null;
            }
            this.stoppingPid = null;
            this.stopPromise = null;
            this.setState("idle");
          }),
        ),
      ),
    );
    await this.stopPromise;
    if (this.options.isHostStarted()) {
      await this.options.onAfterStop(reason);
    }
  }

  async request<TResult>(
    execute: (peer: JsonRpcPeer) => Promise<TResult>,
    options: {
      ensureWorker: boolean;
      recordActivity: boolean;
      retryOnceOnDisconnect?: boolean;
    },
  ): Promise<TResult> {
    if (options.ensureWorker) {
      await this.ensureStarted();
    }
    const peer = this.getLivePeer();
    if (!peer) {
      throw createRuntimeUnavailableError("Runtime worker is not running.");
    }
    this.incrementInFlightWorkerRequests();
    try {
      return await execute(peer);
    } catch (error) {
      if (
        options.retryOnceOnDisconnect &&
        this.options.isHostStarted() &&
        !this.getLivePeer()
      ) {
        await this.ensureStarted();
        return await this.request(execute, {
          ...options,
          retryOnceOnDisconnect: false,
        });
      }
      throw error;
    } finally {
      this.decrementInFlightWorkerRequests();
    }
  }

  async getHealth(args: { ensureWorker: boolean }) {
    if (args.ensureWorker) {
      await this.ensureStarted();
    }
    const connection = this.connection;
    if (!connection || connection.peer.isClosed()) return null;
    return await this.options.fetchHealth(connection);
  }
}
