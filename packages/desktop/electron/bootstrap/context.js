import { BrowserWindow } from "electron";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { WindowManager } from "../windows/window-manager.js";
import { BootstrapLifecycleBindings } from "./lifecycle-bindings.js";
import { ProcessRuntime } from "../process-runtime.js";
import { createBootstrapServices } from "./bootstrap-services.js";
import { registerBootstrapProcessCleanups } from "./cleanup.js";
export const getAllWindows = (context) => {
    return context.state.windowManager
        ? context.state.windowManager.getAllWindows()
        : BrowserWindow.getAllWindows();
};
export const forEachWindow = (context, callback) => {
    for (const window of getAllWindows(context)) {
        if (!window.isDestroyed()) {
            callback(window);
        }
    }
};
export const broadcastToWindows = (context, channel, payload) => {
    forEachWindow(context, (window) => {
        window.webContents.send(channel, payload);
    });
};
export const broadcastLocalChatUpdated = (context, payload) => {
    broadcastToWindows(context, "localChat:updated", payload ?? null);
};
export const broadcastThreadActivityUpdated = (context, payload) => {
    broadcastToWindows(context, "localChat:threadActivityUpdated", payload);
};
export const broadcastScheduleUpdated = (context) => {
    broadcastToWindows(context, "schedule:updated");
};
export const broadcastStellaBrowserBridgeStatus = (context, status) => {
    broadcastToWindows(context, "browser:bridgeStatus", status);
};
export const createBootstrapContext = (config) => {
    const processRuntime = new ProcessRuntime();
    const state = {
        appReady: false,
        appSourceService: null,
        updateTransition: null,
        appSessionStartedAt: Date.now(),
        deferredStartupSequence: null,
        startHostRunner: null,
        deviceId: null,
        deviceIdentityPromise: null,
        deviceSignerPromise: null,
        isQuitting: false,
        localChatUpdateUnsubscribe: null,
        threadActivityUpdateUnsubscribe: null,
        overlayController: null,
        companionController: null,
        meetingCaptureController: null,
        processRuntime,
        scheduleUpdateUnsubscribe: null,
        globalInputHooksStarted: false,
        globalInputHooksStartScheduled: false,
        stellaAppDir: null,
        stellaDataDirPath: null,
        stellaWorkspacePath: null,
        stellaHostRunner: null,
        rendererSource: null,
        stellaBrowserBridgeService: null,
        inAppBrowserService: null,
        inAppBrowserCdpAdapter: null,
        inAppBrowserBootstrapServer: null,
        inAppBrowserHandlersDispose: null,
        officePreviewBridgeStop: null,
        deviceRequestHandlers: null,
        uiStateKvStore: null,
        windowManager: null,
        trayController: null,
    };
    const lifecycle = new BootstrapLifecycleBindings(state);
    const context = { config, lifecycle, state };
    context.services = createBootstrapServices({
        config,
        lifecycle,
        state,
        getAllWindows: () => getAllWindows(context),
    });
    registerBootstrapProcessCleanups(context);
    return context;
};
