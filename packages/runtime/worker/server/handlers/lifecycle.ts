import { Effect } from "effect";
import {
  METHOD_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
  type AgentHealth,
} from "@stella/contracts/protocol";
import { createEmptySocialSessionServiceSnapshot } from "@stella/contracts";
import * as ModelCatalog from "../model-catalog.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";
import type { WorkerInitializationState } from "../types.js";

export const lifecycleHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_INITIALIZE]: (params) =>
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog.Service;
      const sessions = yield* WorkerSessions.Service;
      // Subscribe before the runner loads extensions or models.json so every
      // successful initial/hot registry composition reaches the renderer.
      yield* fromPromise(() => catalog.ensureSubscription());
      return yield* sessions.initialize(params as WorkerInitializationState);
    }),

  [METHOD_NAMES.INTERNAL_WORKER_CONFIGURE]: (params) =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      return yield* sessions.configure(
        params as Partial<WorkerInitializationState>,
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_HEALTH]: () =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      const session = sessions.current();
      const runner = session?.runnerCell.get() ?? null;
      const health =
        runner?.agentHealthCheck() ?? ({ ready: false } satisfies AgentHealth);
      const socialSessions =
        session?.social.getSnapshot() ??
        createEmptySocialSessionServiceSnapshot();
      const activeRun =
        runner?.getActiveOrchestratorRun() ??
        runner?.listActiveAgentRuns()[0] ??
        null;
      return {
        health,
        activeRun,
        activeAgentCount: runner?.getActiveAgentCount() ?? 0,
        protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
        pid: process.pid,
        deviceId: session?.config.deviceId ?? null,
        voiceBusy: session?.voice.isBusy() ?? false,
        pendingVoiceRequestCount:
          session?.voice.getPendingRequestCount() ?? 0,
        socialSessions,
      };
    }),

  [METHOD_NAMES.RUNTIME_HEALTH]: () =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      const session = sessions.current();
      const runner = session?.runnerCell.get() ?? null;
      const activeRun =
        runner?.getActiveOrchestratorRun() ??
        runner?.listActiveAgentRuns()[0] ??
        null;
      return {
        ready: Boolean(runner?.agentHealthCheck().ready),
        hostPid: process.pid,
        workerPid: process.pid,
        workerRunning: true,
        workerGeneration: 0,
        deviceId: session?.config.deviceId ?? null,
        activeRunId: activeRun?.runId ?? null,
        activeAgentCount: runner?.getActiveAgentCount() ?? 0,
      };
    }),

  [METHOD_NAMES.INTERNAL_WORKER_LIST_MODELS]: (params) =>
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog.Service;
      const modelRuntime = yield* fromPromise(() =>
        catalog.ensureSubscription(),
      );
      const forceRefresh =
        Boolean(params) &&
        typeof params === "object" &&
        (params as { forceRefresh?: unknown }).forceRefresh === true;
      return yield* fromPromise(() =>
        modelRuntime.getSnapshotForListing({ forceRefresh }),
      );
    }),
};
