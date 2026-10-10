import { app } from "electron";
import { hasMacPermission } from "../utils/macos-permissions.js";
import path from "path";
import { resolveStellaDataDir } from "@stella/runtime/kernel/home/stella-home";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { CompanionWindowController } from "../windows/companion-window.js";
import { broadcastCompanionVisibility } from "../ipc/companion-handlers.js";
import { WindowManager } from "../windows/window-manager.js";
import { TrayController } from "../windows/tray-controller.js";
import { configureNotificationActivationHandling } from "../services/notification-service.js";
import { configureStellaSessionPermissions } from "./session-permissions.js";
import { resolveRendererBuildMode, serveRendererSource, } from "../source/renderer-protocol.js";
import { getAllWindows, } from "./context.js";
import { startDeferredStartup } from "./deferred-startup.js";
import { getMainLogger } from "../observability/main-logger.js";
const initializeBootstrapLocalState = async (context) => {
    const { config, lifecycle, services, state } = context;
    const stellaDataDir = await resolveStellaDataDir(app, config.stellaAppDir, config.stellaDataDirPath);
    lifecycle.setStellaAppDir(stellaDataDir.stellaAppDir);
    lifecycle.setStellaDataDir(stellaDataDir.statePath);
    state.stellaAppDir = stellaDataDir.stellaAppDir;
    state.stellaDataDirPath = stellaDataDir.statePath;
    state.stellaWorkspacePath = stellaDataDir.workspacePath;
    services.securityPolicyService.setSecurityPolicyPath(path.join(stellaDataDir.statePath, "security_policy.json"));
};
const initializeWindowShell = (context) => {
    const { config, lifecycle, services, state } = context;
    const preloadPath = path.join(config.electronDir, "preload.js");
    configureStellaSessionPermissions({
        appPartition: config.sessionPartition,
    });
    // Every install runs the renderer from its source tree (see source/), so
    // this is unconditional; only the build mode depends on who we are. The
    // handle swaps updated files into the windows (`applyChanges`).
    state.rendererSource = serveRendererSource({
        partition: config.sessionPartition,
        sourceRoot: config.stellaAppDir,
        mode: resolveRendererBuildMode({
            isInstalledProduct: config.isInstalledProduct,
        }),
        log: (message) => getMainLogger()?.process("renderer.source", { message }),
    });
    configureNotificationActivationHandling(context);
    state.overlayController = new OverlayWindowController({
        preloadPath,
        sessionPartition: config.sessionPartition,
        electronDir: config.electronDir,
        isQuitting: () => state.isQuitting,
    });
    lifecycle.setWindowManager(new WindowManager({
        electronDir: config.electronDir,
        preloadPath,
        sessionPartition: config.sessionPartition,
        externalLinkService: services.externalLinkService,
        isQuitting: () => state.isQuitting,
        onMinimizeFullToTray: () => state.trayController?.notifyMinimizedToTray(),
    }));
    state.companionController = new CompanionWindowController({
        preloadPath,
        sessionPartition: config.sessionPartition,
        electronDir: config.electronDir,
        isQuitting: () => state.isQuitting,
        getStellaDataDir: () => state.stellaDataDirPath,
        onOpenMain: () => state.windowManager?.showWindow(),
        hasMainWindow: () => {
            const full = state.windowManager?.getFullWindow();
            return Boolean(full && !full.isDestroyed());
        },
        onQuit: () => {
            state.isQuitting = true;
            app.quit();
        },
        onVisibleChanged: (visible) => broadcastCompanionVisibility(visible),
    });
    // Windows keeps Stella alive in the system tray after the user closes the
    // main window. macOS already keeps the app running via the dock, so the
    // tray is Windows-only.
    if (process.platform === "win32") {
        const trayController = new TrayController({
            electronDir: config.electronDir,
            onShowWindow: () => state.windowManager?.showWindow(),
            onQuit: () => {
                state.isQuitting = true;
                app.quit();
            },
        });
        trayController.create();
        state.trayController = trayController;
    }
    services.uiStateService.bind({
        broadcastTarget: {
            getAllWindows: () => getAllWindows(context),
        },
    });
};
const finalizeWindowLaunch = (context) => {
    const { config, services, state } = context;
    // No-op when createBootstrapInitialWindows already ran.
    state.windowManager.createInitialWindows();
    const fullWindow = state.windowManager.getFullWindow();
    let deferredStartupTriggered = false;
    const triggerDeferredStartup = (trigger) => {
        if (deferredStartupTriggered) {
            return;
        }
        deferredStartupTriggered = true;
        getMainLogger()?.process("startup.deferred-startup.trigger", {
            trigger,
            elapsedMs: Math.round(process.uptime() * 1000),
        });
        void startDeferredStartup(context);
    };
    if (fullWindow) {
        fullWindow.webContents.once("did-finish-load", () => {
            getMainLogger()?.process("startup.first-paint", {
                elapsedMs: Math.round(process.uptime() * 1000),
            });
            triggerDeferredStartup("first-paint");
        });
    }
    // After an update that restarted Stella, the window opens on the frosted
    // frame the last process left (bounded, so a stuck hold never hides it).
    const transition = state.updateTransition;
    if (fullWindow && transition?.hasPendingHold()) {
        void Promise.race([
            transition.resumeAfterRelaunch(fullWindow),
            new Promise((resolve) => setTimeout(resolve, 800)),
        ]).finally(() => state.windowManager.showWindow());
    }
    else {
        state.windowManager.showWindow();
    }
    context.state.processRuntime.setManagedTimeout(() => {
        triggerDeferredStartup("fallback");
    }, config.startupFirstPaintFallbackMs);
    // If Accessibility was off at startup, deferred startup skips the hook; when
    // the user enables it in System Settings and returns to Stella, retry start.
    if (process.platform === "darwin") {
        app.on("browser-window-focus", () => {
            if (!hasMacPermission("accessibility", false)) {
                return;
            }
            services.globalInputHook.start();
        });
    }
};
/**
 * Create the full window (and start its renderer load) ahead of the rest of
 * bootstrap. Callers must register IPC handlers in the same synchronous task:
 * renderer IPC is only dispatched once main yields, so every handler is in
 * place before the renderer can invoke one, while the renderer process
 * launch and page load overlap with that registration work.
 */
export const createBootstrapInitialWindows = (context) => {
    context.state.windowManager.createInitialWindows();
    getMainLogger()?.process("startup.window-created", {
        elapsedMs: Math.round(process.uptime() * 1000),
    });
};
export const initializeBootstrapAppShell = async (context) => {
    await prepareBootstrapAppShell(context);
    launchBootstrapAppShell(context);
};
export const prepareBootstrapAppShell = async (context) => {
    await initializeBootstrapLocalState(context);
    initializeWindowShell(context);
};
export const launchBootstrapAppShell = (context) => {
    finalizeWindowLaunch(context);
};
