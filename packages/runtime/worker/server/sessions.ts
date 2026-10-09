import { Context, Effect, Exit, Layer, Scope, Semaphore } from "effect";
import {
  METHOD_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
  type HostDeviceIdentity,
} from "@stella/contracts/protocol";
import { performance } from "node:perf_hooks";
import {
  BootTimeline,
  getActiveBootTimeline,
  setActiveBootTimeline,
  workerReadyTelemetry,
  type BootOutcome,
} from "../../observability/boot-timing.js";
import { getFileLogger } from "../../observability/file-logger.js";
import {
  configureRuntimeTelemetry,
  recordRuntimeTelemetry,
  updateRuntimeTelemetryAuth,
} from "../../observability/runtime-telemetry.js";
import { forkDelayed, workerRuntime } from "../effect-runtime.js";
import type { VoiceRuntimeService } from "../voice/service.js";
import { ProtocolMismatchError } from "./errors.js";
import * as HostBus from "./host-bus.js";
import * as ModelCatalog from "./model-catalog.js";
import * as RunnerModule from "./runner-module.js";
import { closePiChats, piChatsBusy, resumePiChats } from "./pi-chats.js";
import * as SessionConfig from "./session/config.js";
import * as SessionStorage from "./session/storage.js";
import * as RunEventBus from "./session/run-events.js";
import * as CredentialBrokers from "./session/brokers.js";
import * as CliBridge from "./session/cli-bridge.js";
import * as RunnerCell from "./session/runner-cell.js";
import * as RunnerHandle from "./session/runner.js";
import * as AgentRuns from "./session/agent-runs.js";
import * as VoiceRuntime from "./session/voice.js";
import type { WorkerInitializationState } from "./types.js";

export type SessionServices =
  | SessionConfig.Service
  | SessionStorage.Service
  | RunEventBus.Service
  | CredentialBrokers.Service
  | CliBridge.Service
  | RunnerCell.Service
  | RunnerHandle.Service
  | AgentRuns.Service
  | VoiceRuntime.Service;

/**
 * The per-initialize session graph. Composition order is load-bearing:
 * `Layer.provideMerge` builds dependencies bottom-up (SessionConfig first,
 * VoiceRuntime last) and scope finalizers run LIFO, reproducing the old
 * `stopWorkerServices` teardown order EXACTLY: voice → runner (await
 * in-flight build, stop, drain compactions) → runEventLog.stop → cli bridge
 * stop → credential brokers cleared → db.close.
 *
 * Service-graph evaluation (M5 phase 4): 12 services across two tiers
 * (worker: ModelCatalog/HostBus/WorkerSessions; session: the nine below).
 * A LayerNode-style DAG compiler was considered and REJECTED — one
 * hand-ordered chain per tier stays readable and the finalizer order is
 * documented here in one place. Revisit only if a tier
 * outgrows what this comment can order by hand.
 */
const sessionLayer = (
  init: WorkerInitializationState,
  deviceId: string,
  timeline: BootTimeline,
  runnerGate: RunnerGate,
) => {
  // Boot timing only: each layer's own build time (its dependencies are
  // already built when it starts). Wrapping changes no order or finalizer.
  const timed = <A, E, R>(name: string, layer: Layer.Layer<A, E, R>) =>
    Layer.unwrap(
      Effect.sync(() => {
        const startedAt = performance.now();
        return layer.pipe(
          Layer.tap(() =>
            Effect.sync(() =>
              timeline.step(name, performance.now() - startedAt),
            ),
          ),
        );
      }),
    );
  return timed("layerVoice", VoiceRuntime.layer).pipe(
    Layer.provideMerge(timed("layerAgentRuns", AgentRuns.layer)),
    Layer.provideMerge(
      timed("layerRunnerHandle", RunnerHandle.layer).pipe(
        // Registered after RunnerHandle's own finalizer, so it runs first
        // (LIFO): settle the runner gate before that finalizer awaits the
        // background build. Normal close releases it (build, then stop, as
        // before); a failed or interrupted build rejects it (no runner).
        Layer.tap(() =>
          Effect.addFinalizer((exit) =>
            Effect.sync(() => {
              if (Exit.isSuccess(exit)) {
                runnerGate.open();
              } else {
                runnerGate.fail(
                  new Error(
                    "Runtime session initialization did not complete; runner not started.",
                  ),
                );
              }
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(timed("layerRunEvents", RunEventBus.layer)),
    Layer.provideMerge(timed("layerCliBridge", CliBridge.layer)),
    Layer.provideMerge(timed("layerBrokers", CredentialBrokers.layer)),
    Layer.provideMerge(timed("layerStorage", SessionStorage.layer)),
    Layer.provideMerge(RunnerCell.layer),
    Layer.provideMerge(SessionConfig.layer(init, deviceId)),
  );
};

const BOOT_PROBE_INTERVAL_MS = 25;
const BOOT_PROBE_MAX_MS = 15 * 60_000;

/**
 * Event-loop stall probe for one boot: a 25 ms sleep loop that records the
 * longest overshoot (synchronous work on the worker thread — SQLite, module
 * evaluation, runner construction). Stops when the timeline finishes.
 */
const startBootStallProbe = (timeline: BootTimeline): void => {
  let last = performance.now();
  const loop: Effect.Effect<void> = Effect.sleep(BOOT_PROBE_INTERVAL_MS).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const now = performance.now();
        timeline.noteEventLoopStall(now - last - BOOT_PROBE_INTERVAL_MS);
        last = now;
        return timeline.isFinished || timeline.elapsed() > BOOT_PROBE_MAX_MS
          ? Effect.void
          : loop;
      }),
    ),
  );
  workerRuntime.runFork(loop);
};

/**
 * Report one finished boot: the `worker.ready.timing` process-log event and
 * the `app.performance` `worker-ready` metric. Idempotent per timeline.
 */
const reportBoot = (
  timeline: BootTimeline,
  outcome: BootOutcome,
  fields?: Record<string, string | number | boolean>,
): void => {
  if (timeline.isFinished) return;
  for (const [name, value] of Object.entries(fields ?? {})) {
    timeline.set(name, value);
  }
  if (getActiveBootTimeline() === timeline) setActiveBootTimeline(null);
  const timing = timeline.finish(outcome);
  if (!timing) return;
  const logger = getFileLogger();
  if (logger) {
    logger.process("worker.ready.timing", timing);
  } else {
    // stdio workers (perf lab, child-mode hosts) have no file logger; stderr
    // is their diagnostics channel (stdout carries JSON-RPC).
    console.error(
      `[stella:boot] worker.ready.timing ${JSON.stringify(timing)}`,
    );
  }
  recordRuntimeTelemetry(workerReadyTelemetry(timing));
};

type SessionKey = {
  stellaAppDir: string;
  stellaDataDirPath: string;
  stellaWorkspacePath: string;
};

/** The live session with its scope and typed handles into the built graph. */
export type OpenSession = {
  readonly key: SessionKey;
  readonly scope: Scope.Closeable;
  readonly context: Context.Context<SessionServices>;
  readonly config: SessionConfig.Interface;
  readonly storage: SessionStorage.Interface;
  readonly runEvents: RunEventBus.Interface;
  readonly brokers: CredentialBrokers.Interface;
  readonly runnerCell: RunnerCell.Interface;
  readonly runner: RunnerHandle.Interface;
  readonly agentRuns: AgentRuns.Interface;
  readonly voice: VoiceRuntimeService;
};

export type InitializeResult = {
  protocolVersion: string;
  pid: number;
  deviceId: string | null;
};

export interface Interface {
  readonly initialize: (
    init: WorkerInitializationState,
    options?: { readonly timeline?: BootTimeline },
  ) => Effect.Effect<InitializeResult, ProtocolMismatchError | Error>;
  readonly configure: (
    patch: Partial<WorkerInitializationState>,
  ) => Effect.Effect<{ ok: true; queued?: true }, Error>;
  readonly shutdown: () => Effect.Effect<void>;
  readonly current: () => OpenSession | null;
  readonly hasActiveWork: () => boolean;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/WorkerSessions",
) {}

/** Fetch the current session or fail with the handler's parity error. */
export const sessionOrFail = <E>(
  onMissing: () => E,
): Effect.Effect<OpenSession, E, Service> =>
  Effect.gen(function* () {
    const sessions = yield* Service;
    const session = sessions.current();
    if (!session) {
      return yield* Effect.fail(onMissing());
    }
    return session;
  });

/**
 * Release latch for one session's background runner build (see
 * `sessionRunnerModule`). Settles once; later calls are no-ops.
 */
type RunnerGate = {
  readonly published: Promise<void>;
  readonly open: () => void;
  readonly fail: (error: Error) => void;
};

const makeRunnerGate = (): RunnerGate => {
  let open: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const published = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // Observed by RunnerHandle's build; never an unhandled rejection.
  published.catch(() => undefined);
  return { published, open, fail };
};

/**
 * The RunnerModule handed to one session build.
 *
 * `load()` first waits for `published`: the session's background runner
 * build (RunnerHandle) must not construct/start the runner until the session
 * is published and the initialize response is on its way. Construction runs
 * boot recovery sweeps synchronously and `start()` begins extension and
 * catalog loading; started mid-build they share the worker thread with
 * the rest of the layer build and delay the initialize response (perf lab:
 * ~35 ms of a ~50 ms session build; field: tens of seconds on large agent
 * histories). The import itself is still prefetched at transport attach.
 * The gate is settled no later than scope close (see `sessionLayer`): a
 * session that closes normally before the gate opened still builds and then
 * stops its runner, exactly as before; a build that fails or is interrupted
 * never constructs one. Either way RunnerHandle's finalizer, which awaits
 * the build, cannot hang.
 *
 * Also instrumented for the boot timeline: how long the build waited on the
 * import after publish, and how long synchronous `createStellaHostRunner`
 * took. Same import, same factory, same arguments.
 */
const sessionRunnerModule = (
  runnerModule: RunnerModule.Interface,
  timeline: BootTimeline,
  gate: RunnerGate,
): RunnerModule.Interface => ({
  prefetch: runnerModule.prefetch,
  load: async () => {
    await gate.published;
    const waitStartedAt = performance.now();
    const loaded = await runnerModule.load();
    timeline.step("runnerModuleWait", performance.now() - waitStartedAt);
    return {
      ...loaded,
      createStellaHostRunner: (
        ...args: Parameters<typeof loaded.createStellaHostRunner>
      ) =>
        timeline.time("runnerConstruct", () =>
          loaded.createStellaHostRunner(...args),
        ),
    };
  },
});

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const catalog = yield* ModelCatalog.Service;
    const runnerModule = yield* RunnerModule.Service;

    // JSON-RPC handlers run concurrently (one fiber per request), so
    // initialize/shutdown mutate `currentSession` under this mutex. Without
    // it, two overlapping INITIALIZE calls could both observe no session,
    // build two scopes, and leak whichever one lost the final assignment.
    const sessionLock = yield* Semaphore.make(1);

    let currentSession: OpenSession | null = null;
    let pendingConfigPatch: Partial<WorkerInitializationState> | null = null;

    const applyConfigPatch = (
      session: OpenSession,
      patch: Partial<WorkerInitializationState>,
    ) => {
      session.config.patch(patch);
      const runner = session.runnerCell.get();
      if (patch.backendUrl !== undefined) {
        runner?.setBackendUrl(patch.backendUrl);
      }
      if (patch.authToken !== undefined) {
        runner?.setAuthToken(patch.authToken);
        updateRuntimeTelemetryAuth(patch.authToken);
      }
      if (patch.hasConnectedAccount !== undefined) {
        runner?.setHasConnectedAccount(patch.hasConnectedAccount);
      }
      if (patch.cloudSyncEnabled !== undefined) {
        runner?.setCloudSyncEnabled(patch.cloudSyncEnabled);
      }
      // Auth identity and the backend are the catalog's cache-key inputs
      // the runtime controls; re-warm when either moves.
      if (patch.authToken !== undefined || patch.backendUrl !== undefined) {
        catalog.scheduleWarm(() => session.runnerCell.get());
      }
    };

    const closeCurrent = Effect.suspend(() => {
      const session = currentSession;
      currentSession = null;
      if (!session) return Effect.void;
      // pi's chats run on the runner's tools: they close first.
      return Effect.promise(() =>
        closePiChats(session).catch((error) => {
          console.warn("[runtime-worker] pi chat close failed:", (error as Error).message);
        }),
      ).pipe(Effect.andThen(Scope.close(session.scope, Exit.void)));
    });

    // The whole initialize path holds the session lock and runs under an
    // uninterruptible mask: teardown of the previous session and publication
    // of the new one are atomic, while the long awaits (host identity hop,
    // layer build) stay interruptible via `restore`. An interruption or
    // failure inside the build closes the partially-built scope via onExit,
    // so a losing/interrupted initialize can never leak resources or publish
    // a half-built session.
    const initialize: Interface["initialize"] = (init, options) => {
      const timeline = options?.timeline ?? new BootTimeline();
      const lockRequestedAt = performance.now();
      return sessionLock.withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            timeline.step(
              "sessionLockWait",
              performance.now() - lockRequestedAt,
            );
            if (
              init.protocolVersion &&
              init.protocolVersion !== STELLA_RUNTIME_PROTOCOL_VERSION
            ) {
              return yield* Effect.fail(
                new ProtocolMismatchError({
                  hostVersion: init.protocolVersion,
                }),
              );
            }
            const existing = currentSession;
            const sameRuntimeRoot =
              existing?.key.stellaAppDir === init.stellaAppDir &&
              existing?.key.stellaDataDirPath === init.stellaDataDirPath &&
              existing?.key.stellaWorkspacePath === init.stellaWorkspacePath;
            if (existing && sameRuntimeRoot && existing.runnerCell.get()) {
              applyConfigPatch(existing, init);
              return {
                protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
                pid: process.pid,
                deviceId: existing.config.deviceId,
              };
            }
            // A fresh session is being built: this initialize is a boot.
            // Steps recorded from storage / runner init land on it too.
            setActiveBootTimeline(timeline);
            startBootStallProbe(timeline);
            let bootStep = "closePrevious";
            const closeStartedAt = performance.now();
            yield* closeCurrent.pipe(
              Effect.ensuring(
                Effect.sync(() =>
                  timeline.step(
                    "closePrevious",
                    performance.now() - closeStartedAt,
                  ),
                ),
              ),
            );

            bootStep = "deviceIdentity";
            const deviceIdentity = yield* restore(
              Effect.tryPromise({
                try: () =>
                  timeline.timeAsync("deviceIdentity", () =>
                    hostBus.request<HostDeviceIdentity>(
                      METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
                    ),
                  ),
                catch: (error) => error as Error,
              }),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Effect.sync(() =>
                      reportBoot(
                        timeline,
                        Exit.hasInterrupts(exit) ? "canceled" : "failure",
                        { failedStep: bootStep },
                      ),
                    ),
              ),
            );

            bootStep = "sessionBuild";
            const buildStartedAt = performance.now();
            const runnerGate = makeRunnerGate();
            const scope = yield* Scope.make();
            const context = yield* restore(
              Layer.buildWithScope(
                sessionLayer(
                  init,
                  deviceIdentity.deviceId,
                  timeline,
                  runnerGate,
                ),
                scope,
              ).pipe(
                Effect.provideService(HostBus.Service, hostBus),
                Effect.provideService(
                  RunnerModule.Service,
                  sessionRunnerModule(runnerModule, timeline, runnerGate),
                ),
              ),
            ).pipe(
              // A failed OR interrupted build must not leak the resources
              // acquired so far (onExit runs uninterruptibly on every
              // non-success exit, unlike onError which misses interrupts).
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.sync(() =>
                      timeline.step(
                        "sessionBuild",
                        performance.now() - buildStartedAt,
                      ),
                    )
                  : Scope.close(scope, exit).pipe(
                      Effect.ensuring(
                        Effect.sync(() =>
                          reportBoot(
                            timeline,
                            Exit.hasInterrupts(exit) ? "canceled" : "failure",
                            { failedStep: bootStep },
                          ),
                        ),
                      ),
                    ),
              ),
            );

            const session: OpenSession = {
              key: {
                stellaAppDir: init.stellaAppDir,
                stellaDataDirPath: init.stellaDataDirPath,
                stellaWorkspacePath: init.stellaWorkspacePath,
              },
              scope,
              context,
              config: Context.get(context, SessionConfig.Service),
              storage: Context.get(context, SessionStorage.Service),
              runEvents: Context.get(context, RunEventBus.Service),
              brokers: Context.get(context, CredentialBrokers.Service),
              runnerCell: Context.get(context, RunnerCell.Service),
              runner: Context.get(context, RunnerHandle.Service),
              agentRuns: Context.get(context, AgentRuns.Service),
              voice: Context.get(context, VoiceRuntime.Service).service,
            };
            currentSession = session;
            // Let the background runner build proceed once the initialize
            // response has been written (a timer tick runs after the RPC
            // adapter's response continuation). Scheduled right at publish so
            // a later throw on this path cannot strand RunnerHandle's build;
            // a session closed in the meantime still builds and then stops
            // its runner, exactly as when the build started mid-initialize.
            forkDelayed(0, runnerGate.open);
            // Idle = this exact session is still current and the worker has
            // no run, agent, voice work or in-flight RPC. Teardown
            // clears currentSession first, so maintenance goes quiet before
            // the storage finalizer stops it.
            session.storage.maintenance.start({
              isIdle: () => currentSession === session && !hasSessionWork(),
              attachedClientCount: () => hostBus.attachedClientCount(),
            });
            configureRuntimeTelemetry({
              stellaDataDirPath: init.stellaDataDirPath,
              authToken: init.authToken,
              ...(typeof init.isDev === "boolean" ? { isDev: init.isDev } : {}),
              ...(init.clientVersion ? { release: init.clientVersion } : {}),
            });

            // Post-ready warmups — off the initialize response path, as a
            // forked 0-delay fiber (the old setTimeout(0) block): backfill
            // orphaned run events, then wait out the background runner build
            // for startup logging.
            forkDelayed(0, () => {
              void (async () => {
                const startupStartedAt = Date.now();
                let runnerOutcome: BootOutcome = "success";
                await Promise.allSettled([
                  (async () => {
                    if (currentSession?.scope === scope) {
                      timeline.time("runEventBackfill", () =>
                        session.runEvents.startupBackfill(),
                      );
                    }
                  })(),
                  (async () => {
                    const builtRunner =
                      await session.runner.awaitBuildSettled();
                    if (!builtRunner) runnerOutcome = "failure";
                    // The initialize-time warm below no-ops while the runner
                    // is still building; warm once it exists, as before.
                    if (builtRunner && currentSession === session) {
                      catalog.scheduleWarm(() => session.runnerCell.get());
                    }
                    await builtRunner?.waitUntilInitialized().catch((error) => {
                      runnerOutcome = "failure";
                      console.warn(
                        "[runtime-worker] Runner initialization finished with an error:",
                        (error as Error).message,
                      );
                    });
                    // Conversations on pi-durable resume their own work.
                    if (builtRunner && currentSession === session) {
                      void resumePiChats(session, hostBus).catch((error) => {
                        console.warn(
                          "[runtime-worker] pi chat resume failed:",
                          (error as Error).message,
                        );
                      });
                    }
                  })(),
                ]);
                getFileLogger()?.process("startup.post-ready-complete", {
                  ms: Date.now() - startupStartedAt,
                });
                reportBoot(timeline, runnerOutcome, {
                  readyAfterInitializeMs:
                    Math.round((timeline.elapsed() - initializedAtMs) * 10) /
                    10,
                });
              })();
            });

            if (pendingConfigPatch) {
              applyConfigPatch(session, pendingConfigPatch);
              pendingConfigPatch = null;
            }
            // Warm the catalog against whatever config the worker initialized
            // with so a restart/reattach doesn't make the next chat pay the
            // cold fetch. Best-effort; no-ops while the runner is building.
            catalog.scheduleWarm(() => session.runnerCell.get());

            const initializedAtMs = timeline.elapsed();
            timeline.mark("initialized");
            return {
              protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
              pid: process.pid,
              deviceId: deviceIdentity.deviceId,
            };
          }),
        ),
      );
    };

    const configure: Interface["configure"] = (patch) =>
      Effect.gen(function* () {
        const session = currentSession;
        if (!session) {
          // Queue the patch — it will be applied after initialization.
          pendingConfigPatch = { ...pendingConfigPatch, ...patch };
          return { ok: true as const, queued: true as const };
        }
        applyConfigPatch(session, patch);
        if (patch.localLlmCredentialsUpdatedAt !== undefined) {
          yield* Effect.tryPromise({
            try: () => session.brokers.refreshLocalLlmCredentialAccess(),
            catch: (error) => error as Error,
          });
        }
        return { ok: true as const };
      });

    const hasSessionWork = () => {
      // Everything a worker shutdown would interrupt, the work the host
      // cannot observe after a disconnect included.
      const session = currentSession;
      const voicePinned =
        (session?.voice.isBusy() ?? false) ||
        (session?.voice.getPendingRequestCount() ?? 0) > 0;
      const requestPinned = hostBus.activeRequestHandlerCount() > 0;
      const runner = session?.runnerCell.get() ?? null;
      return Boolean(
        runner?.getActiveOrchestratorRun() ||
          (runner?.getActiveAgentCount() ?? 0) > 0 ||
          (session ? piChatsBusy(session) : false) ||
          requestPinned ||
          voicePinned,
      );
    };

    // Idle-shutdown keep-alive: session work, plus a DB reclaim that is
    // running or ready for the zero-client window (maintenance.ts). The
    // maintenance idle check uses hasSessionWork, never this, so the hold
    // cannot make maintenance think the worker is busy.
    const hasActiveWork = () =>
      hasSessionWork() ||
      (currentSession?.storage.maintenance.holdsWorkerAlive() ?? false);

    return {
      initialize,
      configure,
      // Shares the session lock with initialize so a shutdown cannot
      // interleave with an in-flight initialize and strand its session.
      shutdown: () => sessionLock.withPermit(closeCurrent),
      current: () => currentSession,
      hasActiveWork,
    };
  }),
);
