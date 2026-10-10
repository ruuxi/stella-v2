import { Cause, Effect, Exit, Scope } from "effect";
import { loadModelRegistry } from "@stella/contracts/model-registry";
import "../kernel/shared/http-proxy.js";
import path from "node:path";
import {
  getFileLogger,
  initFileLogger,
  installWorkerCrashHandling,
} from "../observability/file-logger.js";
import {
  configureAgentProcessRegistry,
  describeAgentProcesses,
  killAgentProcessesSync,
  reapAgentProcesses,
  takeOrphanedAgentProcesses,
} from "../kernel/shared/agent-process-registry.js";
import { closeRuntimeTelemetry } from "../observability/runtime-telemetry.js";
import type { JsonRpcPeer } from "@stella/contracts/protocol/rpc-peer";
import { STELLA_RUNTIME_CLIENT_PROTOCOL_VERSION } from "@stella/contracts/protocol/runtime-client";
import { RuntimeClientServer } from "../host/client-server.js";
import { workerRuntime } from "./effect-runtime.js";
import {
  WorkerLifecycleServer,
  removeStaleRuntimeArtifacts,
} from "./lifecycle-server.js";
import { WorkerPeerBroker } from "./peer-broker.js";
import { createRuntimeWorkerServer } from "./server/index.js";
import {
  computeRuntimeBuildStamp,
  RUNTIME_BUILD_STAMP_UNAVAILABLE,
} from "./runtime-build-stamp.js";
import {
  createRuntimeServerIdentity,
  type RuntimeServerIdentity,
} from "./server-identity.js";
import {
  parseWorkerArgs,
  parseWorkerListenUrl,
  startWorkerTransport,
  type WorkerTransport,
} from "./transport.js";

/**
 * Worker entrypoint. Two execution modes:
 *
 *   bun run runtime/worker/entry.js
 *     -> default stdio mode. Parent process owns the worker; lifecycle is
 *        tied to stdin/stdout. Used by the legacy embedded
 *        worker codepath, and by the host adapter when the lifecycle
 *        manager spawns the worker as a regular child process.
 *
 *   bun run runtime/worker/entry.js --listen unix:///path/to/runtime.sock
 *   bun run runtime/worker/entry.js --listen pipe://\\.\pipe\stella-runtime-...
 *     -> the runtime process. The runtime host runs here beside the worker,
 *        reaching it in process; the socket speaks the client protocol
 *        (`@stella/contracts/protocol/runtime-client`) to the app. It writes
 *        pid+lock beneath the runtime root and self-shuts-down 10s after the
 *        last client disconnects, so an app restart loses nothing.
 *
 *   ... --stella-root /path                    [required for detached mode]
 *   ... --idle-shutdown-ms 10000               [detached mode only]
 */

type ParsedArgs = {
  listenUrl: string;
  stellaAppDir: string | null;
  idleShutdownMs: number | null;
};

const parseEntryArgs = (argv: string[]): ParsedArgs => {
  let listenUrl = "stdio://";
  let stellaAppDir: string | null = null;
  let idleShutdownMs: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--listen" && i + 1 < argv.length) {
      listenUrl = argv[i + 1] ?? listenUrl;
      i += 1;
    } else if (arg.startsWith("--listen=")) {
      listenUrl = arg.slice("--listen=".length);
    } else if (arg === "--stella-root" && i + 1 < argv.length) {
      stellaAppDir = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--stella-root=")) {
      stellaAppDir = arg.slice("--stella-root=".length);
    } else if (arg === "--idle-shutdown-ms" && i + 1 < argv.length) {
      const next = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(next) && next > 0) idleShutdownMs = next;
      i += 1;
    } else if (arg.startsWith("--idle-shutdown-ms=")) {
      const next = Number.parseInt(arg.slice("--idle-shutdown-ms=".length), 10);
      if (Number.isFinite(next) && next > 0) idleShutdownMs = next;
    }
  }
  return { listenUrl, stellaAppDir, idleShutdownMs };
};

/** How long a shutdown may spend closing before the process exits regardless. */
const SHUTDOWN_DEADLINE_MS = 5_000;

const main = async () => {
  await loadModelRegistry();
  const cliArgs = parseEntryArgs(process.argv.slice(2));
  const transportResult = parseWorkerListenUrl(cliArgs.listenUrl);
  if (!transportResult.ok) {
    console.error(`[runtime-worker] ${transportResult.error}`);
    process.exit(2);
  }
  const transport = transportResult.transport;

  // The process root scope: every boot-owned resource — peer broker,
  // runtime server, transport listener — is acquired into this scope, and
  // ALL teardown paths (signal, idle shutdown) are one `Scope.close` whose
  // LIFO finalizers replay the old teardown order exactly:
  //   transport close → runtimeServer.shutdown() → broker.dispose().
  // `createRuntimeWorkerServer`'s `shutdown()` (surface 1) is the join
  // point; each finalizer stays best-effort like the old try/catch chain.
  const rootScope = Scope.makeUnsafe();
  let rootScopeClosed = false;
  const closeRootScope = async () => {
    if (rootScopeClosed) return;
    rootScopeClosed = true;
    await workerRuntime
      .runPromise(Scope.close(rootScope, Exit.void))
      .catch(() => undefined);
    await closeRuntimeTelemetry();
  };
  const acquire = async <A>(
    effect: Effect.Effect<A, unknown, Scope.Scope>,
  ): Promise<A> => {
    const exit = await workerRuntime.runPromiseExit(
      Scope.provide(effect, rootScope),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  };

  const broker = await acquire(
    Effect.acquireRelease(
      Effect.sync(() => new WorkerPeerBroker()),
      (acquired) =>
        Effect.sync(() => {
          try {
            acquired.dispose();
          } catch {
            // Best effort during process shutdown.
          }
        }),
    ),
  );
  const runtimeServer = await acquire(
    Effect.acquireRelease(
      Effect.sync(() => createRuntimeWorkerServer(broker)),
      (acquired) =>
        Effect.promise(() => acquired.shutdown().catch(() => undefined)),
    ),
  );
  let shuttingDown = false;

  let lifecycle: WorkerLifecycleServer | null = null;
  let serverIdentity: RuntimeServerIdentity | undefined;
  let detachedMode = false;
  if (transport.kind !== "stdio") {
    if (!cliArgs.stellaAppDir) {
      console.error(
        "[runtime-worker] detached --listen requires --stella-root <path>",
      );
      process.exit(2);
    }
    detachedMode = true;
    const logger = initFileLogger(cliArgs.stellaAppDir, "worker");
    installWorkerCrashHandling(logger, {
      context: () => ({ agentProcesses: describeAgentProcesses() }),
      beforeFatalExit: () => {
        killAgentProcessesSync();
      },
    });
    process.on("exit", () => {
      killAgentProcessesSync();
    });
    logger.process("worker.starting", { pid: process.pid });
    // Snapshot the runtime tree's identity as loaded by THIS process
    // (process.argv[1] is the entry file the host spawned). The host compares
    // this stamp against the on-disk tree when it reattaches to detect a
    // worker running stale code after a desktop update.
    const runtimeBuildStamp = computeRuntimeBuildStamp(process.argv[1] ?? "");
    lifecycle = new WorkerLifecycleServer({
      stellaAppDir: cliArgs.stellaAppDir,
      ...(runtimeBuildStamp !== RUNTIME_BUILD_STAMP_UNAVAILABLE
        ? { runtimeBuildStamp }
        : {}),
      ...(cliArgs.idleShutdownMs
        ? { idleShutdownMs: cliArgs.idleShutdownMs }
        : {}),
      interruptWork: () => runtimeServer.interruptWork(),
      shouldKeepAlive: () => runtimeServer.holdsWorkerAlive(),
      onShutdown: async (reason) => {
        // Closing interrupts in-flight turns and ends their commands; pi
        // keeps the interrupted work pending for the next launch. A teardown
        // that still wedges must not keep the process alive past the bound.
        const startedAt = Date.now();
        const closed = await workerRuntime.runPromise(
          Effect.raceFirst(
            Effect.promise(() => closeRootScope()).pipe(Effect.as(true)),
            Effect.sleep(SHUTDOWN_DEADLINE_MS).pipe(Effect.as(false)),
          ),
        );
        logger.process(closed ? "worker.shutdown-closed" : "worker.shutdown-deadline", {
          reason,
          elapsedMs: Date.now() - startedAt,
        });
        if (reason === "idle" || reason === "restart") {
          setImmediate(() => process.exit(0));
        }
      },
    });
    try {
      await lifecycle.start();
    } catch (error) {
      console.error(
        `[runtime-worker] Failed to acquire lifecycle lock: ${(error as Error).message}`,
      );
      process.exit(3);
    }
    const agentRegistryFile = path.join(
      lifecycle.paths.rootDir,
      "agent-processes.json",
    );
    const orphanedAgents = takeOrphanedAgentProcesses(agentRegistryFile);
    if (orphanedAgents.length > 0) {
      logger.warn("worker.orphaned-agents-found", {
        agents: orphanedAgents.map(({ pid, label, command, startedAt }) => ({
          pid,
          label,
          command,
          startedAt,
        })),
      });
      void reapAgentProcesses(orphanedAgents).then(() => {
        logger.process("worker.orphaned-agents-reaped", {
          pids: orphanedAgents.map(({ pid }) => pid),
        });
      });
    }
    configureAgentProcessRegistry(agentRegistryFile);
    serverIdentity = createRuntimeServerIdentity({
      rootHash: lifecycle.paths.rootHash,
      buildStamp:
        runtimeBuildStamp !== RUNTIME_BUILD_STAMP_UNAVAILABLE
          ? runtimeBuildStamp
          : null,
      protocolVersion: STELLA_RUNTIME_CLIENT_PROTOCOL_VERSION,
    });
    logger.process("worker.identity", {
      serverId: serverIdentity.serverId,
      rootHash: serverIdentity.rootHash,
      buildStamp: serverIdentity.buildStamp,
      launchEnv: serverIdentity.launchEnv,
    });
  }

  // Stdio: the parent is the host and talks to the worker directly. The
  // runtime process instead hosts the runtime host itself and serves apps.
  let attachPeer = (peer: JsonRpcPeer) => broker.attach(peer);
  let protocolVersion: string | undefined;
  if (lifecycle) {
    const runtimeLifecycle = lifecycle;
    const { StellaRuntimeHost } = await import("../host/index.js");
    const clientServer = await acquire(
      Effect.acquireRelease(
        Effect.sync(
          () =>
            new RuntimeClientServer({
              ...(serverIdentity ? { identity: serverIdentity } : {}),
              createHost: (params, hostHandlers) =>
                new StellaRuntimeHost({
                  initializeParams: params.initializeParams,
                  hostHandlers,
                  workerMode: "inproc",
                  workerEntryPath: process.argv[1],
                  ...(params.disableLocalScheduler
                    ? { disableLocalScheduler: true }
                    : {}),
                  inprocWorker: {
                    attach: (peer: JsonRpcPeer) => {
                      broker.attach(peer);
                      return () => broker.detach(peer);
                    },
                    // Exit once the restart call returns; the attached app
                    // starts a fresh runtime when it reconnects.
                    restartProcess: () => {
                      setImmediate(() => {
                        void runtimeLifecycle.shutdown("restart");
                      });
                    },
                  },
                }),
              onShutdownRequested: () => {
                void runtimeLifecycle.shutdown("restart");
              },
              onQuitRequested: () => runtimeLifecycle.requestQuit(),
            }),
        ),
        (acquired) => Effect.promise(() => acquired.close()),
      ),
    );
    attachPeer = (peer) => {
      runtimeLifecycle.noteClientConnected();
      peer.on("closed", () => runtimeLifecycle.noteClientDisconnected());
      clientServer.attach(peer);
    };
    protocolVersion = STELLA_RUNTIME_CLIENT_PROTOCOL_VERSION;
  }

  const server = await acquire(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startWorkerTransport({
            transport,
            attach: attachPeer,
            ...(protocolVersion ? { protocolVersion } : {}),
            ...(serverIdentity ? { identity: serverIdentity } : {}),
            onError: (error) => {
              console.error("[runtime-worker] transport error:", error);
            },
          }),
        catch: (error) => error,
      }),
      (acquired) =>
        Effect.promise(() => acquired.close().catch(() => undefined)),
    ),
  );

  // The transport is up: start loading the runner module now so it overlaps
  // the host's connect/initialize latency instead of running inside
  // initialize. Owned by the runtime server's base scope.
  runtimeServer.prefetchRunner();

  if (detachedMode) {
    console.error(
      `[runtime-worker] listening on ${server.describe()} (pid=${process.pid})`,
    );
  }

  const shutdown = async (_signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (lifecycle) {
      // The lifecycle server closes the root scope through its onShutdown
      // hook, then releases pid/lock files.
      await lifecycle.shutdown("signal");
    } else {
      await closeRootScope();
    }
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGHUP", () => void shutdown("SIGHUP"));
};

void main().catch((error) => {
  console.error("[runtime-worker] fatal:", error);
  getFileLogger()?.crash("worker.fatal", error);
  process.exit(1);
});

export {
  // Re-exports for external callers.
  WorkerPeerBroker,
  parseWorkerListenUrl,
  parseWorkerArgs,
  startWorkerTransport,
  removeStaleRuntimeArtifacts,
};
export type { WorkerTransport };
