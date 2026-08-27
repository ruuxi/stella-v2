import { getMainLogger } from "../observability/main-logger.js";
import { getTotalSystemMemoryMb, isLowMemoryWindowsDevice, } from "../resource-profile.js";
const DREAM_READY_RETRY_MS = 5_000;
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
const triggerDreamWhenAgentReady = (context, trigger) => {
    const runner = context.lifecycle.getRunner();
    if (!runner) {
        return;
    }
    void (async () => {
        const health = await runner.agentHealthCheck();
        if (!health?.ready) {
            context.state.processRuntime.setManagedTimeout(() => {
                triggerDreamWhenAgentReady(context, trigger);
            }, DREAM_READY_RETRY_MS);
            return;
        }
        await runner.triggerDreamNow(trigger);
    })().catch((error) => {
        console.debug("[dream] trigger failed:", error instanceof Error ? error.message : String(error));
    });
};
const scheduleOverlayWarmup = (context) => {
    const { state } = context;

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

    return [
        {

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
        {

            label: "dream-startup-sweep",
            delayMs: config.startupStageDelayMs,
            run: () => {
                triggerDreamWhenAgentReady(context, "startup_catchup");
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
