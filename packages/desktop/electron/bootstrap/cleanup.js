import { stopAllDesktopAutomationDaemons } from "../services/desktop-automation-cleanup.js";
import { stopOrphanedStellaBrowserDaemons } from "../services/stella-browser-bridge-service.js";
import { stopLocalParakeet } from "../dictation/local-parakeet.js";
import { stopNativeHelperDaemons } from "../native-helper-daemon.js";
import { stopOfficePreviewSessions } from "./office-preview-bridge.js";
export const registerBootstrapProcessCleanups = (context) => {
    const { processRuntime } = context.state;
    processRuntime.registerCleanup("before-quit", "auth-refresh-loop", () => {
        context.services.authService.stopAuthRefreshLoop();
    });
    processRuntime.registerCleanup("before-quit", "runtime-shells", () => {
        context.state.stellaHostRunner?.killAllShells();
    });
    processRuntime.registerCleanup("before-quit", "runtime-worker", async () => {
        await context.state.stellaHostRunner?.stop({ killWorker: false });
        context.state.stellaHostRunner = null;
    });
    processRuntime.registerCleanup("before-quit", "browser-bridge", async () => {
        await context.state.stellaBrowserBridgeService?.stop();
        await stopOrphanedStellaBrowserDaemons();
    });
    processRuntime.registerCleanup("before-quit", "in-app-browser", async () => {
        context.state.inAppBrowserHandlersDispose?.();
        context.state.inAppBrowserHandlersDispose = null;
        await context.state.inAppBrowserBootstrapServer?.stop();
        context.state.inAppBrowserBootstrapServer = null;
        await context.state.inAppBrowserCdpAdapter?.stop();
        context.state.inAppBrowserCdpAdapter = null;
        context.state.inAppBrowserService?.dispose();
        context.state.inAppBrowserService = null;
    });
    processRuntime.registerCleanup("before-quit", "overlay-window", () => {
        context.state.overlayController?.destroy();
    });
    processRuntime.registerCleanup("before-quit", "tray", () => {
        context.state.trayController?.destroy();
        context.state.trayController = null;
    });
    processRuntime.registerCleanup("before-quit", "pet-window", () => {
        context.state.petController?.destroy();
        context.state.petController = null;
    });
    processRuntime.registerCleanup("before-quit", "pet-handlers", () => {
        context.state.petHandlersDispose?.();
        context.state.petHandlersDispose = null;
    });
    processRuntime.registerCleanup("before-quit", "mobile-bridge", async () => {
        await context.state.mobileBridgeResource?.stop();
    });
    processRuntime.registerCleanup("before-quit", "office-preview-bridge", async () => {
        context.state.officePreviewBridgeStop?.();
        context.state.officePreviewBridgeStop = null;
        const stellaDataDir = context.state.stellaDataDirPath ?? context.config.stellaDataDirPath;
        await stopOfficePreviewSessions(stellaDataDir);
    });

    processRuntime.registerCleanup("before-quit", "meeting-capture-daemon", async () => {
        await context.state.meetingCaptureController?.shutdown();
        context.state.meetingCaptureController = null;
    });

    processRuntime.registerCleanup("before-quit", "desktop-automation-daemon", async () => {
        await stopAllDesktopAutomationDaemons();
    });
    processRuntime.registerCleanup("before-quit", "local-parakeet", () => {
        stopLocalParakeet();
    });

    processRuntime.registerCleanup("before-quit", "native-helper-daemons", () => {
        stopNativeHelperDaemons();
    });
    processRuntime.registerCleanup("before-quit", "global-input-hooks", () => {
        context.services.globalInputHook.stop();
        context.state.globalInputHooksStarted = false;
        context.state.globalInputHooksStartScheduled = false;
    });
};
