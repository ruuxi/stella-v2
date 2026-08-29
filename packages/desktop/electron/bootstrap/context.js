import { BrowserWindow } from "electron";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { PetWindowController } from "../windows/pet-window.js";
import { WindowManager } from "../windows/window-manager.js";
import { BootstrapLifecycleBindings } from "./lifecycle-bindings.js";
import { ProcessRuntime } from "../process-runtime.js";
import { createBootstrapServices } from "./bootstrap-services.js";
import { registerBootstrapProcessCleanups } from "./cleanup.js";
/**
 * Retrieve the mobile bridge broadcast function from context.
 * Returns null if the bridge service hasn't started yet.
 */
export const getMobileBroadcast = (context) => {
    return context.state.mobileBridgeResource?.broadcastToMobile ?? null;
};
export const getAllWindows = (context) => {
    const windows = context.state.windowManager
        ? context.state.windowManager.getAllWindows()
        : BrowserWindow.getAllWindows();
    const petWindow = context.state.petController?.getWindow() ?? null;
    if (!petWindow || petWindow.isDestroyed() || windows.includes(petWindow)) {
        return windows;
    }
    return [...windows, petWindow];
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
const broadcastToWindowsAndMobile = (context, channel, payload, mobilePayload = payload ?? null) => {
    broadcastToWindows(context, channel, payload);
    getMobileBroadcast(context)?.(channel, mobilePayload);
};
export const broadcastLocalChatUpdated = (context, payload) => {
    broadcastToWindowsAndMobile(context, "localChat:updated", payload ?? null);
};
export const broadcastThreadActivityUpdated = (context, payload) => {
    broadcastToWindowsAndMobile(context, "localChat:threadActivityUpdated", payload);
};
export const broadcastScheduleUpdated = (context) => {
    broadcastToWindowsAndMobile(context, "schedule:updated");
};
export const broadcastUserAppsUpdated = (context) => {
    broadcastToWindows(context, "userApps:updated");
};
export const broadcastStellaBrowserBridgeStatus = (context, status) => {
    broadcastToWindows(context, "browser:bridgeStatus", status);
};
export const createBootstrapContext = (config) => {
    const processRuntime = new ProcessRuntime();
    const state = {
        appReady: false,
        appSessionStartedAt: Date.now(),
        deferredStartupSequence: null,
        startHostRunner: null,
        deviceId: null,
        isQuitting: false,
        localChatUpdateUnsubscribe: null,
        threadActivityUpdateUnsubscribe: null,
        overlayController: null,
        petController: null,
        petHandlersDispose: null,
        meetingCaptureController: null,
        processRuntime,
        scheduleUpdateUnsubscribe: null,
        userAppsUpdateUnsubscribe: null,
        globalInputHooksStarted: false,
        globalInputHooksStartScheduled: false,
        stellaAppDir: null,
        stellaDataDirPath: null,
        stellaWorkspacePath: null,
        stellaHostRunner: null,
        stellaBrowserBridgeService: null,
        inAppBrowserService: null,
        inAppBrowserCdpAdapter: null,
        inAppBrowserBootstrapServer: null,
        inAppBrowserHandlersDispose: null,
        mobileBridgeResource: null,
        officePreviewBridgeStop: null,
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
        getMobileBroadcast: () => getMobileBroadcast(context),
    });
    registerBootstrapProcessCleanups(context);
    return context;
};
