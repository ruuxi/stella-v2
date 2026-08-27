import { mkdirSync, watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  loadBundledAgents,
  mergeBundledAndExtensionAgents,
} from "../agents/agents.js";
import { loadExtensions } from "../extensions/loader.js";
import type { ExtensionServices } from "../extensions/services.js";
import { modelRuntime } from "../../ai/model-runtime.js";
import { createRuntimeLogger } from "../debug.js";
import type { RunnerContext } from "./types.js";

const logger = createRuntimeLogger("runtime-init");

type ExtensionReloadResult = {
  status: "reloaded" | "busy" | "not-initialized" | "load-failed";
  reason?: string;
};

export type ExtensionWatchScope = "resource-tree" | "data-dir";

export const isExtensionWatchChangeRelevant = (
  scope: ExtensionWatchScope,
  filename: string | Buffer | null,
): boolean => {
  if (scope === "data-dir") {
    return filename !== null && path.basename(String(filename)) === "system";
  }
  if (filename === null) return true;
  const basename = path.basename(String(filename));
  return !basename.startsWith(".") && !basename.endsWith("~");
};

export const createExtensionReloadScheduler = (
  reload: (options: { logBusy: boolean }) => Promise<ExtensionReloadResult>,
  options: { debounceMs?: number; busyRetryMs?: number } = {},
) => {
  const debounceMs = options.debounceMs ?? 500;
  const busyRetryMs = options.busyRetryMs ?? 2_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let pending = false;
  let inFlight = false;
  let busyLogged = false;

  const queueAttempt = (delayMs: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void attemptReload();
    }, delayMs);
  };

  const attemptReload = async (): Promise<void> => {
    if (!pending || inFlight) return;
    inFlight = true;
    const attemptedGeneration = generation;
    let result: ExtensionReloadResult | undefined;
    let failed = false;
    let failure: unknown;
    try {
      result = await reload({ logBusy: !busyLogged });
    } catch (error) {
      failed = true;
      failure = error;
    } finally {

      inFlight = false;
    }
    if (!pending) return;

    if (failed) {
      logger.warn("extensions.reload.unexpected-failure", {
        error: failure instanceof Error ? failure.message : String(failure),
      });
      if (generation !== attemptedGeneration) {

        queueAttempt(debounceMs);
      } else {
        pending = false;
        busyLogged = false;
      }
      return;
    }

    if (result?.status === "busy") {
      busyLogged = true;
      queueAttempt(
        generation === attemptedGeneration ? busyRetryMs : debounceMs,
      );
      return;
    }
    if (generation !== attemptedGeneration) {
      queueAttempt(debounceMs);
      return;
    }
    pending = false;
    busyLogged = false;
  };

  return {
    schedule: () => {
      generation += 1;
      if (!pending) {
        pending = true;
        busyLogged = false;
      }
      queueAttempt(debounceMs);
    },
    cancel: () => {
      generation += 1;
      pending = false;
      busyLogged = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
};

export const createRuntimeInitialization = (
  context: RunnerContext,
  deps: {
    disposeConvexClient: () => void;
    shutdownTasks: () => void;
  },
) => {

  const installLoadedExtensions = (
    extensions: Awaited<ReturnType<typeof loadExtensions>>,
  ): void => {
    context.state.loadedAgents = mergeBundledAndExtensionAgents(
      extensions.agents,
    );
    for (const hook of extensions.hooks) {

      context.hookEmitter.register({
        ...hook,
        source: "extension",
      });
    }
    context.toolHost.registerExtensionTools(extensions.tools);
    modelRuntime.setExtensionProviders(extensions.providers);
    for (const providerDef of extensions.providers) {
      logger.info(`extensions.provider.registered.${providerDef.name}`, {
        modelCount: providerDef.models.length,
      });
    }
    logger.info("extensions.ready", {
      tools: extensions.tools.length,
      hooks: extensions.hooks.length,
      providers: extensions.providers.length,
      prompts: extensions.prompts.length,
    });
  };

  const buildExtensionServices = (): ExtensionServices => ({
    stellaDataDir: context.stellaDataDir,
    stellaAppDir: context.stellaAppDir,
    store: context.runtimeStore,
  });

  const loadAndRegisterExtensions = async (): Promise<void> => {
    try {
      const extensions = await loadExtensions(
        context.paths.extensionsPath,
        buildExtensionServices(),
      );
      installLoadedExtensions(extensions);
    } catch (error) {
      context.state.loadedAgents = loadBundledAgents();
      console.error(
        "[stella:extensions] Failed to load extensions:",
        (error as Error).message,
      );
    }
  };

  const initializeRuntime = () => {

    const extensionsLoad = loadAndRegisterExtensions();
    const modelsLoad = modelRuntime.initialize({
      stellaDataDir: context.stellaDataDir,
      allowNetwork: false,
    });
    void modelsLoad
      .then(() => modelRuntime.refresh({ allowNetwork: true }))
      .then(() => {
        logger.info("model-runtime.catalog.ready", {
          modelCount: modelRuntime.getAllModels().length,
        });
      })
      .catch((error) => {
        logger.warn("model-runtime.catalog.load-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    context.state.initializationPromise = Promise.all([
      extensionsLoad,
      modelsLoad,
    ]).then(() => {
      context.state.isInitialized = true;
    });

    return context.state.initializationPromise;
  };

  const computeBusyReason = (): string | null => {
    if (context.state.activeOrchestratorRunId) {
      return `orchestrator run ${context.state.activeOrchestratorRunId} is active`;
    }

    const activeAgents =
      context.state.localAgentManager?.getActiveAgentCount() ?? 0;
    if (activeAgents > 0) {
      return `${activeAgents} subagent task${
        activeAgents === 1 ? "" : "s"
      } running`;
    }
    return null;
  };

  const reloadUserExtensions = async (
    options: { logBusy?: boolean } = {},
  ): Promise<ExtensionReloadResult> => {
    if (!context.state.isInitialized) {
      return { status: "not-initialized" };
    }
    const busyReason = computeBusyReason();
    if (busyReason) {
      if (options.logBusy !== false) {
        logger.info("extensions.reload.deferred", { reason: busyReason });
      }
      return { status: "busy", reason: busyReason };
    }
    logger.info("extensions.reload.start");

    let extensions: Awaited<ReturnType<typeof loadExtensions>>;
    try {
      extensions = await loadExtensions(
        context.paths.extensionsPath,
        buildExtensionServices(),
      );
    } catch (error) {

      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("extensions.reload.load-failed", { error: reason });
      return { status: "load-failed", reason };
    }

    context.hookEmitter.clearBySource("extension");
    context.toolHost.unregisterExtensionTools();
    installLoadedExtensions(extensions);
    await modelRuntime.reloadConfig();
    logger.info("extensions.reload.done");
    return { status: "reloaded" };
  };

  let resourceWatchers: FSWatcher[] = [];
  let modelConfigWatcher: FSWatcher | null = null;
  let modelConfigDebounce: NodeJS.Timeout | null = null;
  const FILE_WATCH_DEBOUNCE_MS = 500;
  const RELOAD_BUSY_RETRY_MS = 2_000;
  const extensionReloadScheduler = createExtensionReloadScheduler(
    ({ logBusy }) => reloadUserExtensions({ logBusy }),
    {
      debounceMs: FILE_WATCH_DEBOUNCE_MS,
      busyRetryMs: RELOAD_BUSY_RETRY_MS,
    },
  );

  const startExtensionWatcher = () => {
    if (resourceWatchers.length > 0) return;

    const agentsPath = path.join(context.stellaDataDir, "agents");

    try {
      mkdirSync(agentsPath, { recursive: true });
    } catch (error) {
      logger.warn("extensions.watch.prepare-failed", {
        error: error instanceof Error ? error.message : String(error),
        path: agentsPath,
      });
    }
    const watchPaths = [
      {
        path: context.paths.extensionsPath,
        recursive: true,
        scope: "resource-tree" as const,
      },
      {
        path: agentsPath,
        recursive: true,
        scope: "resource-tree" as const,
      },

      {
        path: context.stellaDataDir,
        recursive: false,
        scope: "data-dir" as const,
      },
    ];
    for (const { path: watchPath, recursive, scope } of watchPaths) {
      try {
        const watcher = fsWatch(
          watchPath,
          { recursive },
          (_eventType, filename) => {
            if (!isExtensionWatchChangeRelevant(scope, filename)) return;
            extensionReloadScheduler.schedule();
          },
        );
        watcher.on("error", (error) => {
          logger.warn("extensions.watch.error", {
            error: error instanceof Error ? error.message : String(error),
            path: watchPath,
          });
        });
        resourceWatchers.push(watcher);
        logger.info("extensions.watch.started", { path: watchPath });
      } catch (error) {
        logger.warn("extensions.watch.start-failed", {
          error: error instanceof Error ? error.message : String(error),
          path: watchPath,
        });
      }
    }
  };

  const scheduleModelConfigReload = () => {
    if (modelConfigDebounce) clearTimeout(modelConfigDebounce);
    modelConfigDebounce = setTimeout(() => {
      modelConfigDebounce = null;
      void modelRuntime
        .reloadConfig()
        .then(() => {
          const configError = modelRuntime.getSnapshot().configError;
          if (configError) {
            logger.warn("model-runtime.config.invalid", { error: configError });
          } else {
            logger.info("model-runtime.config.reloaded");
          }
        })
        .catch((error) => {
          logger.warn("model-runtime.config.reload-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, FILE_WATCH_DEBOUNCE_MS);
  };

  const startModelConfigWatcher = () => {
    if (modelConfigWatcher) return;
    try {
      modelConfigWatcher = fsWatch(
        context.stellaDataDir,
        { recursive: false },
        (_eventType, filename) => {
          if (filename && path.basename(String(filename)) === "models.json") {
            scheduleModelConfigReload();
          }
        },
      );
      modelConfigWatcher.on("error", (error) => {
        logger.warn("model-runtime.config.watch.error", {
          error: error instanceof Error ? error.message : String(error),
          path: context.stellaDataDir,
        });
      });
      logger.info("model-runtime.config.watch.started", {
        path: path.join(context.stellaDataDir, "models.json"),
      });
    } catch (error) {
      logger.warn("model-runtime.config.watch.start-failed", {
        error: error instanceof Error ? error.message : String(error),
        path: context.stellaDataDir,
      });
    }
  };

  const stopExtensionWatcher = () => {
    extensionReloadScheduler.cancel();
    if (modelConfigDebounce) {
      clearTimeout(modelConfigDebounce);
      modelConfigDebounce = null;
    }
    try {
      modelConfigWatcher?.close();
    } catch {

    }
    modelConfigWatcher = null;
    for (const watcher of resourceWatchers) {
      try {
        watcher.close();
      } catch {

      }
    }
    resourceWatchers = [];
  };

  const start = () => {
    if (context.state.isRunning) return;
    context.state.isRunning = true;
    context.state.isInitialized = false;
    void initializeRuntime().finally(() => {

      startExtensionWatcher();
      startModelConfigWatcher();
    });
  };

  const COMPACTION_DRAIN_TIMEOUT_MS = 5_000;

  const drainCompactionsWithTimeout = async (): Promise<void> => {
    const drain = context.state.compactionScheduler.drain();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), COMPACTION_DRAIN_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        drain.then(() => "drained" as const),
        timeout,
      ]);
      if (result === "timeout") {
        logger.warn("compaction-scheduler.drain-timeout", {
          timeoutMs: COMPACTION_DRAIN_TIMEOUT_MS,
        });
      }
    } catch (error) {
      logger.warn("compaction-scheduler.drain-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const stop = async (): Promise<void> => {
    logger.warn("runner.stop", {
      activeOrchestratorRunId: context.state.activeOrchestratorRunId,
      activeAbortControllers: context.state.activeRunAbortControllers.size,
      conversationCallbacks: context.state.conversationCallbacks.size,
      runCallbacksByRunId: context.state.runCallbacksByRunId.size,
    });
    stopExtensionWatcher();
    context.state.isRunning = false;
    context.state.isInitialized = false;
    context.state.initializationPromise = null;
    deps.disposeConvexClient();
    deps.shutdownTasks();
    context.state.activeOrchestratorRunId = null;
    context.state.activeOrchestratorConversationId = null;
    context.state.activeOrchestratorUiVisibility = "visible";
    context.state.activeOrchestratorSession = null;

    for (const session of context.state.orchestratorSessions.values()) {
      try {
        session.dispose();
      } catch (error) {
        logger.warn("orchestrator-session.dispose-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    context.state.orchestratorSessions.clear();
    context.state.queuedOrchestratorTurns.length = 0;
    for (const controller of context.state.activeRunAbortControllers.values()) {
      controller.abort();
    }
    context.state.activeRunAbortControllers.clear();
    context.state.conversationCallbacks.clear();
    context.state.runCallbacksByRunId.clear();
    await context.toolHost.shutdown();

    await drainCompactionsWithTimeout();
  };

  return {
    initializeRuntime,
    reloadUserExtensions,
    start,
    stop,
  };
};
