import { app } from "electron";
import { hasMacPermission } from "../utils/macos-permissions.js";
import path from "path";
import { resolveStellaDataDir } from "@stella/runtime/kernel/home/stella-home";
import { getDevServerUrl } from "../renderer-location.js";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { PetWindowController } from "../windows/pet-window.js";
import { WindowManager } from "../windows/window-manager.js";
import { TrayController } from "../windows/tray-controller.js";
import { configureNotificationActivationHandling } from "../services/notification-service.js";
import { configureStellaSessionPermissions } from "./session-permissions.js";
import { getAllWindows, getMobileBroadcast, } from "./context.js";
import { startDeferredStartup } from "./deferred-startup.js";
import { getMainLogger } from "../observability/main-logger.js";
const DEFAULT_STELLA_WEB_URL = "https://stella.sh";
const readStellaWebBaseUrl = () => {
    const raw = (process.env.STELLA_WEB_URL ??
        process.env.VITE_STELLA_WEB_URL ??
        process.env.STELLA_STORE_WEB_URL ??
        process.env.VITE_STELLA_STORE_WEB_URL ??
        DEFAULT_STELLA_WEB_URL).trim() || DEFAULT_STELLA_WEB_URL;
    try {
        const url = new URL(raw);
        return url.origin;
    }
    catch {
        return DEFAULT_STELLA_WEB_URL;
    }
};
const storeWebOrigin = (value) => {
    try {
        return new URL(value).origin;
    }
    catch {
        return null;
    }
};
const initializeBootstrapLocalState = async (context) => {
    const { config, lifecycle, services, state } = context;
    const stellaDataDir = await resolveStellaDataDir(app, config.stellaAppDir, config.stellaDataDirPath);
    lifecycle.setStellaAppDir(stellaDataDir.stellaAppDir);
    lifecycle.setStellaDataDir(stellaDataDir.statePath);
    state.stellaAppDir = stellaDataDir.stellaAppDir;
    state.stellaDataDirPath = stellaDataDir.statePath;
    state.stellaWorkspacePath = stellaDataDir.workspacePath;
    services.backupService.start();
    services.securityPolicyService.setSecurityPolicyPath(path.join(stellaDataDir.statePath, "security_policy.json"));
};
const initializeWindowShell = (context) => {
    const { config, lifecycle, services, state } = context;
    const preloadPath = path.join(config.electronDir, "preload.js");
    const storeWebPreloadPath = path.join(config.electronDir, "store-web-preload.js");
    const storeWebBaseUrl = readStellaWebBaseUrl();
    const allowedStoreWebOrigin = storeWebOrigin(storeWebBaseUrl);
    configureStellaSessionPermissions({
        appPartition: config.sessionPartition,
        isDev: config.useDevServer,
        getDevServerUrl,
    });
    configureNotificationActivationHandling(context);
    state.overlayController = new OverlayWindowController({
        preloadPath,
        sessionPartition: config.sessionPartition,
        electronDir: config.electronDir,
        isDev: config.useDevServer,
        getDevServerUrl,
    });
    state.petController = new PetWindowController({
        preloadPath,
        sessionPartition: config.sessionPartition,
        electronDir: config.electronDir,
        isDev: config.useDevServer,
        getDevServerUrl,
    });
    lifecycle.setWindowManager(new WindowManager({
        electronDir: config.electronDir,
        preloadPath,
        storeWebPreloadPath,
        storeWebBaseUrl,
        isAllowedStoreWebUrl: (url) => Boolean(allowedStoreWebOrigin &&
            storeWebOrigin(url) === allowedStoreWebOrigin),
        sessionPartition: config.sessionPartition,
        isDev: config.useDevServer,
        getDevServerUrl,
        externalLinkService: services.externalLinkService,
        isQuitting: () => state.isQuitting,
        onMinimizeFullToTray: () => state.trayController?.notifyMinimizedToTray(),
    }));
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
        getBroadcastToMobile: () => getMobileBroadcast(context),
    });
};
const finalizeWindowLaunch = (context) => {
    const { config, services, state } = context;
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
    // The cold-boot deep-link OTT (`stella://auth/callback?ott=…`) sits in
    // `authService.pendingAuthCallback` waiting for the renderer to pull it via
    // `auth:consumePendingCallback`. We deliberately don't rebroadcast on
    // `did-finish-load` — that fires before React commits its first effects,
    // so the renderer-side `auth:callback` listener wasn't necessarily mounted.
    // The renderer pulls explicitly from `AuthDeepLinkHandler` once subscribed.
    if (fullWindow) {
        fullWindow.webContents.once("did-finish-load", () => {
            getMainLogger()?.process("startup.first-paint", {
                elapsedMs: Math.round(process.uptime() * 1000),
            });
            triggerDeferredStartup("first-paint");
        });
    }
    state.windowManager.showWindow();
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
