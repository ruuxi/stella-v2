import { stopAllDesktopAutomationDaemons } from "../services/desktop-automation-cleanup.js";
import { stopOrphanedStellaBrowserDaemons } from "../services/stella-browser-bridge-service.js";
import { stopNativeHelperDaemons } from "../native-helper-daemon.js";
import { stopOfficePreviewSessions } from "./office-preview-bridge.js";
import { joinWithTimeout } from "@stella/runtime/kernel/shared/join-timeout";
const RUNTIME_SHELLS_SHUTDOWN_TIMEOUT_MS = 4_000;
export const registerBootstrapProcessCleanups = (context) => {
    const { processRuntime } = context.state;
    // Agent shells live in the runtime worker, so they can only be reached
    // while the host is attached: the runtime cleanup joins this teardown
    // before it detaches. The worker bounds its own teardown at 3s; this bound
    // keeps a wedged worker from holding quit hostage.
    let runtimeShellTeardown = null;
    const startRuntimeShellTeardown = () => {
        const runner = context.state.stellaHostRunner;
        if (!runner) {
            return Promise.resolve();
        }
        if (runtimeShellTeardown?.runner !== runner) {
            runtimeShellTeardown = {
                runner,
                promise: joinWithTimeout(Promise.resolve()
                    .then(() => runner.killAllShells())
                    .catch((error) => {
                    console.warn("[cleanup] Runtime shell teardown failed:", error);
                }), RUNTIME_SHELLS_SHUTDOWN_TIMEOUT_MS, () => {
                    console.warn("[cleanup] Runtime shell teardown exceeded the quit bound; detaching the runtime anyway.");
                }),
            };
        }
        return runtimeShellTeardown.promise;
    };
    processRuntime.registerCleanup("before-quit", "auth-refresh-loop", () => {
        context.services.authService.stopAuthRefreshLoop();
    });
    processRuntime.registerCleanup("before-quit", "engine-account-access", () => {
        context.services.claudeLocalAccounts.dispose();
        context.services.engineAccountAccess.dispose();
    });
    // A memory edit made just before quit still reaches the cloud.
    processRuntime.registerCleanup("before-quit", "memory-sync", async () => {
        await context.services.memorySync.flush(3000);
        context.services.memorySync.dispose();
    });
    processRuntime.registerCleanup("before-quit", "remote-telemetry", async () => {
        await context.services.telemetry.record({
            type: "app.lifecycle",
            component: "desktop-main",
            phase: "stopping",
        });
        await context.services.telemetry.close({ timeoutMs: 3000 });
    });
    processRuntime.registerCleanup("before-quit", "runtime-worker", async () => {
        const runner = context.state.stellaHostRunner;
        if (!runner) {
            return;
        }
        await startRuntimeShellTeardown();
        await runner.stop({ killWorker: false });
        if (context.state.stellaHostRunner === runner) {
            context.state.stellaHostRunner = null;
        }
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
    processRuntime.registerCleanup("before-quit", "companion-window", () => {
        context.state.companionController?.destroy();
    });
    processRuntime.registerCleanup("before-quit", "tray", () => {
        context.state.trayController?.destroy();
        context.state.trayController = null;
    });
    processRuntime.registerCleanup("before-quit", "office-preview-bridge", async () => {
        context.state.officePreviewBridgeStop?.();
        context.state.officePreviewBridgeStop = null;
        const stellaDataDir = context.state.stellaDataDirPath ?? context.config.stellaDataDirPath;
        await stopOfficePreviewSessions(stellaDataDir);
    });
    // Meeting capture finalizes any in-flight recording (patches WAV headers,
    // writes session.json) before the daemon exits.
    processRuntime.registerCleanup("before-quit", "meeting-capture-daemon", async () => {
        await context.state.meetingCaptureController?.shutdown();
        context.state.meetingCaptureController = null;
    });
    // The desktop_automation daemon is a long-lived child process spawned
    // on demand by stella-computer. macOS doesn't reload an executable
    // under a live process, so without killing it on quit a rebuilt
    // binary would never be picked up until the user manually killed the
    // old one. Stopping here also clears the per-session pidfiles +
    // sockets so the next launch starts clean.
    processRuntime.registerCleanup("before-quit", "desktop-automation-daemon", async () => {
        await stopAllDesktopAutomationDaemons();
    });
    // Long-lived `--serve` helper daemons (window_info, recent_apps). Kill them
    // on quit so a rebuilt binary is picked up next launch and no orphan lingers.
    processRuntime.registerCleanup("before-quit", "native-helper-daemons", () => {
        stopNativeHelperDaemons();
    });
    processRuntime.registerCleanup("before-quit", "global-input-hooks", () => {
        context.services.globalInputHook.stop();
        context.state.globalInputHooksStarted = false;
        context.state.globalInputHooksStartScheduled = false;
    });
    // Registered last so it runs first. Teardown happens in the worker, so
    // starting it here overlaps it with every other cleanup instead of
    // leaving it to whatever remains of the quit budget.
    processRuntime.registerCleanup("before-quit", "runtime-shells", () => {
        void startRuntimeShellTeardown();
    });
};
