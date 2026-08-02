import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect";
import {
  loadBundledAgents,
  mergeBundledAndExtensionAgents,
} from "../agents/agents.js";
import { loadExtensions } from "../extensions/loader.js";
import type { ExtensionServices } from "../extensions/services.js";
import { createExtensionRuntimeApi } from "../extensions/runtime-api.js";
import { modelRuntime } from "../../ai/model-runtime.js";
import { createRuntimeLogger } from "../debug.js";
import type { RunnerContext } from "./types.js";
import { joinWithTimeout } from "../shared/supervised-scope.js";
import { shutdownDreamRuns } from "../agent-runtime/dream-scheduler.js";

const logger = createRuntimeLogger("runtime-init");

/**
 * Requirements-free runtime + scope for this module's timer fibers (watch
 * debounces, busy-retry, the compaction drain bound). House convention:
 * one module-level ManagedRuntime, work carries its context via closures.
 * The fibers are short-lived sleeps; `stopExtensionWatcher` interrupts any
 * pending one, so nothing outlives `stop()`.
 */
const initRuntime = ManagedRuntime.make(Layer.empty);
const initTimersScope = Scope.makeUnsafe();

/**
 * Fork `fn` to run after `ms` on the shared timer scope. The returned
 * fiber's `interruptUnsafe` is the Effect replacement for `clearTimeout`.
 */
const forkAfter = (ms: number, fn: () => void): Fiber.Fiber<void> =>
  initRuntime.runSync(
    Effect.forkIn(
      Effect.andThen(Effect.sleep(ms), Effect.sync(fn)),
      initTimersScope,
      { startImmediately: true },
    ),
  );

export const createRuntimeInitialization = (
  context: RunnerContext,
  deps: {
    disposeConvexClient: () => void;
    shutdownTasks: () => void | Promise<void>;
  },
) => {
  /**
   * Keep extension registry swaps synchronous so the orchestrator queue never
   * observes a partially installed extension set.
   */
  const installLoadedExtensions = (
    extensions: Awaited<ReturnType<typeof loadExtensions>>,
  ): void => {
    context.state.loadedAgents = mergeBundledAndExtensionAgents(
      extensions.agents,
    );
    for (const hook of extensions.hooks) {
      // Force `source: "extension"` even if the disk-loaded hook
      // declared something else. Bundled hooks register through
      // `registerBundledHooks` (a separate code path that runs at
      // worker startup), so anything coming out of `loadExtensions`
      // is by definition user-installable. Without this clamp, a
      // hook that exported `{ source: "bundled", ... }` would survive
      // every subsequent `clearBySource("extension")` sweep and
      // accumulate duplicate registrations on each F1 reload.
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

  /**
   * Build the runtime services object once. Forwarded to every extension
   * factory invocation (initial load + every F1 reload) so factories can
   * close over the services they need at registration time.
   */
  const extensionRuntimeApi = createExtensionRuntimeApi({
    stellaDataDir: context.stellaDataDir,
    stellaAppDir: context.stellaAppDir,
    store: context.runtimeStore,
  });
  const buildExtensionServices = (): ExtensionServices => ({
    stellaDataDir: context.stellaDataDir,
    stellaAppDir: context.stellaAppDir,
    store: context.runtimeStore,
    runtime: extensionRuntimeApi,
  });

  /**
   * Load extensions from disk and register hooks/tools/providers/agents.
   * Used by initial startup. The F1 reload path uses
   * `loadExtensions` + `installLoadedExtensions` directly so it can
   * sandwich the sweep+install inside one synchronous block.
   */
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
    // Stella's lifecycle hooks (memory, scheduling, and others) live in the
    // home-loaded stella-runtime extension and register through the same path
    // as any other user extension. The engine has no bundled extension tier.
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
    // Wake boot-window waiters parked on the readiness latch.
    context.state.initializationStarted.open();

    return context.state.initializationPromise;
  };

  /**
   * F1: idle gate for the hot-reload path. A reload is safe when no
   * orchestrator session is streaming and no subagent task is running.
   * Returns the first reason the runtime is busy so callers can log /
   * retry intelligently.
   */
  const computeBusyReason = (): string | null => {
    if (context.state.activeOrchestratorRunId) {
      return `orchestrator run ${context.state.activeOrchestratorRunId} is active`;
    }
    // Long-lived `OrchestratorSession`s are intentionally NOT a busy
    // signal: the underlying Pi Agent is idle between turns, and
    // hot-reloaded extensions don't need it torn down — the next
    // `runTurn` picks up the new tool catalog / hooks naturally. The
    // only orchestrator-side busy condition is an active run, gated
    // above by `activeOrchestratorRunId`.
    const activeAgents =
      context.state.localAgentManager?.getActiveAgentCount() ?? 0;
    if (activeAgents > 0) {
      return `${activeAgents} subagent task${
        activeAgents === 1 ? "" : "s"
      } running`;
    }
    return null;
  };

  /**
   * F1 entry point. Idle-checks, sweeps user-extension hooks/tools, and
   * re-runs the loader. Bundled hooks and built-in tools are untouched.
   * Returns one of:
   *   - "reloaded"        success
   *   - "busy"            runtime is mid-run; caller may retry on idle
   *   - "not-initialized" runtime hasn't finished startup yet
   *   - "load-failed"     disk read failed; old extensions stay live and
   *                       `reason` carries the underlying error message
   *                       so callers (UI, IPC) can surface it instead of
   *                       silently treating it as a successful reload.
   */
  const reloadUserExtensions = async (): Promise<{
    status: "reloaded" | "busy" | "not-initialized" | "load-failed";
    reason?: string;
  }> => {
    if (!context.state.isInitialized) {
      return { status: "not-initialized" };
    }
    const busyReason = computeBusyReason();
    if (busyReason) {
      logger.info("extensions.reload.deferred", { reason: busyReason });
      return { status: "busy", reason: busyReason };
    }
    logger.info("extensions.reload.start");
    // Load-then-swap to keep the reload atomic w.r.t. the orchestrator
    // queue. If we swept first and awaited the disk load between sweep
    // and install, a user message landing during the await would
    // dequeue against an empty extension registry: missing tools,
    // missing extension-provided model providers, mid-flight provider
    // resolution failing over to fallbacks. Doing the disk read FIRST
    // (the only async step) means the OLD registry stays intact during
    // I/O; only the synchronous sweep+install block below mutates live
    // state, and the orchestrator queue can't slip a turn into the
    // middle of a synchronous block.
    let extensions: Awaited<ReturnType<typeof loadExtensions>>;
    try {
      extensions = await loadExtensions(
        context.paths.extensionsPath,
        buildExtensionServices(),
      );
    } catch (error) {
      // Disk-read failure: leave the old extension state in place. The
      // initial-load behavior of falling back to bundled agents only
      // applies to startup; a partial reload that wipes the running
      // registry would be worse than no reload. Surface the failure
      // distinctly from "reloaded" so the watcher's busy-retry loop
      // doesn't masquerade a persistent disk problem as success and so
      // any future UI-driven reload affordance can show the error.
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("extensions.reload.load-failed", { error: reason });
      return { status: "load-failed", reason };
    }
    // Synchronous swap: clear old + install new in one block. No
    // awaits between these statements.
    context.hookEmitter.clearBySource("extension");
    context.toolHost.unregisterExtensionTools();
    installLoadedExtensions(extensions);
    await modelRuntime.reloadConfig();
    logger.info("extensions.reload.done");
    return { status: "reloaded" };
  };

  /**
   * F1 file watcher. Debounces filesystem events on the extensions
   * directory and calls `reloadUserExtensions`. If the runtime is busy
   * when a change lands, the watcher schedules a retry on a short timer
   * so the reload eventually applies after the in-flight run completes.
   */
  let resourceWatchers: FSWatcher[] = [];
  let modelConfigWatcher: FSWatcher | null = null;
  let extensionDebounce: Fiber.Fiber<void> | null = null;
  let extensionRetry: Fiber.Fiber<void> | null = null;
  let modelConfigDebounce: Fiber.Fiber<void> | null = null;
  const FILE_WATCH_DEBOUNCE_MS = 500;
  const RELOAD_BUSY_RETRY_MS = 2_000;

  const scheduleExtensionReload = () => {
    extensionDebounce?.interruptUnsafe();
    extensionDebounce = forkAfter(FILE_WATCH_DEBOUNCE_MS, () => {
      extensionDebounce = null;
      void (async () => {
        const result = await reloadUserExtensions();
        if (result.status === "busy") {
          extensionRetry?.interruptUnsafe();
          extensionRetry = forkAfter(RELOAD_BUSY_RETRY_MS, () => {
            extensionRetry = null;
            scheduleExtensionReload();
          });
        }
      })();
    });
  };

  const startExtensionWatcher = () => {
    if (resourceWatchers.length > 0) return;
    // Watch both the extension code tree and the user-editable agent prompts
    // under `~/.stella/agents/`. A change in either triggers the same reload,
    // which re-registers agents with fresh prompt body AND frontmatter
    // (tools / model / maxAgentDepth) — so prompt edits apply without a
    // restart, mirroring pi's watch→reload model.
    const watchPaths = [
      context.paths.extensionsPath,
      path.join(context.stellaDataDir, "agents"),
    ];
    for (const watchPath of watchPaths) {
      try {
        const watcher = fsWatch(
          watchPath,
          { recursive: true },
          (_eventType, filename) => {
            // Ignore renames into the directory of dotfiles / build
            // artifacts. The loader filters by suffix anyway, but
            // skipping early reduces wakeups.
            if (
              filename &&
              (filename.startsWith(".") || filename.endsWith("~"))
            ) {
              return;
            }
            scheduleExtensionReload();
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
    modelConfigDebounce?.interruptUnsafe();
    modelConfigDebounce = forkAfter(FILE_WATCH_DEBOUNCE_MS, () => {
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
    });
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
    extensionDebounce?.interruptUnsafe();
    extensionDebounce = null;
    extensionRetry?.interruptUnsafe();
    extensionRetry = null;
    modelConfigDebounce?.interruptUnsafe();
    modelConfigDebounce = null;
    try {
      modelConfigWatcher?.close();
    } catch {
      // Best-effort.
    }
    modelConfigWatcher = null;
    for (const watcher of resourceWatchers) {
      try {
        watcher.close();
      } catch {
        // Best-effort.
      }
    }
    resourceWatchers = [];
  };

  const start = () => {
    if (context.state.isRunning) return;
    context.state.isRunning = true;
    context.state.isInitialized = false;
    void initializeRuntime().finally(() => {
      // Start the extensions watcher only after initial load completes,
      // so we don't race with the first registration.
      startExtensionWatcher();
      startModelConfigWatcher();
    });
  };

  /**
   * Hard cap on how long shutdown will wait for background compactions
   * to settle. Cracked summarization LLM calls or network stalls would
   * otherwise pin the worker indefinitely; after this deadline we
   * proceed with SQLite teardown and any unfinished compaction's write
   * will fail-and-log against the closed handle (the run was already
   * "fire-and-forget" from the user's POV — it had nothing to lose).
   */
  const COMPACTION_DRAIN_TIMEOUT_MS = 5_000;

  const drainCompactionsWithTimeout = async (): Promise<void> => {
    try {
      // Effect-bounded drain: the losing sleep arm is fiber-interrupted
      // (the old `clearTimeout`), and a timeout leaves the abandoned drain
      // promise to the scheduler's own shutdown join below.
      const result = await initRuntime.runPromise(
        Effect.raceFirst(
          Effect.map(
            Effect.promise(() => context.state.compactionScheduler.drain()),
            () => "drained" as const,
          ),
          Effect.map(
            Effect.sleep(COMPACTION_DRAIN_TIMEOUT_MS),
            () => "timeout" as const,
          ),
        ),
      );
      if (result === "timeout") {
        logger.warn("compaction-scheduler.drain-timeout", {
          timeoutMs: COMPACTION_DRAIN_TIMEOUT_MS,
        });
      }
    } catch (error) {
      logger.warn("compaction-scheduler.drain-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Hard cap on joining the supervised run-fiber tree after interruption
   * has been delivered. Interruption aborts every unit cooperatively; this
   * only bounds a wedged native promise (which no JavaScript runtime can
   * force-kill) so worker exit cannot pin indefinitely. The external
   * resources such a promise might hold are still reaped: the tool host
   * shutdown below kills tool/shell child processes unconditionally.
   */
  const SUPERVISOR_JOIN_TIMEOUT_MS = 15_000;

  const stop = async (): Promise<void> => {
    logger.warn("runner.stop", {
      activeOrchestratorRunId: context.state.activeOrchestratorRunId,
      activeSupervisedRuns: context.state.supervisor.activeRunCount(),
      conversationCallbacks: context.state.conversationCallbacks.size,
      runCallbacksByRunId: context.state.runCallbacksByRunId.size,
    });
    stopExtensionWatcher();
    context.state.isRunning = false;
    context.state.isInitialized = false;
    context.state.initializationPromise = null;
    // Re-arm the boot latch so a restarted runner's waiters park again
    // instead of observing the previous generation as already open.
    context.state.initializationStarted.reset();
    deps.disposeConvexClient();
    // The cloud journal writer holds a retry timer and an in-memory queue.
    // Stopping it before the Convex client is gone would be pointless (it
    // needs a token to flush) and leaving it running keeps a timer alive past
    // shutdown, so it is dropped here alongside the client it depends on.
    context.cloudTranscript.stop();
    // Cancel every live orchestrator turn cooperatively first (the
    // supervisor fires each run's registered abort), then cancel agent
    // tasks (awaited: lifecycle events + managed-child cascades), then
    // interrupt the whole supervised fiber tree — root turn fibers and
    // subagent attempt fibers — and join their teardown before any shared
    // resource (tool host, store) is torn down beneath them.
    context.state.supervisor.abortAllRuns();
    const tasksShutdown = Promise.resolve(deps.shutdownTasks()).catch(
      (error) => {
        logger.warn("runner.stop.task-shutdown-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    // Kill tool-owned child processes (shells, CLIs) now: every turn is
    // already aborted, and reaping accelerates their unwind so the join
    // below is short.
    await context.toolHost.shutdown();
    await tasksShutdown;
    await joinWithTimeout(
      context.state.supervisor.shutdown(),
      SUPERVISOR_JOIN_TIMEOUT_MS,
      () => {
        logger.warn("runner.stop.supervisor-join-timeout", {
          timeoutMs: SUPERVISOR_JOIN_TIMEOUT_MS,
          liveFibers: context.state.supervisor.liveFiberCount(),
        });
      },
    );
    // Interrupt the run coordinator's drain fiber and join any in-flight
    // queued-turn admission before the lane state is torn down beneath it.
    // The runner is not restarted on this instance, so coordinator shutdown
    // is terminal (a fresh runner builds a fresh coordinator).
    await joinWithTimeout(
      context.state.runCoordinator?.shutdown() ?? Promise.resolve(),
      SUPERVISOR_JOIN_TIMEOUT_MS,
      () => {
        logger.warn("runner.stop.run-coordinator-join-timeout", {
          timeoutMs: SUPERVISOR_JOIN_TIMEOUT_MS,
        });
      },
    );
    context.state.activeOrchestratorRunId = null;
    context.state.activeOrchestratorConversationId = null;
    context.state.activeOrchestratorUiVisibility = "visible";
    context.state.activeOrchestratorSession = null;
    // Tear down all long-lived per-conversation orchestrator sessions
    // (E1). Each session disposes its underlying Pi `Agent` so message
    // arrays + closures get reclaimed; future startups rebuild them lazily
    // when the next turn lands.
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
    context.state.conversationCallbacks.clear();
    context.state.runCallbacksByRunId.clear();
    // Give in-flight background compactions their historical 5s grace to
    // finish SQLite writes, then interrupt whatever remains and join it —
    // an interrupted compaction aborts its LLM call and skips its store
    // write, so nothing races the store handle teardown. The scheduler and
    // Dream joins run in parallel (independent subsystems) and are BOUNDED:
    // a wedged LLM promise that ignores its abort must not hang worker
    // stop; past the bound its store writes are already fenced off by the
    // abort signal.
    await drainCompactionsWithTimeout();
    await Promise.all([
      joinWithTimeout(context.state.compactionScheduler.shutdown(), 10_000, () =>
        logger.warn("runner.stop.compaction-shutdown-timeout", {}),
      ),
      // Interrupt and join any in-flight Dream run: its lock directory and
      // in-flight flag are released before the worker exits.
      joinWithTimeout(shutdownDreamRuns(context.stellaDataDir), 10_000, () =>
        logger.warn("runner.stop.dream-shutdown-timeout", {}),
      ),
    ]);
  };

  return {
    initializeRuntime,
    reloadUserExtensions,
    start,
    stop,
  };
};
