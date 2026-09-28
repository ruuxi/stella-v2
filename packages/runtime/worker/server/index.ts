import { Effect, Layer, ManagedRuntime } from "effect";
import type { WorkerPeerLike } from "../peer-broker.js";
import * as HostBus from "./host-bus.js";
import * as ModelCatalog from "./model-catalog.js";
import * as RunnerModule from "./runner-module.js";
import * as WorkerSessions from "./sessions.js";
import { attachWorkerRpcHandlers, type WorkerRpcContext } from "./rpc.js";
import { lifecycleHandlers } from "./handlers/lifecycle.js";
import { chatHandlers } from "./handlers/chat.js";
import { runsHandlers } from "./handlers/runs.js";
import { localChatHandlers } from "./handlers/local-chat.js";
import { voiceHandlers } from "./handlers/voice.js";
import { runnerOpsHandlers } from "./handlers/runner-ops.js";
import { projectsHandlers } from "./handlers/projects.js";
import { discoveryHandlers } from "./handlers/discovery.js";

/**
 * The runtime worker server: per-domain Effect services composed at this
 * entry, dispatched over JSON-RPC by the thin adapter in rpc.ts.
 *
 * Base (process-lifetime) services build once into a ManagedRuntime; the
 * per-initialize session graph (storage, brokers, cli bridge, runner, agent
 * runs, voice) is scope-managed by WorkerSessions — see
 * docs/effect-architecture.md.
 *
 * Signature-compatible with the old monolithic server.ts: same peer wiring,
 * same `{ hasActiveWork, shutdown }` surface for the worker entrypoint.
 */
export const createRuntimeWorkerServer = (
  peer: WorkerPeerLike,
): {
  hasActiveWork: () => boolean;
  prefetchRunner: () => void;
  shutdown: () => Promise<void>;
} => {
  const baseLayer: Layer.Layer<WorkerRpcContext> = WorkerSessions.layer.pipe(
    Layer.provideMerge(ModelCatalog.layer),
    Layer.provideMerge(RunnerModule.layer),
    Layer.provideMerge(HostBus.layer(peer)),
  );
  const runtime = ManagedRuntime.make(baseLayer);

  attachWorkerRpcHandlers(peer, runtime, {
    ...lifecycleHandlers,
    ...chatHandlers,
    ...runsHandlers,
    ...localChatHandlers,
    ...voiceHandlers,
    ...runnerOpsHandlers,
    ...projectsHandlers,
    ...discoveryHandlers,
  });

  // Warm the base layer so the sync hasActiveWork path never has to build it.
  const ready = runtime.runPromise(Effect.void).catch(() => undefined);

  const hasActiveWork = (): boolean =>
    runtime.runSync(
      Effect.map(WorkerSessions.Service, (sessions) =>
        sessions.hasActiveWork(),
      ),
    );

  // Start the runner-module import ahead of initialize (see
  // runner-module.ts). The import fiber lives in the base layer's scope.
  // It waits one timer tick so requests already buffered on the transport
  // (a stdio host writes before the worker attaches) are dispatched first;
  // starting it synchronously delayed the first response by the whole
  // import (+38 ms in the perf lab) for no gain in spawn→ready.
  const prefetchRunner = (): void => {
    void runtime
      .runPromise(
        Effect.andThen(
          Effect.sleep(0),
          Effect.flatMap(RunnerModule.Service, (m) => m.prefetch),
        ),
      )
      .catch(() => undefined);
  };

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await ready;
    await runtime.runPromise(
      Effect.gen(function* () {
        const catalog = yield* ModelCatalog.Service;
        const sessions = yield* WorkerSessions.Service;
        catalog.dispose();
        yield* sessions.shutdown();
      }),
    );
  };

  return { hasActiveWork, prefetchRunner, shutdown };
};
