import { Context, Effect, Exit, Layer, Scope, Semaphore } from "effect";
import {
  METHOD_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
  type HostDeviceIdentity,
} from "@stella/contracts/protocol";
import { createEmptySocialSessionServiceSnapshot } from "@stella/contracts";
import { getFileLogger } from "../../observability/file-logger.js";
import type { SocialSessionService } from "../social-sessions/service.js";
import type { VoiceRuntimeService } from "../voice/service.js";
import { ProtocolMismatchError } from "./errors.js";
import * as HostBus from "./host-bus.js";
import * as ModelCatalog from "./model-catalog.js";
import * as SessionConfig from "./session/config.js";
import * as SessionStorage from "./session/storage.js";
import * as RunEventBus from "./session/run-events.js";
import * as CredentialBrokers from "./session/brokers.js";
import * as CliBridge from "./session/cli-bridge.js";
import * as RunnerCell from "./session/runner-cell.js";
import * as RunnerHandle from "./session/runner.js";
import * as AgentRuns from "./session/agent-runs.js";
import * as SocialSessions from "./session/social.js";
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
  | SocialSessions.Service
  | VoiceRuntime.Service;

/**
 * The per-initialize session graph. Composition order is load-bearing:
 * `Layer.provideMerge` builds dependencies bottom-up (SessionConfig first,
 * SocialSessions last) and scope finalizers run LIFO, reproducing the old
 * `stopWorkerServices` teardown order EXACTLY: social.stop → voice → runner
 * (await in-flight build, stop, drain compactions) → runEventLog.stop →
 * cli bridge stop → credential brokers cleared → db.close.
 */
const sessionLayer = (init: WorkerInitializationState, deviceId: string) =>
  SocialSessions.layer.pipe(
    Layer.provideMerge(VoiceRuntime.layer),
    Layer.provideMerge(AgentRuns.layer),
    Layer.provideMerge(RunnerHandle.layer),
    Layer.provideMerge(RunEventBus.layer),
    Layer.provideMerge(CliBridge.layer),
    Layer.provideMerge(CredentialBrokers.layer),
    Layer.provideMerge(SessionStorage.layer),
    Layer.provideMerge(RunnerCell.layer),
    Layer.provideMerge(SessionConfig.layer(init, deviceId)),
  );

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
  readonly social: SocialSessionService;
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const catalog = yield* ModelCatalog.Service;

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
      if (patch.convexUrl !== undefined) {
        runner?.setConvexUrl(patch.convexUrl);
        session.social.setConvexUrl(patch.convexUrl);
      }
      if (patch.convexSiteUrl !== undefined) {
        runner?.setConvexSiteUrl(patch.convexSiteUrl);
      }
      if (patch.authToken !== undefined) {
        runner?.setAuthToken(patch.authToken);
        session.social.setAuthToken(patch.authToken);
      }
      if (patch.hasConnectedAccount !== undefined) {
        runner?.setHasConnectedAccount(patch.hasConnectedAccount);
      }
      if (patch.cloudSyncEnabled !== undefined) {
        runner?.setCloudSyncEnabled(patch.cloudSyncEnabled);
      }
      if (patch.modelCatalogUpdatedAt !== undefined) {
        runner?.setModelCatalogUpdatedAt(patch.modelCatalogUpdatedAt);
      }
      // Auth identity and the catalog version are the two cache-key inputs
      // the runtime controls; re-warm when either moves.
      if (
        patch.authToken !== undefined ||
        patch.modelCatalogUpdatedAt !== undefined
      ) {
        catalog.scheduleWarm(() => session.runnerCell.get());
      }
    };

    const closeCurrent = Effect.suspend(() => {
      const session = currentSession;
      currentSession = null;
      if (!session) return Effect.void;
      return Scope.close(session.scope, Exit.void);
    });

    // The whole initialize path holds the session lock and runs under an
    // uninterruptible mask: teardown of the previous session and publication
    // of the new one are atomic, while the long awaits (host identity hop,
    // layer build) stay interruptible via `restore`. An interruption or
    // failure inside the build closes the partially-built scope via onExit,
    // so a losing/interrupted initialize can never leak resources or publish
    // a half-built session.
    const initialize: Interface["initialize"] = (init) =>
      sessionLock.withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
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
            yield* closeCurrent;

            const deviceIdentity = yield* restore(
              Effect.tryPromise({
                try: () =>
                  hostBus.request<HostDeviceIdentity>(
                    METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
                  ),
                catch: (error) => error as Error,
              }),
            );

            const scope = yield* Scope.make();
            const context = yield* restore(
              Layer.buildWithScope(
                sessionLayer(init, deviceIdentity.deviceId),
                scope,
              ).pipe(Effect.provideService(HostBus.Service, hostBus)),
            ).pipe(
              // A failed OR interrupted build must not leak the resources
              // acquired so far (onExit runs uninterruptibly on every
              // non-success exit, unlike onError which misses interrupts).
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit),
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
              social: Context.get(context, SocialSessions.Service).service,
              voice: Context.get(context, VoiceRuntime.Service).service,
            };
            currentSession = session;

            // Post-ready warmups — off the initialize response path, exactly
            // like the old setTimeout(0) block: backfill orphaned run events,
            // then wait out the background runner build for startup logging.
            setTimeout(() => {
              void (async () => {
                const startupStartedAt = Date.now();
                await Promise.allSettled([
                  (async () => {
                    if (currentSession?.scope === scope) {
                      session.runEvents.startupBackfill();
                    }
                  })(),
                  (async () => {
                    const builtRunner =
                      await session.runner.awaitBuildSettled();
                    await builtRunner?.waitUntilInitialized().catch((error) => {
                      console.warn(
                        "[runtime-worker] Runner initialization finished with an error:",
                        (error as Error).message,
                      );
                    });
                  })(),
                ]);
                getFileLogger()?.process("startup.post-ready-complete", {
                  ms: Date.now() - startupStartedAt,
                });
              })();
            }, 0);

            if (pendingConfigPatch) {
              applyConfigPatch(session, pendingConfigPatch);
              pendingConfigPatch = null;
            }
            // Warm the catalog against whatever config the worker initialized
            // with so a restart/reattach doesn't make the next chat pay the
            // cold fetch. Best-effort; no-ops while the runner is building.
            catalog.scheduleWarm(() => session.runnerCell.get());

            return {
              protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
              pid: process.pid,
              deviceId: deviceIdentity.deviceId,
            };
          }),
        ),
      );

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

    const hasActiveWork = () => {
      // Keep this in sync with host-side shouldKeepWorkerAlive plus
      // worker-only work that the host cannot observe after disconnect.
      const session = currentSession;
      const socialSessions =
        session?.social.getSnapshot() ??
        createEmptySocialSessionServiceSnapshot();
      const socialPinned =
        socialSessions.sessionCount > 0 ||
        Boolean(socialSessions.processingTurnId);
      const voicePinned =
        (session?.voice.isBusy() ?? false) ||
        (session?.voice.getPendingRequestCount() ?? 0) > 0;
      const requestPinned = hostBus.activeRequestHandlerCount() > 0;
      const runner = session?.runnerCell.get() ?? null;
      return Boolean(
        runner?.getActiveOrchestratorRun() ||
          (runner?.getActiveAgentCount() ?? 0) > 0 ||
          requestPinned ||
          socialPinned ||
          voicePinned,
      );
    };

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
