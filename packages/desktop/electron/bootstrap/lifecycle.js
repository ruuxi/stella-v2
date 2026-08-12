import { app, autoUpdater, dialog, globalShortcut } from "electron";
import { writeFileSync } from "node:fs";
import { applyDockIcon } from "../app-icon.js";
import { configurePackagedRuntimeEnvironment } from "../bundled-runtime-environment.js";
import { getMainLogger } from "../observability/main-logger.js";
import { t } from "../services/i18n-service.js";
import { shutdownBootstrapRuntime } from "./resets.js";
import { initializeBootstrapApplication } from "./runtime.js";
// Shutdown cleanup is best-effort, never a hostage. Squirrel's installer waits
// for this process to exit before it swaps the bundle in, so a cleanup that
// stalls reads to the user as "the update never restarted" — the app is gone
// from screen but still alive. Each phase gets a budget; whatever hasn't
// finished when it runs out is abandoned and the process exits anyway.
const QUIT_PHASE_DEADLINE_MS = {
    "before-quit": 4_000,
    "will-quit": 2_000,
};
const SLOW_QUIT_PHASE_MS = 1_500;
const SLOW_CLEANUP_MS = 750;
const runQuitPhase = async (context, phase) => {
    const startedAt = Date.now();
    const phaseRun = context.state.processRuntime
        .runPhase(phase, {
        onCleanupTiming: ({ key, elapsedMs }) => {
            if (elapsedMs >= SLOW_CLEANUP_MS) {
                getMainLogger()?.process("main.quit-cleanup-slow", {
                    phase,
                    key,
                    elapsedMs,
                });
            }
        },
    })
        .then(() => false)
        .catch((error) => {
        console.error(`Shutdown cleanup failed for ${phase}:`, error);
        return false;
    });
    const deadlineMs = QUIT_PHASE_DEADLINE_MS[phase];
    const timedOut = await Promise.race([
        phaseRun,
        new Promise((resolve) => {
            const timer = setTimeout(() => resolve(true), deadlineMs);
            timer.unref?.();
        }),
    ]);
    const elapsedMs = Date.now() - startedAt;
    if (timedOut) {
        getMainLogger()?.warn("main.quit-phase-timeout", {
            phase,
            elapsedMs,
            deadlineMs,
        });
    }
    else if (elapsedMs >= SLOW_QUIT_PHASE_MS) {
        getMainLogger()?.process("main.quit-phase-slow", { phase, elapsedMs });
    }
};
export const initializeBootstrapSingleInstance = (context) => {
    context.services.authService.bindSingleInstanceHandler();
    context.services.authService.bindOpenUrlHandler();
};
export const registerBootstrapLifecycle = (context) => {
    let quitAfterCleanup = false;
    const handleFatalStartupFailure = async (error) => {
        const detail = error instanceof Error
            ? `${error.name}: ${error.message}\n\n${error.stack ?? ""}`
            : String(error);
        console.error("Fatal startup failure:", error);
        try {
            const result = await dialog.showMessageBox({
                type: "error",
                buttons: [
                    t("desktop.dialog.startupFailure.relaunch"),
                    t("desktop.dialog.startupFailure.quit"),
                ],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
                title: t("desktop.dialog.startupFailure.title"),
                message: t("desktop.dialog.startupFailure.message"),
                detail: t("desktop.dialog.startupFailure.detail", { detail }).slice(0, 12_000),
            });
            if (result.response === 0) {
                app.relaunch();
                app.quit();
                return;
            }
            app.quit();
        }
        catch (dialogError) {
            console.error("Failed to show startup failure dialog:", dialogError);
            app.quit();
        }
    };
    context.state.processRuntime.registerCleanup("will-quit", "global-shortcuts", () => {
        globalShortcut.unregisterAll();
    });
    context.state.processRuntime.registerCleanup("will-quit", "local-chat-history-service", () => {
        context.services.localChatHistoryService.close();
    });
    context.state.processRuntime.registerCleanup("will-quit", "bootstrap-runtime", async () => {
        await shutdownBootstrapRuntime(context, { stopScheduler: true });
    });
    app.on("activate", () => {
        // Quitting closes every window well before the process exits. Without
        // this guard a dock click during that window rebuilds the whole UI on a
        // runtime that is already torn down — which is how an update restart
        // ends up showing the outgoing build, "Restart to update" and all.
        if (context.state.isQuitting) {
            return;
        }
        context.state.windowManager?.onActivate();
    });
    // Electron's update restart closes every BrowserWindow before emitting the
    // normal app `before-quit` event. Mark the process as quitting at the
    // updater-specific boundary so auxiliary windows do not cancel that close
    // sequence and strand the downloaded update in a hidden, still-live app.
    autoUpdater.on("before-quit-for-update", () => {
        context.state.isQuitting = true;
    });
    app
        .whenReady()
        .then(async () => {
        if (app.isPackaged) {
            process.env.STELLA_APP_RESOURCES_PATH = process.resourcesPath;
            configurePackagedRuntimeEnvironment({
                resourcesPath: process.resourcesPath,
            });
        }
        if (process.platform === "darwin") {
            app.dock?.show();
        }
        applyDockIcon(context.config.electronDir);
        await initializeBootstrapApplication(context);
        applyDockIcon(context.config.electronDir);
    })
        .catch((error) => {
        void handleFatalStartupFailure(error);
    });
    app.on("window-all-closed", () => {
        app.quit();
    });
    app.on("before-quit", (event) => {
        if (quitAfterCleanup) {
            return;
        }
        const devUserQuitRequestFile = process.env.STELLA_DEV_USER_QUIT_REQUEST_FILE;
        if (devUserQuitRequestFile) {
            try {
                writeFileSync(devUserQuitRequestFile, `${process.pid}\n`, "utf8");
            }
            catch {
                // Best-effort dev-supervisor signal; quitting must never depend on it.
            }
        }
        event.preventDefault();
        context.state.isQuitting = true;
        void (async () => {
            const startedAt = Date.now();
            await runQuitPhase(context, "before-quit");
            await runQuitPhase(context, "will-quit");
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs >= SLOW_QUIT_PHASE_MS) {
                getMainLogger()?.process("main.quit-cleanup-elapsed", { elapsedMs });
            }
            quitAfterCleanup = true;
            app.exit(0);
        })();
    });
};
