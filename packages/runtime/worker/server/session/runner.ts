import { existsSync } from "node:fs";
import path from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  type HostAppBrowserContextSnapshot,
} from "@stella/contracts/protocol";
import { resolveBundledRuntimeFile } from "../../../kernel/shared/runtime-paths.js";
import {
  listTranscriptNeighborsBatch,
  readRecallFtsHealth,
} from "../../../kernel/storage/recall-read-queries.js";
// Runner subgraph imported as types only — the values are loaded lazily (see
// the dynamic import in the build promise below) so this ~68%-of-bundle
// subgraph isn't parsed on the worker-ready path.
import type { StellaHostRunnerOptions } from "../../../kernel/runner.js";
import { RunnerUnavailableError } from "../errors.js";
import * as HostBus from "../host-bus.js";
import * as SessionConfig from "./config.js";
import * as SessionStorage from "./storage.js";
import * as CliBridge from "./cli-bridge.js";
import * as RunnerCell from "./runner-cell.js";
import type { RuntimeRunner } from "../types.js";

const resolveDesktopCliEntrypoint = (
  stellaAppDir: string,
  packageName: string,
  entrypoint: string,
): string => {
  const resourcesPath = process.env.STELLA_APP_RESOURCES_PATH?.trim();
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, packageName, "bin", entrypoint);
    if (existsSync(packaged)) {
      return packaged;
    }
  }
  const desktopLocal = path.join(
    stellaAppDir,
    "desktop",
    packageName,
    "bin",
    entrypoint,
  );
  if (existsSync(desktopLocal)) {
    return desktopLocal;
  }

  return path.join(stellaAppDir, packageName, "bin", entrypoint);
};

// Resolve a runtime CLI bundled into desktop/dist-electron/runtime/kernel/cli/.
const resolveRuntimeCliPath = (fileName: string) =>
  resolveBundledRuntimeFile(`kernel/cli/${fileName}`);

/**
 * Owns the session's runner lifecycle. The runner is built in the background
 * (dynamic import — its module subgraph is only needed once a turn runs and
 * esbuild code-splits it out of the eager worker bundle) and registered into
 * RunnerCell when ready. The scope finalizer awaits any in-flight build and
 * then stops the runner, so a re-init can never strand a
 * started-but-unreferenced runner — the structural replacement for the old
 * `state.db !== db` supersede guard.
 *
 * Access modes preserve the old handler semantics exactly:
 * - `tryCurrent`   → `state.runner` (tolerant handlers)
 * - `current`      → `ensureRunner()` ("Runtime worker is not ready.")
 * - `joined`       → `joinRunnerBuild()` + `ensureRunner()`
 * - `initialized`  → `ensureRunnerInitialized()` (join + waitUntilInitialized)
 */
export interface Interface {
  readonly tryCurrent: () => RuntimeRunner | null;
  readonly current: Effect.Effect<RuntimeRunner, RunnerUnavailableError>;
  readonly joined: Effect.Effect<RuntimeRunner, RunnerUnavailableError>;
  readonly initialized: Effect.Effect<
    RuntimeRunner,
    RunnerUnavailableError | Error
  >;
  /**
   * Promise flavor of `initialized` for imperative pipelines that need the
   * old `await ensureRunnerInitialized()` shape (startChat image-target
   * probing swallows its failure, matching the old try/catch).
   */
  readonly ensureInitialized: () => Promise<RuntimeRunner>;
  /** Resolves when the background build settles (null = build failed). */
  readonly awaitBuildSettled: () => Promise<RuntimeRunner | null>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/RunnerHandle",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const config = yield* SessionConfig.Service;
    const storage = yield* SessionStorage.Service;
    const cliBridge = yield* CliBridge.Service;
    const runnerCell = yield* RunnerCell.Service;
    const init = config.get();

    const runnerOptions: StellaHostRunnerOptions = {
      deviceId: config.deviceId,
      stellaAppDir: init.stellaAppDir,
      stellaDataDir: init.stellaDataDirPath,
      runtimeStore: storage.runtimeStore,
      getAppBrowserContext: async () =>
        (await hostBus.request(
          METHOD_NAMES.HOST_APP_BROWSER_CONTEXT_GET,
          undefined,
          {
            retryOnDisconnect: true,
          },
        )) as HostAppBrowserContextSnapshot,
      listLocalChatEvents: (conversationId, maxItems) =>
        storage.chatStore.listEvents(conversationId, maxItems),
      recallReadQueries: {
        getFtsHealth: () => readRecallFtsHealth(storage.db),
        listTranscriptNeighborsBatch: (targets, options) =>
          listTranscriptNeighborsBatch(storage.db, targets, options),
      },
      appendLocalChatEvent: (args) => {
        storage.appendChatEventAndNotify(args);
      },
      notifyThreadActivityUpdated: (conversationId) => {
        hostBus.notify(NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED, {
          conversationId,
        });
      },
      getDefaultConversationId: () =>
        storage.chatStore.getOrCreateDefaultConversationId(),
      requestCredential: async (payload) =>
        await hostBus.request(METHOD_NAMES.HOST_CREDENTIALS_REQUEST, payload, {
          retryOnDisconnect: true,
        }),
      requestBrowserExtensionConnect: (payload, signal) =>
        hostBus.requestConnectCard(
          METHOD_NAMES.HOST_BROWSER_EXTENSION_CONNECT_REQUEST,
          payload as Record<string, unknown>,
          signal,
        ),
      requestComputerUseAppApproval: async (payload) =>
        await hostBus.request(
          METHOD_NAMES.HOST_COMPUTER_USE_APP_APPROVAL_REQUEST,
          payload,
          { retryOnDisconnect: true },
        ),
      requestConnectorConnection: (payload, signal) =>
        hostBus.requestConnectCard(
          METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST,
          payload as Record<string, unknown>,
          signal,
        ),
      requestRuntimeAuthRefresh: async (payload) =>
        await hostBus.request(METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH, payload, {
          retryOnDisconnect: true,
        }),
      scheduleApi: {
        listCronJobs: async () =>
          await hostBus.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_LIST_CRON_JOBS,
            undefined,
            { retryOnDisconnect: true },
          ),
        addCronJob: async (input) =>
          await hostBus.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_ADD_CRON_JOB,
            input,
            { retryOnDisconnect: true },
          ),
        updateCronJob: async (jobId, patch) =>
          await hostBus.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_UPDATE_CRON_JOB,
            {
              jobId,
              patch,
            },
            { retryOnDisconnect: true },
          ),
        removeCronJob: async (jobId) =>
          await hostBus.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_REMOVE_CRON_JOB,
            {
              jobId,
            },
            { retryOnDisconnect: true },
          ),
        runCronJob: async (jobId) =>
          await hostBus.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_RUN_CRON_JOB,
            {
              jobId,
            },
            { retryOnDisconnect: true },
          ),
        getHeartbeatConfig: async (conversationId) =>
          await hostBus.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG,
            {
              conversationId,
            },
            { retryOnDisconnect: true },
          ),
        upsertHeartbeat: async (input) =>
          await hostBus.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_UPSERT_HEARTBEAT,
            input,
            { retryOnDisconnect: true },
          ),
        runHeartbeat: async (conversationId) =>
          await hostBus.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_RUN_HEARTBEAT,
            {
              conversationId,
            },
            { retryOnDisconnect: true },
          ),
      },
      stellaBrowserBinPath: resolveDesktopCliEntrypoint(
        init.stellaAppDir,
        "stella-browser",
        "stella-browser.js",
      ),
      stellaOfficeBinPath: resolveDesktopCliEntrypoint(
        init.stellaAppDir,
        "stella-office",
        "stella-office.js",
      ),
      stellaComputerCliPath: resolveRuntimeCliPath("stella-computer.js"),
      stellaConnectCliPath: resolveRuntimeCliPath("stella-connect.js"),
      stellaMediaCliPath: resolveRuntimeCliPath("stella-media.js"),
      stellaXApiCliPath: resolveRuntimeCliPath("stella-x-api.js"),
      // The bridge is already listening (its layer builds before this one).
      // Advertise the stable socket path so shells can call back into the
      // host without rebuilding the runner.
      ...(cliBridge.socketPath
        ? { cliBridgeSocketPath: cliBridge.socketPath }
        : {}),
    };

    // Build the runner in the background instead of on the worker-ready path:
    // initialize returns without awaiting this; turn handlers join the same
    // promise via `initialized`. The dynamic import() is also what lets
    // esbuild split the runner into its own chunk (see dev-electron-build.mjs).
    const buildPromise: Promise<RuntimeRunner | null> = (async () => {
      const { createStellaHostRunner } = await import(
        "../../../kernel/runner.js"
      );
      const runner = createStellaHostRunner(runnerOptions);
      // Apply the latest config (config patches that arrived during the
      // import fanned out against an empty RunnerCell, so re-apply).
      const cfg = config.get();
      runner.setConvexUrl(cfg.convexUrl);
      runner.setConvexSiteUrl(cfg.convexSiteUrl);
      runner.setAuthToken(cfg.authToken);
      runner.setHasConnectedAccount(cfg.hasConnectedAccount);
      runner.setCloudSyncEnabled(cfg.cloudSyncEnabled);
      runner.setModelCatalogUpdatedAt(cfg.modelCatalogUpdatedAt);
      runnerCell.set(runner);
      runner.start();
      return runner;
    })();
    // Prevent an unobserved rejection from crashing the worker; real awaiters
    // (initialized access / the finalizer / the post-ready block) surface it.
    const settled = buildPromise.catch(() => null);

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        // If the runner is still building (lazy chunk import), wait for it to
        // finish so we don't strand a started-but-unreferenced runner. Then
        // stop it — `runner.stop()` awaits a bounded drain of the background
        // compaction scheduler so SQLite writes complete before the storage
        // finalizer closes the db.
        await settled;
        const runner = runnerCell.get();
        runnerCell.set(null);
        await runner?.stop();
      }),
    );

    const tryCurrent = () => runnerCell.get();

    const current = Effect.suspend(() => {
      const runner = runnerCell.get();
      return runner
        ? Effect.succeed(runner)
        : Effect.fail(new RunnerUnavailableError());
    });

    const joined = Effect.promise(() => settled).pipe(
      Effect.flatMap(() => current),
    );

    const ensureInitialized = async () => {
      await settled;
      const runner = runnerCell.get();
      if (!runner) {
        throw new RunnerUnavailableError();
      }
      await runner.waitUntilInitialized();
      return runner;
    };

    const initialized = joined.pipe(
      Effect.tap((runner) =>
        Effect.tryPromise({
          try: () => runner.waitUntilInitialized(),
          catch: (error) => error as Error,
        }),
      ),
    );

    return {
      tryCurrent,
      current,
      joined,
      initialized,
      ensureInitialized,
      awaitBuildSettled: () => settled,
    };
  }),
);
