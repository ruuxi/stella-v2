import { app, autoUpdater, dialog, globalShortcut } from "electron";
import { writeFileSync } from "node:fs";
import { applyDockIcon } from "../app-icon.js";
import { configurePackagedRuntimeEnvironment } from "../bundled-runtime-environment.js";
import { t } from "../services/i18n-service.js";
import { shutdownBootstrapRuntime } from "./resets.js";
import { initializeBootstrapApplication } from "./runtime.js";
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
            await context.state.processRuntime.runPhase("before-quit");
            await context.state.processRuntime.runPhase("will-quit");
            quitAfterCleanup = true;
            app.exit(0);
        })();
    });
};
