import { getMainLogger } from "../observability/main-logger.js";
import { getTotalSystemMemoryMb, isLowMemoryWindowsDevice, } from "../resource-profile.js";
const OVERLAY_STARTUP_WARM_DELAY_MS = 5_000;
const runDeferredStartupTask = async (context, task) => {
    if (task.delayMs) {
        const completed = await context.state.processRuntime.wait(task.delayMs);
        if (!completed) {
            return false;
        }
    }
    if (context.state.isQuitting ||
        context.state.processRuntime.isShuttingDown()) {
        return false;
    }
    await task.run();
    return true;
};
const scheduleOverlayWarmup = (context) => {
    const { state } = context;
    // The overlay self-creates on demand via `ensureReady()`, so skipping the
    // warm on a low-memory Windows device only trades first-summon latency for
    // not carrying a second renderer the session may never use.
    if (isLowMemoryWindowsDevice()) {
        getMainLogger()?.process("startup.overlay-warmup.skipped-low-memory-windows", {
            totalMemoryMb: getTotalSystemMemoryMb(),
        });
        return;
    }
    state.processRuntime.setManagedTimeout(() => {
        void (async () => {
            if (state.isQuitting || state.processRuntime.isShuttingDown()) {
                return;
            }
            const warmed = await state.overlayController?.warmForStartup();
            getMainLogger()?.process("startup.overlay-warmup", {
                warmed: warmed === true,
                elapsedMs: Math.round(process.uptime() * 1000),
            });
        })().catch((error) => {
            console.debug("[startup] Overlay warmup failed:", error instanceof Error ? error.message : String(error));
        });
    }, OVERLAY_STARTUP_WARM_DELAY_MS);
};
const createDeferredStartupTasks = (context) => {
    const { config, state } = context;
    // Perf: the overlay's cold second-renderer is no longer eagerly built here.
    // Every overlay show entrypoint (voice/region-capture/screen-guide/
    // morph/window-highlight) self-creates the window via
    // `OverlayWindowController.ensureReady()`. Startup schedules a delayed warm
    // so first use is usually ready without competing with first paint.
    return [
        {
            // Spin up the runtime worker (and warm the model catalog) only after
            // the renderer has painted, so the spawn + catalog fetch don't contend
            // with first paint. `startHostRunner` is idempotent and the worker is
            // spawned on demand if a chat beats this, so deferring is safe.
            label: "host-runner",
            run: () => {
                getMainLogger()?.process("startup.host-runner.kickoff", {
                    elapsedMs: Math.round(process.uptime() * 1000),
                });
                state.startHostRunner?.();
            },
        },
        {
            label: "overlay-warmup-schedule",
            run: () => {
                scheduleOverlayWarmup(context);
            },
        },
    ];
};
export const startDeferredStartup = (context) => {
    const { state } = context;
    if (state.deferredStartupSequence) {
        return state.deferredStartupSequence;
    }
    state.deferredStartupSequence = (async () => {
        for (const task of createDeferredStartupTasks(context)) {
            const completed = await runDeferredStartupTask(context, task);
            if (!completed) {
                return;
            }
        }
    })().catch((error) => {
        console.error("[startup] Deferred startup failed:", error.message);
    });
    return state.deferredStartupSequence;
};
