import { BrowserWindow, ipcMain, screen, shell, } from "electron";
import { hasMacPermission, requestMacPermission, } from "../utils/macos-permissions.js";
export const registerCaptureHandlers = (options) => {
    const requirePrivileged = (event, channel) => {
        if (!options.assertPrivilegedSender(event, channel)) {
            throw new Error("Blocked untrusted request.");
        }
    };
    const requirePrivilegedSender = (event, channel) => options.assertPrivilegedSender(event, channel);
    const ensureScreenCapturePermission = async () => {
        if (process.platform !== "darwin") {
            return true;
        }
        if (hasMacPermission("screen", false)) {
            return true;
        }
        const result = await requestMacPermission("screen");
        if (result.granted) {
            return true;
        }
        await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
        return false;
    };
    ipcMain.handle("chatContext:get", (event) => {
        requirePrivileged(event, "chatContext:get");
        return options.captureService.getChatContextSnapshot();
    });
    ipcMain.on("chatContext:set", (event, context) => {
        if (!requirePrivilegedSender(event, "chatContext:set"))
            return;
        options.captureService.setPendingChatContext(context ?? null);
        options.captureService.broadcastChatContext();
    });
    ipcMain.on("chatContext:removeScreenshot", (event, index) => {
        if (!requirePrivilegedSender(event, "chatContext:removeScreenshot"))
            return;
        options.captureService.removeScreenshot(index);
        options.captureService.broadcastChatContext();
    });
    ipcMain.on("region:select", (event, selection) => {
        if (!requirePrivilegedSender(event, "region:select"))
            return;
        void options.captureService.finalizeRegionCapture(selection);
    });
    ipcMain.on("region:commitPrepared", (event, result) => {
        if (!requirePrivilegedSender(event, "region:commitPrepared"))
            return;
        options.captureService.commitPreparedRegionCapture(result);
    });
    ipcMain.on("region:cancel", (event) => {
        if (!requirePrivilegedSender(event, "region:cancel"))
            return;
        options.captureService.cancelRegionCapture();
    });
    ipcMain.handle("region:prepareSelection", async (event, selection) => {
        requirePrivileged(event, "region:prepareSelection");
        if (!(await ensureScreenCapturePermission())) {
            return null;
        }
        return options.captureService.prepareRegionSelection(selection);
    });
    ipcMain.handle("region:getWindowCapture", async (event, point) => {
        requirePrivileged(event, "region:getWindowCapture");
        if (!(await ensureScreenCapturePermission())) {
            return null;
        }
        return options.captureService.getRegionWindowCapture(point);
    });
    ipcMain.on("region:click", async (event, point) => {
        if (!requirePrivilegedSender(event, "region:click"))
            return;
        await options.captureService.handleRegionClick(point);
    });
    ipcMain.handle("screenshot:capture", async (event, point) => {
        requirePrivileged(event, "screenshot:capture");
        if (!(await ensureScreenCapturePermission())) {
            return null;
        }
        return options.captureService.captureScreenshot(point);
    });
    ipcMain.handle("screenshot:captureVision", async (event, point) => {
        requirePrivileged(event, "screenshot:captureVision");
        if (!(await ensureScreenCapturePermission())) {
            return [];
        }
        return options.captureService.captureVisionScreenshots(point);
    });
    ipcMain.handle("capture:cursorDisplayInfo", (event) => {
        requirePrivileged(event, "capture:cursorDisplayInfo");
        const cursor = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursor);
        return {
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.bounds.width,
            height: display.bounds.height,
            scaleFactor: display.scaleFactor ?? 1,
        };
    });
    ipcMain.handle("capture:pageDataUrl", async (event) => {
        requirePrivileged(event, "capture:pageDataUrl");
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win)
            return null;
        const image = await win.webContents.capturePage();
        return image.toDataURL();
    });

    ipcMain.handle("capture:beginRegionCapture", async (event) => {
        requirePrivileged(event, "capture:beginRegionCapture");
        if (!(await ensureScreenCapturePermission())) {
            return { cancelled: true };
        }
        const wm = options.windowManager;
        const targetWindowWasVisible = wm.isWindowVisible();
        const targetWindowWasFocused = wm.isWindowFocused();
        wm.minimizeWindow();
        const result = await options.captureService.startRegionCapture();
        options.captureService.commitRegionCaptureResult(result);
        if (result !== null || targetWindowWasFocused) {
            wm.showWindow();
        }
        else if (targetWindowWasVisible) {
            wm.restoreWindowVisibility();
        }
        return result === null
            ? { cancelled: true }
            : { ok: true };
    });
};
